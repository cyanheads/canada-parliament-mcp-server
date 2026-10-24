/**
 * @fileoverview Real entry-point registration, source setup, stdio contracts, and EOF lifecycle.
 * @module tests/integration/parliament-server.test
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDomainParity,
  expectExact,
  parseMarkdown,
  trailerFields,
} from '../fixtures/bill-tools/harness.js';

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent: Record<string, unknown>;
}
interface ListedTool {
  annotations: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  name: string;
  outputSchema: Record<string, unknown>;
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const packageVersion = (
  JSON.parse(await readFile(`${root}package.json`, 'utf8')) as { version: string }
).version;

describe('actual parliament application over stdio', () => {
  let child: ChildProcessWithoutNullStreams;
  let scratch: string;
  let stderr = '';
  let id = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let exited: Promise<[number | null, NodeJS.Signals | null]>;

  function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const requestId = ++id;
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await request<ToolResult>('tools/call', { name, arguments: args });
    if (!result.isError) {
      const { appliedFilters, totalCount, shown, cap, truncated, notice, ...body } =
        result.structuredContent;
      assertDomainParity(body, [result.content[0]!]);
      expectExact(trailerFields(result.content.slice(1)).appliedFilters, appliedFilters);
      const trailer = parseMarkdown(
        result.content
          .slice(1)
          .map((block) => block.text ?? '')
          .join('\n'),
      ).text;
      if (totalCount !== undefined) {
        const fields = trailerFields(result.content.slice(1));
        if ('totalCount' in fields) expectExact(fields.totalCount, totalCount);
        else expect(trailer).toContain(`${String(totalCount)} total`);
      }
      for (const [key, value] of Object.entries({ shown, cap, truncated }))
        if (value !== undefined) expect(trailer).toContain(`${key}: ${String(value)}`);
      if (notice !== undefined) expect(trailer).toContain(String(notice));
    }
    return result;
  };
  const text = (result: ToolResult) =>
    parseMarkdown(result.content.map((block) => block.text ?? '').join('\n')).text;

  beforeAll(async () => {
    scratch = await mkdtemp('/tmp/canada-parliament-integration-tests-');
    child = spawn(
      'bun',
      ['--preload', `${root}tests/fixtures/integration/upstream-preload.ts`, `${root}src/index.ts`],
      {
        cwd: scratch,
        env: {
          PATH: process.env.PATH,
          HOME: scratch,
          XDG_CONFIG_HOME: scratch,
          XDG_DATA_HOME: scratch,
          MCP_TRANSPORT_TYPE: 'stdio',
          MCP_AUTH_MODE: 'none',
          MCP_LOG_LEVEL: 'error',
          LOGS_DIR: `${scratch}/logs`,
          STORAGE_PROVIDER_TYPE: 'in-memory',
          OTEL_ENABLED: 'false',
        },
        stdio: 'pipe',
      },
    );
    exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (message.id === undefined) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
      else waiter?.resolve(message.result);
    });
    child.on('exit', (code) => {
      for (const waiter of pending.values())
        waiter.reject(new Error(`Server exited ${code}: ${stderr}`));
      pending.clear();
      lines.close();
    });
  });

  afterAll(async () => {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('registers portable schemas and runs reference → search → dossier before clean EOF', async () => {
    const initialized = await request<{
      serverInfo: Record<string, unknown>;
      capabilities: Record<string, unknown>;
      instructions: string;
    }>('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'synthetic-integration-client', version: '1.0.0' },
      capabilities: {},
    });
    expect(initialized.serverInfo).toMatchObject({
      name: 'canada-parliament-mcp-server',
      title: 'canada-parliament-mcp-server',
      version: packageVersion,
    });
    expect(initialized.instructions).toContain('canparl_search_bills');
    expect(initialized.capabilities.tools).toBeDefined();
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    expect(await request('resources/list')).toEqual({ resources: [] });
    expect(await request('resources/templates/list')).toEqual({ resourceTemplates: [] });
    expect(await request('prompts/list')).toEqual({ prompts: [] });
    const listing = await request<{ tools: ListedTool[] }>('tools/list');
    expect(listing.tools.map((tool) => tool.name).sort()).toEqual([
      'canparl_get_bill',
      'canparl_get_member',
      'canparl_get_vote',
      'canparl_list_reference',
      'canparl_search_bills',
      'canparl_search_members',
      'canparl_search_speeches',
      'canparl_search_votes',
    ]);
    for (const tool of listing.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeTypeOf('object');
        expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
        const inspect = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            if (key === '$ref') {
              expect(item).toBeTypeOf('string');
              const segments = String(item).split('/');
              expect(segments.shift()).toBe('#');
              let target: unknown = schema;
              for (const segment of segments)
                target = (target as Record<string, unknown>)[
                  segment.replaceAll('~1', '/').replaceAll('~0', '~')
                ];
              expect(target).toBeDefined();
            } else inspect(item);
          }
        };
        inspect(schema);
      }
    }
    interface SchemaNode {
      $defs: Record<string, SchemaNode>;
      anyOf: SchemaNode[];
      items: SchemaNode;
      properties: Record<string, SchemaNode>;
    }
    const outputOf = (name: string) =>
      listing.tools.find((tool) => tool.name === name)!.outputSchema as unknown as SchemaNode;
    const billSchema = outputOf('canparl_get_bill');
    expect(billSchema.$defs.BillStage).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    for (const key of ['house', 'senate', 'royalAssent'])
      expect(billSchema.properties.stages!.properties[key]!.anyOf[0]!.items).toEqual({
        $ref: '#/$defs/BillStage',
      });
    expect(JSON.stringify(billSchema).match(/"Complete official stage;/g)).toHaveLength(1);
    for (const summary of [
      billSchema.properties.bill!,
      outputOf('canparl_search_bills').properties.bills!.items,
    ]) {
      expect(summary.properties.latestMajorStage!.anyOf[0]!.properties.chamber).toEqual({
        anyOf: [{ type: 'string', enum: ['House', 'Senate'] }, { type: 'null' }],
        description: expect.stringContaining('royal assent is reported as Senate'),
      });
      expect(summary.properties.royalAssentDate).toMatchObject({
        description: expect.stringContaining('UTC instant ending in Z'),
      });
    }
    const reference = await call('canparl_list_reference', { topic: 'sessions' });
    expect(reference.isError).not.toBe(true);
    expect(reference.structuredContent).toMatchObject({
      currentSession: '45-1',
      entries: [{ value: '45-1', coverage: { bills: 'full', houseDivisions: 'advertised' } }],
    });
    expect(text(reference)).toContain('houseDivisions: advertised');

    const search = await call('canparl_search_bills', { session: '45-1', limit: 1 });
    expect(search.isError).not.toBe(true);
    expect(search.structuredContent).toMatchObject({
      total: 2,
      bills: [{ session: '45-1', billCode: 'C-901' }],
      pagination: { nextOffset: 1 },
      truncated: true,
    });
    expect(text(search)).toContain('Synthetic marine act C-901');
    expect(text(search)).toContain('nextOffset: 1');
    const bills = search.structuredContent.bills as { session: string; billCode: string }[];
    const dossier = await call('canparl_get_bill', {
      session: bills[0]!.session,
      billCode: bills[0]!.billCode,
    });
    expect(dossier.isError).not.toBe(true);
    expect(dossier.structuredContent).toMatchObject({
      sponsor: { name: 'River Example', personId: '99001' },
      stages: {
        house: [
          {
            committee: { name: { en: 'Synthetic marine committee' } },
            sittings: [{ number: '3' }],
            decisions: [{ nested: { values: ['Synthetic decision', null, 7] } }],
          },
        ],
      },
    });
    for (const leaf of [
      'River Example',
      'Synthetic marine committee',
      'Synthetic third sitting',
      'Synthetic decision',
      '99001',
    ])
      expect(text(dossier)).toContain(leaf);

    for (const args of [{ titleContains: 'No such synthetic title' }, { offset: 99 }]) {
      const empty = await call('canparl_search_bills', { session: '45-1', ...args });
      expect(empty.isError).not.toBe(true);
      expect(empty.structuredContent.bills).toEqual([]);
      expect(text(empty)).toContain('bills: []');
      expect(text(empty)).toContain(String(empty.structuredContent.notice));
    }
    const missing = await call('canparl_get_bill', { session: '45-1', billCode: 'C-999' });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'bill_not_found',
          retryable: false,
          recovery: {
            hint: 'Call canparl_search_bills in the same session and copy a returned billCode.',
          },
        },
      },
    });
    expect(text(missing)).toContain('Call canparl_search_bills in the same session');
    const invalid = await call('canparl_search_bills', { limit: 0 });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(text(invalid)).toContain('limit');

    const requests = (await readFile(`${scratch}/requests.jsonl`, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { matched: boolean; url: string });
    expect(requests.every((entry) => entry.matched)).toBe(true);
    expect(requests).toHaveLength(6);
    child.stdin.end();
    expect(await exited).toEqual([0, null]);
  });
});
