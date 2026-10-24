/** @fileoverview Full-session division search contracts. @module tests/tools/search-votes.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VOTE_DOCUMENT_TYPES } from '@/domain/reference-catalog.js';
import { searchVotesTool } from '@/mcp-server/tools/definitions/search-votes.tool.js';
import { assertMeasuredResponse } from '../fixtures/bill-tools/harness.js';
import { assertFilterRejection, type FilterRejection } from '../fixtures/filter-rejection.js';
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
  it.each([1500, 15000])(
    'fits complete divisions with repeated %i-character subjects',
    async (size) => {
      const subject = 'é'.repeat(size);
      votes(
        http,
        Array.from({ length: 8 }, (_, i) => rawVote(i + 1, { DecisionDivisionSubject: subject })),
      );
      const ids: number[] = [];
      let offset: number | null = 0;
      let pages = 0;
      do {
        const result = await call({ session: '45-1', limit: 10_000, offset });
        const data = parity(result, searchVotesTool) as {
          divisions: { number: number; subject: string }[];
          pagination: { nextOffset: number | null };
        };
        const bytes = assertMeasuredResponse(result, searchVotesTool, data.divisions);
        expect(data.divisions.length).toBeGreaterThan(0);
        expect(result.structuredContent).toMatchObject({
          total: 8,
          cap: 100,
          notice: expect.stringContaining('maximum of 100'),
        });
        for (const row of data.divisions) expect(row.subject).toBe(subject);
        if (bytes > 24_000)
          expect(result.structuredContent).toMatchObject({
            shown: 1,
            notice: expect.stringContaining('exceeds'),
          });
        ids.push(...data.divisions.map((row) => row.number));
        offset = data.pagination.nextOffset;
        if (offset !== null) expect(offset).toBe(ids.length);
        expect(++pages).toBeLessThanOrEqual(8);
      } while (offset !== null);
      expect(pages).toBeGreaterThan(1);
      expect(ids).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    },
  );
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
  it('preserves the maximum cap while disclosing the response-budget stop', async () => {
    votes(
      http,
      Array.from({ length: 100 }, (_, i) => rawVote(i + 1)),
    );
    const result = await call({ session: '45-1', limit: 100 });
    parity(result, searchVotesTool);
    expect(result.structuredContent).toMatchObject({
      total: 100,
      shown: 31,
      cap: 100,
      truncated: true,
      pagination: { nextOffset: 31 },
      notice: expect.stringContaining('24000-byte response budget'),
    });
  });
  it.each([101, 10_000])(
    'clamps limit %i to the 100-row cap and continues from nextOffset',
    async (limit) => {
      votes(
        http,
        Array.from({ length: 150 }, (_, i) => rawVote(i + 1)),
      );
      const notice = `limit ${limit} exceeds the per-call maximum of 100; returned up to 100.`;
      const ids: number[] = [];
      let offset: number | null = 0;
      do {
        const result = await call({ session: '45-1', limit, offset });
        const data = parity(result, searchVotesTool) as {
          divisions: { number: number }[];
          pagination: { nextOffset: number | null };
        };
        expect(result.structuredContent).toMatchObject({
          total: 150,
          cap: 100,
          notice: expect.stringContaining(notice),
          pagination: { offset, limit: 100 },
        });
        expect(data.divisions.length).toBeGreaterThan(0);
        ids.push(...data.divisions.map((row) => row.number));
        offset = data.pagination.nextOffset;
        if (offset !== null) expect(offset).toBe(ids.length);
        expect(ids.length).toBeLessThanOrEqual(150);
      } while (offset !== null);
      expect(ids).toEqual(Array.from({ length: 150 }, (_, i) => 150 - i));
    },
  );
  const bill = 'Expected a House or Senate bill code such as C-15';
  const date = 'Expected a real calendar date written YYYY-MM-DD';
  it.each<[Record<string, string>, FilterRejection]>([
    [{ billCode: 'C-0' }, { field: 'billCode', rejected: 'C-0', shape: bill }],
    [{ billCode: 'C - 2' }, { field: 'billCode', rejected: 'C - 2', shape: bill }],
    [
      { result: 'Imaginary' },
      {
        field: 'result',
        rejected: 'Imaginary',
        allowed: ['Agreed To', 'Negatived', 'Tie', 'Historical result', 'Passed', 'Failed'],
      },
    ],
    [
      { documentType: 'Imaginary' },
      {
        field: 'documentType',
        rejected: 'Imaginary',
        allowed: [...VOTE_DOCUMENT_TYPES, 'Historical category'],
      },
    ],
    [{ dateFrom: '2026-02-30' }, { field: 'dateFrom', rejected: '2026-02-30', shape: date }],
    [
      { dateFrom: '2026-10-20', dateTo: '2026-10-19' },
      { field: 'dateFrom', rejected: '2026-10-2', shape: 'Expected a date no later than dateTo' },
    ],
    [{ dateTo: '2026-13-01' }, { field: 'dateTo', rejected: '2026-13-01', shape: date }],
    [
      { session: '35-2' },
      {
        field: 'session',
        rejected: '35-2',
        allowed: ['45-1', '38-1', '46-2'],
        shape: 'Expected a session in the official House division session index',
      },
    ],
  ])('returns declared reason and recovery for %j', async (input, expected) => {
    votes(http, rows);
    const reason =
      'session' in input
        ? 'unsupported_vote_session'
        : 'dateFrom' in input || 'dateTo' in input
          ? 'invalid_date_range'
          : 'invalid_vote_filter';
    const result = await call({ session: '45-1', ...input });
    failure(result, searchVotesTool.errors!.find((error) => error.reason === reason)!);
    assertFilterRejection(result, expected);
  });
  it.each(['45-0', '9007199254740992-1'])(
    'rejects malformed session %j as unsupported_vote_session before HTTP',
    async (session) => {
      const result = await call({ session });
      failure(
        result,
        searchVotesTool.errors!.find((error) => error.reason === 'unsupported_vote_session')!,
      );
      assertFilterRejection(result, {
        field: 'session',
        rejected: session,
        shape: 'Expected a parliament-session token such as 45-1',
      });
      expect(http.calls).toHaveLength(0);
    },
  );
  it('accepts a separated bill code as its canonical filter', async () => {
    votes(http, rows);
    const data = parity(await call({ session: '45-1', billCode: 'S‑321' }), searchVotesTool);
    expect(data).toMatchObject({ total: 3, appliedFilters: { billCode: 'S-321' } });
  });
  it('filters a split-bill division by its suffixed code', async () => {
    votes(http, [...rows, rawVote(11, { BillNumberCode: 'C-15A' })]);
    const data = parity(await call({ session: '45-1', billCode: 'c 15a' }), searchVotesTool);
    expect(data).toMatchObject({
      total: 1,
      divisions: [{ number: 11, billCode: 'C-15A' }],
      appliedFilters: { billCode: 'C-15A' },
    });
  });
  it.each([
    { limit: 0 },
    { limit: 10_001 },
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
