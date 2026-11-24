/** @fileoverview Official refusal contracts through real services and tool envelopes. @module tests/tools/official-source-errors.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBillTool } from '@/mcp-server/tools/definitions/get-bill.tool.js';
import { getBillTextTool } from '@/mcp-server/tools/definitions/get-bill-text.tool.js';
import { getMemberTool } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { getVoteTool } from '@/mcp-server/tools/definitions/get-vote.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchBillsTool } from '@/mcp-server/tools/definitions/search-bills.tool.js';
import { searchMembersTool } from '@/mcp-server/tools/definitions/search-members.tool.js';
import { searchSpeechesTool } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { searchVotesTool } from '@/mcp-server/tools/definitions/search-votes.tool.js';
import { disposeOurCommonsService, initOurCommonsService } from '@/services/ourcommons/index.js';
import {
  billTextFixture,
  capturedRedirects,
  capturedXml,
} from '../fixtures/bill-tools/bill-text.js';
import {
  assertDomainParity,
  assertError,
  detail,
  expectExact,
  picker,
  rawBill,
  sessions,
  settle,
  setup,
  teardown,
  trailerFields,
} from '../fixtures/bill-tools/harness.js';
import { parliamentRosterUrl, realRoster, rosterPicker } from '../fixtures/member-tools/harness.js';

/** The DocumentViewer request for 45-1 S-2 at first reading. */
const viewerUrl = 'https://www.parl.ca/DocumentViewer/en/13542656';

