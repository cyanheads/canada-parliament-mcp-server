/**
 * @fileoverview Network fixtures and CommonMark oracle for bill tool contracts.
 * @module tests/fixtures/bill-tools/harness
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { expect, vi } from 'vitest';
import type { JsonRecord } from '@/domain/schemas.js';
import { RESPONSE_BUDGET, responseBytes } from '@/mcp-server/tools/definitions/_format.js';
import { disposeLegisinfoService, initLegisinfoService } from '@/services/legisinfo/index.js';
import {
  disposeOpenParliamentService,
  initOpenParliamentService,
} from '@/services/openparliament/index.js';
import { decodeBun, decodeBunFields, expectExact } from '../markdown-decode.js';

export { expectExact } from '../markdown-decode.js';

export const picker = 'https://www.parl.ca/legisinfo/en/bills';
export const current = `${picker}/json`;
export const listing = (session = '45-1') => `${current}?parlsession=${session}`;
export const detail = (code = 'C-901', session = '45-1') =>
  `https://www.parl.ca/legisinfo/en/bill/${session}/${code.toLowerCase()}/json`;
export const rawBill = (code = 'C-901', extra: Record<string, unknown> = {}) => ({
  ParliamentNumber: 45,
  SessionNumber: 1,
  NumberCode: code,
  IsSessionOngoing: true,
  LongTitleEn: 'Synthetic marine act',
  LongTitleFr: 'Loi synthétique sur la mer',
  ShortTitleEn: 'Marine Act',
  ShortTitleFr: 'Loi marine',
  BillDocumentTypeNameEn: 'Government Bill',
  OriginatingChamberNameEn: 'House of Commons',
  StatusNameEn: 'At second reading in the House of Commons',
  LatestCompletedMajorStageNameEn: 'First reading',
  LatestCompletedMajorStageChamberNameEn: 'House of Commons',
  LatestCompletedMajorStageChamberOrganizationId: 1,
  ReceivedRoyalAssentDateTime: null,
  ...extra,
});
/**
 * Captured LEGISinfo dossier response bodies (2026-10-21). Values are verbatim; the 35-1 record is
 * whole, the others keep their identity, sponsor, statute, and reading fields plus the fields their
 * tests exercise (notes, summaries, web references, publications).
 */
export const realDossier = (
  name: '35-1-c-1' | '41-1-c-38' | '42-1-c-86' | '44-1-c-69' | '45-1-c-15',
): string => readFileSync(new URL(`./dossiers/${name}.json`, import.meta.url), 'utf8');

/** Fresh real service accessors with only the HTTP boundary replaced. */
export function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  const unexpected: string[] = [];
  const http = createFetchMock([], {
    onUnhandled: (request) => {
      unexpected.push(request.url);
      throw new Error(`Unexpected HTTP: ${request.url}`);
    },
  });
  http.install();
  initLegisinfoService({ userAgent: 'synthetic-bill-contract-tests' });
  initOpenParliamentService({ userAgent: 'synthetic-bill-contract-tests' });
  return Object.assign(http, { unexpected });
}
/** Release all service queues and restore the process boundary. */
export function teardown(http: ReturnType<typeof setup>) {
  disposeLegisinfoService();
  disposeOpenParliamentService();
  http.restore();
  vi.useRealTimers();
  expect(http.unexpected).toEqual([]);
}
/** Drive pacing without a real wait or swallowing early failures. */
export async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(25_000);
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}
/** Declare the discovered source sessions, never infer them arithmetically. */
export function sessions(http: ReturnType<typeof createFetchMock>, values = ['45-1', '35-2']) {
  http.route({
    match: picker,
    respond: new Response(
      values
        .map((value) => `<a data-input="parlsession" data-value="${value}">Synthetic session</a>`)
        .join(''),
    ),
  });
}

interface Parsed {
  images: unknown[];
  links: { text: string; href: string }[];
  text: string;
}
/** Actual CommonMark text callbacks and DOM destinations, not string matching Markdown. */
export function parseMarkdown(markdown: string): Parsed {
  return JSON.parse(
    execFileSync(
      'bun',
      [
        '-e',
        `
const markdown = await Bun.stdin.text();
const result = { text: '', links: [], images: [] };
Bun.markdown.render(markdown, { text(value) { result.text += value; return value; } });
const { parseHTML } = await import('linkedom');
const { document } = parseHTML(Bun.markdown.html(markdown));
result.links = [...document.querySelectorAll('a')].map(a => ({text:a.textContent,href:a.getAttribute('href')}));
result.images = [...document.querySelectorAll('img')].map(img => ({text:img.getAttribute('alt'),src:img.getAttribute('src')}));
console.log(JSON.stringify(result));`,
      ],
      { input: markdown, encoding: 'utf8' },
    ),
  ) as Parsed;
}
const textOf = (blocks: readonly { type: string; text?: string }[]) =>
  blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
/** Structurally decode a whole domain body: keys, order, nesting, scalar types, and links. */
export function assertDomainParity(
  value: unknown,
  blocks: readonly { type: string; text?: string }[],
) {
  const markdown = textOf(blocks);
  const decoded = decodeBun(markdown);
  expectExact(decoded.value, value);
  const urls: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' && node.startsWith('https://')) urls.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
  expect(decoded.links).toEqual(urls.map((url) => ({ text: url, href: url })));
  expect(decoded.images).toEqual([]);
  expect(markdown).not.toContain('```');
}
/** Decode the enrichment trailer's rendered fields, skipping the framework's own lines. */
export function trailerFields(blocks: readonly { type: string; text?: string }[]): JsonRecord {
  return decodeBunFields(textOf(blocks));
}
/** UTF-8 bytes of the JSON-RPC response carrying `result`, with a 256-byte request id. */
export function wireBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(256), result }), 'utf8');
}
/**
 * A budgeted tool's complete response: every declared enrichment field decodes exactly, in order,
 * from its trailer; the shared measure equals the wire; and two or more records fit the budget.
 */
export function assertMeasuredResponse(
  result: { structuredContent?: unknown; content: readonly { type: string; text?: string }[] },
  definition: { enrichment?: Record<string, unknown>; output: { parse(value: unknown): unknown } },
  records?: readonly unknown[],
): number {
  const data = result.structuredContent as JsonRecord;
  const enrichment: JsonRecord = {};
  for (const key of Object.keys(definition.enrichment ?? {}))
    if (key in data) enrichment[key] = data[key] as JsonRecord[string];
  expectExact(trailerFields(result.content.slice(1)), enrichment);
  const wire = wireBytes(result);
  expect(responseBytes(definition.output.parse(data), enrichment)).toBe(wire);
  if (records && records.length > 1) expect(wire).toBeLessThanOrEqual(RESPONSE_BUDGET);
  return wire;
}

/** Both envelopes contain the declared error and actionable recovery. */
export function assertError(
  result: {
    isError?: boolean | undefined;
    structuredContent?: unknown;
    content: readonly { type: string; text?: string }[];
  },
  reason: string,
  code: number,
  hint: string,
) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code, data: { reason, retryable: false, recovery: { hint } } },
  });
  expect(
    result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
  ).toContain(hint);
}
