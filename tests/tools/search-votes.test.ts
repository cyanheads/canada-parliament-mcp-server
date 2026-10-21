/** @fileoverview Full-session division search contracts. @module tests/tools/search-votes.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchVotesTool } from '@/mcp-server/tools/definitions/search-votes.tool.js';
import {
  current,
  failure,
  parity,
  rawBill,
  rawVote,
  settle,
  setup,
  teardown,
  votes,
} from '../fixtures/vote-tools/harness.js';

describe('canparl_search_votes production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
  });
  afterEach(() => teardown(http));
  const call = (input: Record<string, unknown> = {}) =>
    settle(runToolContract(searchVotesTool, input));
  const rows = [
    rawVote(2),
    rawVote(10),
    rawVote(3, { DecisionEventDateTime: '2026-10-20T00:01:00', DecisionResultName: 'Negatived' }),
    rawVote(4, {
      DecisionEventDateTime: null,
      DecisionResultName: 'Historical result',
      DecisionDivisionDocumentTypeName: 'Historical category',
      BillNumberCode: null,
    }),
  ];
  it('resolves current source identity and sorts complete results before slicing', async () => {
    http.route({ match: current, respond: Response.json([rawBill()]) });
    votes(http, rows);
    const result = await call({ limit: 2 });
    parity(result, searchVotesTool);
    expect(result.structuredContent).toMatchObject({
      session: '45-1',
      total: 4,
      divisions: [{ number: 3 }, { number: 10 }],
      totalCount: 4,
      shown: 2,
      cap: 2,
      truncated: true,
      pagination: { offset: 0, limit: 2, hasMore: true, nextOffset: 2 },
    });
  });
  it('intersects canonical aliases and inclusive Ottawa dates with literal Unicode subjects', async () => {
    votes(http, rows);
    const result = await call({
      session: { parliament: 45, session: 1 },
      billCode: ' bill s321 ',
      result: ' PASSED ',
      documentType: ' legislative   process ',
      dateFrom: '2026-10-19',
      dateTo: '2026-10-19',
      query: 'e\u0301cole [x].*',
      offset: 1,
      limit: 1,
    });
    parity(result, searchVotesTool);
    expect(result.structuredContent).toMatchObject({
      total: 2,
      divisions: [{ number: 2 }],
      appliedFilters: {
        session: '45-1',
        billCode: 'S-321',
        result: 'Agreed To',
        documentType: 'Legislative Process',
        dateFrom: '2026-10-19',
        dateTo: '2026-10-19',
        subjectContains: 'e\u0301cole [x].*',
      },
      pagination: { hasMore: false, nextOffset: null },
    });
  });
  it.each([
    [{ result: 'Failed' }, [3]],
    [{ dateFrom: '2026-10-20' }, [3]],
    [{ dateTo: '2026-10-19' }, [10, 2]],
    [{ result: 'Tie' }, []],
    [{ result: 'Historical result', documentType: 'Historical category' }, [4]],
    [{ subjectContains: 'absent' }, []],
    [{ limit: 4 }, [3, 10, 2, 4]],
    [{ limit: 100 }, [3, 10, 2, 4]],
    [{ offset: 4 }, []],
    [{ offset: 10 }, []],
    [{ result: '', dateFrom: ' ', billCode: '' }, [3, 10, 2, 4]],
  ])('returns exact bounded results for %j', async (filters, numbers) => {
    votes(http, rows);
    const result = await call({ session: '045-01', ...filters });
    const data = parity(result, searchVotesTool);
    expect((data.divisions as { number: number }[]).map((row) => row.number)).toEqual(numbers);
    if ('offset' in filters)
      expect(data).toMatchObject({ total: 4, notice: expect.stringContaining('offset 0') });
    if (!numbers.length && !('offset' in filters))
      expect(data).toMatchObject({
        total: 0,
        notice: expect.stringContaining('No divisions matched'),
      });
  });
  it('accepts advertised historical empty feeds and recognized labels without consulting current', async () => {
    votes(http, [], '38-1');
    const result = await call({ session: '038-01', result: 'Tie', documentType: 'Supply' });
    parity(result, searchVotesTool);
    expect(result.structuredContent).toMatchObject({
      session: '38-1',
      total: 0,
      divisions: [],
      pagination: { hasMore: false, nextOffset: null },
    });
    expect(http.calls.some((call) => call.request.url === current)).toBe(false);
  });
  it('returns every row at the maximum cap', async () => {
    votes(
      http,
      Array.from({ length: 100 }, (_, i) => rawVote(i + 1)),
    );
    const result = await call({ session: '45-1', limit: 100 });
    parity(result, searchVotesTool);
    expect(result.structuredContent).toMatchObject({ total: 100, shown: 100, truncated: false });
  });
  it.each([
    { billCode: 'C-0' },
    { result: 'Imaginary' },
    { documentType: 'Imaginary' },
    { dateFrom: '2026-02-30' },
    { dateFrom: '2026-10-20', dateTo: '2026-10-19' },
    { dateTo: '2026-13-01' },
    { session: '35-2' },
  ])('returns declared reason and recovery for %j', async (input) => {
    votes(http, rows);
    const reason =
      'session' in input
        ? 'unsupported_vote_session'
        : 'dateFrom' in input || 'dateTo' in input
          ? 'invalid_date_range'
          : 'invalid_vote_filter';
    failure(
      await call({ session: '45-1', ...input }),
      searchVotesTool.errors!.find((error) => error.reason === reason)!,
    );
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { session: { parliament: 0, session: 1 } },
  ])('rejects invalid schema input before HTTP %j', async (input) => {
    const result = await call(input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });
});