describe('official source refusal envelopes', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
    initOurCommonsService({ userAgent: 'synthetic-refusal-tests' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    disposeOurCommonsService();
    teardown(http);
  });
  const cases = [
    {
      definition: getBillTool,
      source: 'legisinfo',
      call: () => runToolContract(getBillTool, { session: '45-1', billCode: 'C-901' }),
    },
    {
      definition: getBillTextTool,
      source: 'legisinfo',
      call: () => runToolContract(getBillTextTool, { session: '45-1', billCode: 'C-901' }),
    },
    {
      definition: searchBillsTool,
      source: 'legisinfo',
      call: () => runToolContract(searchBillsTool, { session: '45-1' }),
    },
    {
      definition: listReferenceTool,
      source: 'legisinfo',
      call: () => runToolContract(listReferenceTool, { topic: 'sessions' }),
    },
    {
      definition: getVoteTool,
      source: 'ourcommons',
      call: () => runToolContract(getVoteTool, { session: '45-1', number: 901 }),
    },
    {
      definition: searchVotesTool,
      source: 'ourcommons',
      call: () => runToolContract(searchVotesTool, { session: '45-1' }),
    },
    {
      definition: searchMembersTool,
      source: 'ourcommons',
      call: () => runToolContract(searchMembersTool, {}),
    },
    {
      definition: getMemberTool,
      source: 'ourcommons',
      call: () => runToolContract(getMemberTool, { personId: '1787' }),
    },
    {
      definition: searchSpeechesTool,
      source: 'ourcommons',
      call: () => runToolContract(searchSpeechesTool, { politician: '1787' }),
    },
  ];
  it.each(cases)(
    'declares and renders a body-free refusal for $definition.name',
    async ({ definition, source, call }) => {
      const failures = vi.spyOn(logger, 'error');
      http.route({
        match: () => true,
        respond: new Response('<html>refusal-private-marker</html>', { status: 403 }),
      });
      const result = await settle(call());
      const label = source === 'legisinfo' ? 'LEGISinfo' : 'OurCommons';
      const hint = `Retry ${label} later for official parliamentary data.`;
      expect(definition.errors).toContainEqual({
        reason: 'upstream_blocked',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'An official parliamentary source refuses the request with HTTP 403.',
        recovery: 'Retry the affected official source later for parliamentary data.',
        retryable: false,
        thrownBy: 'service',
      });
      assertError(result, 'upstream_blocked', JsonRpcErrorCode.ServiceUnavailable, hint);
      expect(result.structuredContent).toMatchObject({
        error: {
          message: `${label} refused the official data request.`,
          data: { source, status: 403 },
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('refusal-private-marker');
      expect(serialized).not.toContain('"body"');
      expect(serialized).not.toContain('"responseBody"');
      expect(
        result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      ).toContain('upstream_blocked');
      expect(http.calls).toHaveLength(1);
      expect(new URL(http.calls[0]!.request.url).hostname).toBe(
        source === 'legisinfo' ? 'www.parl.ca' : 'www.ourcommons.ca',
      );
      const httpFailure = failures.mock.calls.find(([message]) =>
        message.startsWith('Fetch failed for '),
      );
      expect(httpFailure).toBeDefined();
      expect(JSON.stringify(httpFailure)).not.toContain('refusal-private-marker');
      expect(JSON.stringify(httpFailure)).not.toContain('<html>');
    },
  );
  it.each([
    {
      name: 'the roster picker',
      definition: searchMembersTool,
      call: () => runToolContract(searchMembersTool, { parliament: 41 }),
      served: [],
      refused: rosterPicker,
    },
    {
      name: 'a Parliament roster',
      definition: searchMembersTool,
      call: () => runToolContract(searchMembersTool, { parliament: 41 }),
      served: [[rosterPicker, 'picker']] as const,
      refused: parliamentRosterUrl(41),
    },
    {
      name: 'the all-Parliaments roster',
      definition: getMemberTool,
      call: () => runToolContract(getMemberTool, { personId: '1463' }),
      served: [['https://www.ourcommons.ca/Members/en/search/xml', 'current']] as const,
      refused: parliamentRosterUrl('*'),
    },
    {
      name: 'the postal-code lookup',
      definition: searchMembersTool,
      call: () => runToolContract(searchMembersTool, { postalCode: 'K1A 0A6' }),
      served: [],
      refused: 'https://www.ourcommons.ca/Members/en/search/xml?q=K1A0A6',
    },
  ])(
    'fails a 403 from $name as upstream_blocked without retry',
    async ({ definition, call, served, refused }) => {
      for (const [url, body] of served)
        http.route({ match: url, respond: () => new Response(realRoster(body)) });
      http.route({
        match: refused,
        respond: new Response('<html>refusal-private-marker</html>', { status: 403 }),
      });
      const result = await settle(call());
      expect(definition.errors).toContainEqual(
        expect.objectContaining({ reason: 'upstream_blocked', thrownBy: 'service' }),
      );
      assertError(
        result,
        'upstream_blocked',
        JsonRpcErrorCode.ServiceUnavailable,
        'Retry OurCommons later for official parliamentary data.',
      );
      expect(JSON.stringify(result)).not.toContain('refusal-private-marker');
      expect(http.calls.map((entry) => entry.request.url)).toEqual([
        ...served.map(([url]) => url),
        refused,
      ]);
    },
  );
  it.each([
    { name: 'a DocumentViewer page', viewerServed: false, refused: viewerUrl },
    { name: 'a bill XML export', viewerServed: true, refused: capturedXml.s2En },
  ])(
    'fails a 403 from $name in canparl_get_bill_text as upstream_blocked without retry',
    async ({ viewerServed, refused }) => {
      sessions(http);
      http.route({
        match: detail('S-2'),
        respond: Response.json([
          rawBill('S-2', {
            Publications: [
              {
                PublicationId: 13542656,
                PublicationTypeId: 80701,
                PublicationTypeNameEn: 'First Reading',
                PublicationTypeNameFr: 'Première lecture',
              },
            ],
          }),
        ]),
      });
      const page = `https://www.parl.ca${capturedRedirects.s2FirstReading}`;
      if (viewerServed)
        http.route(
          {
            match: viewerUrl,
            respond: new Response(null, {
              status: 302,
              headers: { location: capturedRedirects.s2FirstReading },
            }),
          },
          { match: page, respond: new Response(billTextFixture('viewer-S-2-first-reading.html')) },
        );
      http.route({
        match: refused,
        respond: new Response('<html>refusal-private-marker</html>', { status: 403 }),
      });
      const result = await settle(
        runToolContract(getBillTextTool, { session: '45-1', billCode: 'S-2' }),
      );
      assertError(
        result,
        'upstream_blocked',
        JsonRpcErrorCode.ServiceUnavailable,
        'Retry LEGISinfo later for official parliamentary data.',
      );
      expect(result.structuredContent).toMatchObject({
        error: {
          message: 'LEGISinfo refused the official data request.',
          data: { source: 'legisinfo', status: 403 },
        },
      });
      expect(JSON.stringify(result)).not.toContain('refusal-private-marker');
      expect(http.calls.map((entry) => entry.request.url)).toEqual([
        picker,
        detail('S-2'),
        ...(viewerServed ? [viewerUrl, page] : []),
        refused,
      ]);
    },
  );
  it('preserves optional currentness unavailability when a slug profile succeeds', async () => {
    http.route(
      {
        match: 'https://api.openparliament.ca/politicians/judy-sgro/',
        respond: Response.json({
          url: '/politicians/judy-sgro/',
          name: 'Judy Sgro',
          memberships: [],
          other_info: { parl_mp_id: ['1787'] },
        }),
      },
      {
        match: 'https://www.ourcommons.ca/Members/en/search/xml',
        respond: new Response('<html>refusal-private-marker</html>', { status: 403 }),
      },
    );
    const result = await settle(
      runToolContract(getMemberTool, { slug: 'judy-sgro', sponsoredBills: 0, recentVotes: 0 }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      unavailable: [
        {
          section: 'currentness',
          failure: {
            code: 'ServiceUnavailable',
            reason: 'enrichment_unavailable',
            retryable: false,
          },
        },
      ],
    });
    const body = getMemberTool.output.parse(result.structuredContent);
    assertDomainParity(body, [result.content[0]!]);
    assertDomainParity(body, getMemberTool.format!(body));
    expectExact(
      trailerFields(result.content.slice(1)).unavailable,
      (result.structuredContent as { unavailable: unknown }).unavailable,
    );
    expect(JSON.stringify(result)).not.toContain('refusal-private-marker');
    expect(http.calls).toHaveLength(2);
  });
});

describe('declared failure log level', () => {
  const definitions = [
    getBillTool,
    getBillTextTool,
    getMemberTool,
    getVoteTool,
    listReferenceTool,
    searchBillsTool,
    searchMembersTool,
    searchSpeechesTool,
    searchVotesTool,
  ];
  /** Caller input and ordinary lookup misses are modeled outcomes; upstream failures stay errors. */
  const callerOutcomes = new Set<number>([
    JsonRpcErrorCode.ValidationError,
    JsonRpcErrorCode.NotFound,
  ]);
  it('logs caller-input and not-found reasons at notice and every upstream failure at error', () => {
    const entries = definitions.flatMap((definition) =>
      (definition.errors ?? []).map((entry) => ({
        tool: definition.name,
        reason: entry.reason,
        code: entry.code,
        severity: 'severity' in entry ? entry.severity : undefined,
      })),
    );
    for (const { tool, reason, code, severity } of entries)
      expect(severity, `${tool} ${reason}`).toBe(callerOutcomes.has(code) ? 'notice' : undefined);
    expect(entries.filter((entry) => entry.severity === 'notice')).toHaveLength(27);
    expect(entries.filter((entry) => entry.severity === undefined)).toHaveLength(14);
  });
});
