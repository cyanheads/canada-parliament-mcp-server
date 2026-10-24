/** @fileoverview Official refusal contracts through real services and tool envelopes. @module tests/tools/official-source-errors.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBillTool } from '@/mcp-server/tools/definitions/get-bill.tool.js';
import { getMemberTool } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { getVoteTool } from '@/mcp-server/tools/definitions/get-vote.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchBillsTool } from '@/mcp-server/tools/definitions/search-bills.tool.js';
import { searchMembersTool } from '@/mcp-server/tools/definitions/search-members.tool.js';
import { searchSpeechesTool } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { searchVotesTool } from '@/mcp-server/tools/definitions/search-votes.tool.js';
import { disposeOurCommonsService, initOurCommonsService } from '@/services/ourcommons/index.js';
import {
  assertDomainParity,
  assertError,
  expectExact,
  settle,
  setup,
  teardown,
  trailerFields,
} from '../fixtures/bill-tools/harness.js';

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
