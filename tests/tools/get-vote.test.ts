/** @fileoverview Joined division and full-ballot aggregation contracts. @module tests/tools/get-vote.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVINCES } from '@/domain/normalization.js';
import { PARTIES } from '@/domain/reference-catalog.js';
import type { JsonRecord } from '@/domain/schemas.js';
import { RESPONSE_BUDGET, responseBytes } from '@/mcp-server/tools/definitions/_format.js';
import { getVoteTool } from '@/mcp-server/tools/definitions/get-vote.tool.js';
import { assertFilterRejection, type FilterRejection } from '../fixtures/filter-rejection.js';
import {
  ballotParity,
  ballots,
  current,
  detailUrl,
  failure,
  rawBill,
  rawPerson,
  rawVote,
  rosterUrl,
  settle,
  setup,
  teardown,
  votes,
} from '../fixtures/vote-tools/harness.js';

const NONVOTERS =
  'Nonvoters are not listed; paired ballots are recorded participants, not inferred pairs.';
const budgetNotice = (shown: number) =>
  `The 24000-byte response budget ended this page after ${shown} ${shown === 1 ? 'ballot' : 'ballots'}; call canparl_get_vote with nextOffset and identical filters to continue.`;

describe('canparl_get_vote production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
  });
  afterEach(() => teardown(http));
  const call = (input: Record<string, unknown> = {}) =>
    settle(runToolContract(getVoteTool, { number: 901, session: '45-1', ...input }));
  const ids = (data: Record<string, unknown>) =>
    (data.ballots as { personId: string }[]).map((row) => row.personId);
  /** Follow nextOffset with identical filters until the last page, checking each continuation. */
  async function walk(input: Record<string, unknown>) {
    const pages: Record<string, unknown>[] = [];
    let offset = 0;
    for (;;) {
      const data = ballotParity(await call({ ...input, offset }), getVoteTool);
      pages.push(data);
      const next = (data.pagination as { nextOffset: number | null }).nextOffset;
      if (next === null) return pages;
      expect(next).toBe(offset + ids(data).length);
      offset = next;
    }
  }
  const people = [
    rawPerson(4, { CaucusShortName: 'Historical caucus', VoteValueName: 'Paired' }),
    rawPerson(3, {
      CaucusShortName: null,
      VoteValueName: 'Nay',
      ConstituencyName: null,
      ConstituencyProvinceTerritoryName: null,
    }),
    rawPerson(2, {
      CaucusShortName: 'Bloc Québécois',
      PersonOfficialLastName: 'Zulu',
      ConstituencyProvinceTerritoryName: 'Quebec',
    }),
    rawPerson(1, {
      CaucusShortName: 'Bloc Québécois',
      PersonOfficialLastName: 'Alpha',
      ConstituencyProvinceTerritoryName: 'Quebec',
    }),
  ];
  function feed() {
    votes(http);
    ballots(http, people);
  }
  it('joins all official metadata and preserves full tallies independently of intersection and page', async () => {
    feed();
    const result = await call({ party: 'Bloc', province: 'qc', limit: 1, offset: 1 });
    const data = ballotParity(result, getVoteTool);
    expect(data).toMatchObject({
      division: { session: '45-1', number: 901, billCode: 'S-321', yeas: 2, nays: 1, paired: 1 },
      tally: { yea: 2, nay: 1, paired: 1 },
      ballotsTotal: 4,
      ballotsMatched: 2,
      ballots: [
        {
          personId: '2',
          name: 'River Zulu',
          party: 'Bloc Québécois',
          province: 'Quebec',
          ballot: 'Yea',
        },
      ],
      byParty: [
        { party: null, yea: 0, nay: 1, paired: 0, total: 1 },
        { party: 'Bloc Québécois', yea: 2, nay: 0, paired: 0, total: 2 },
        { party: 'Historical caucus', yea: 0, nay: 0, paired: 1, total: 1 },
      ],
      tallyMatchesBallots: true,
      appliedFilters: {
        session: '45-1',
        number: 901,
        party: 'Bloc Québécois',
        province: 'Quebec',
        ballot: null,
        personId: null,
      },
      shown: 1,
      cap: 1,
      totalCount: 2,
      truncated: false,
    });
  });
  it.each([
    [{ limit: 4 }, ['3', '1', '2', '4']],
    [{ limit: 2 }, ['3', '1']],
    [{ offset: 4 }, []],
    [{ offset: 10 }, []],
    [{ party: 'Historical CAUCUS' }, ['4']],
    [{ party: 'Green' }, []],
    [{ party: 'Bloc', province: 'ON' }, []],
    [{ party: '', province: ' ' }, ['3', '1', '2', '4']],
  ])('sorts and bounds complete ballots for %j', async (input, ids) => {
    feed();
    const result = await call(input);
    const data = ballotParity(result, getVoteTool);
    expect((data.ballots as { personId: string }[]).map((row) => row.personId)).toEqual(ids);
    expect(data.ballotsTotal).toBe(4);
    expect(data.notice).toContain('Nonvoters are not listed');
    if ('offset' in input) expect(data.notice).toContain('offset 0');
    if (!ids.length && !('offset' in input))
      expect(data).toMatchObject({
        ballotsMatched: 0,
        notice: expect.stringContaining('No recorded ballots matched'),
      });
  });
  it.each<[Record<string, unknown>, string[], string]>([
    [{ ballot: 'nay' }, ['3'], 'Nay'],
    [{ ballot: 'Paired' }, ['4'], 'Paired'],
    [{ ballot: 'No' }, ['3'], 'Nay'],
    [{ ballot: ' YES ' }, ['1', '2'], 'Yea'],
    [{ ballot: 'yea', party: 'Bloc', province: 'QC' }, ['1', '2'], 'Yea'],
    [{ ballot: 'Yea', province: 'ON' }, [], 'Yea'],
  ])(
    'filters the ballot page by recorded ballot %j without touching division totals',
    async (input, expected, canonical) => {
      feed();
      const all = ballotParity(await call(), getVoteTool);
      const data = ballotParity(await call(input), getVoteTool);
      expect(ids(data)).toEqual(expected);
      expect(ids(data)).toEqual(ids(all).filter((id) => expected.includes(id)));
      for (const key of ['division', 'tally', 'byParty', 'ballotsTotal', 'tallyMatchesBallots'])
        expect(data[key]).toStrictEqual(all[key]);
      expect(data).toMatchObject({
        ballotsMatched: expected.length,
        totalCount: expected.length,
        appliedFilters: { ballot: canonical, personId: null },
      });
      expect((data.ballots as { ballot: string }[]).every((row) => row.ballot === canonical)).toBe(
        true,
      );
    },
  );
  it.each([
    [{ personId: '2' }, ['2']],
    [{ personId: ' 3 ', ballot: 'No' }, ['3']],
    [{ personId: '2', ballot: 'Nay' }, []],
    [{ personId: '1', party: 'Bloc' }, ['1']],
  ])('filters the ballot page by recorded participant %j', async (input, expected) => {
    feed();
    const all = ballotParity(await call(), getVoteTool);
    const data = ballotParity(await call(input), getVoteTool);
    expect(ids(data)).toEqual(expected);
    for (const key of ['tally', 'byParty', 'ballotsTotal', 'tallyMatchesBallots'])
      expect(data[key]).toStrictEqual(all[key]);
    expect(data).toMatchObject({
      ballotsMatched: expected.length,
      appliedFilters: { personId: String(input.personId).trim() },
    });
  });
  it('returns an empty page with the nonvoter notice for a personId with no recorded ballot', async () => {
    feed();
    const data = ballotParity(await call({ personId: '999' }), getVoteTool);
    expect(data).toMatchObject({
      ballots: [],
      ballotsMatched: 0,
      totalCount: 0,
      ballotsTotal: 4,
      tally: { yea: 2, nay: 1, paired: 1 },
      tallyMatchesBallots: true,
      appliedFilters: { personId: '999', ballot: null, party: null, province: null },
      pagination: { offset: 0, nextOffset: null, hasMore: false },
      notice: `${NONVOTERS} No recorded ballots matched ballot/personId/party/province; remove those filters and retry canparl_get_vote.`,
    });
  });
  it.each<[string, Record<string, unknown>, string]>([
    [
      'zero matches past offset 0',
      { personId: '999', offset: 5 },
      `${NONVOTERS} No recorded ballots matched ballot/personId/party/province; remove those filters and retry canparl_get_vote.`,
    ],
    [
      'a past-end offset over matching ballots',
      { offset: 10 },
      `${NONVOTERS} Retry canparl_get_vote with offset 0 and the same filters.`,
    ],
  ])('gives one coherent empty-page notice for %s', async (_, input, notice) => {
    feed();
    const data = ballotParity(await call(input), getVoteTool);
    expect(data).toMatchObject({ ballots: [], notice });
  });
  it('matches a participant who is absent from the current roster without reading the roster', async () => {
    feed();
    http.route({ match: rosterUrl, respond: new Response('<ArrayOfMember/>') });
    const data = ballotParity(await call({ personId: '4' }), getVoteTool);
    expect(ids(data)).toEqual(['4']);
    expect(http.calls.map((entry) => entry.request.url)).not.toContain(rosterUrl);
  });
  it.each([
    [null, null],
    [0, false],
  ])('preserves absent or mismatching official counts %s', async (yeas, matches) => {
    votes(http, [rawVote(901, { DecisionDivisionNumberOfYeas: yeas })]);
    ballots(http, people);
    const result = await call();
    const data = ballotParity(result, getVoteTool);
    expect(data).toMatchObject({
      tally: { yea: yeas },
      tallyMatchesBallots: matches,
      ballotsTotal: 4,
    });
    if (matches === false) expect(data.notice).toContain('both are retained unchanged');
  });
  it('resolves current and accepts explicit historical identities from each source', async () => {
    http.route({ match: current, respond: Response.json([rawBill()]) });
    feed();
    ballotParity(await call({ session: undefined }), getVoteTool);
    votes(http, [rawVote(901, { ParliamentNumber: 38 })], '38-1');
    ballots(http, [rawPerson(1, { ParliamentNumber: 38 })], '38-1');
    const historical = await call({ session: '038-01' });
    ballotParity(historical, getVoteTool);
    expect(historical.structuredContent).toMatchObject({ division: { session: '38-1' } });
  });
  it('breaks ballot ties by surname, given name and person identity before pagination', async () => {
    votes(http);
    ballots(http, [
      rawPerson(2, { PersonOfficialFirstName: 'Amy' }),
      rawPerson(10, { PersonOfficialFirstName: 'Amy' }),
      rawPerson(3, { PersonOfficialFirstName: 'Zoe' }),
      rawPerson(4, { PersonOfficialLastName: 'Alpha' }),
    ]);
    const result = await call({ limit: 2, offset: 1 });
    const data = ballotParity(result, getVoteTool);
    expect((data.ballots as { personId: string }[]).map((row) => row.personId)).toEqual([
      '10',
      '2',
    ]);
    expect(data).toMatchObject({
      ballotsMatched: 4,
      totalCount: 4,
      pagination: { hasMore: true, nextOffset: 3 },
    });
  });
  const yeas = (count: number) =>
    rawVote(901, {
      DecisionDivisionNumberOfYeas: count,
      DecisionDivisionNumberOfNays: 0,
      DecisionDivisionNumberOfPaired: 0,
    });
  it('returns 30 ballots by default without a budget stop', async () => {
    votes(http, [yeas(45)]);
    ballots(
      http,
      Array.from({ length: 45 }, (_, i) => rawPerson(i + 1)),
    );
    const first = ballotParity(await call(), getVoteTool);
    expect(first).toMatchObject({
      shown: 30,
      cap: 30,
      truncated: true,
      pagination: { offset: 0, limit: 30, nextOffset: 30, hasMore: true },
      notice: NONVOTERS,
    });
    const rest = ballotParity(await call({ offset: 30 }), getVoteTool);
    expect(rest).toMatchObject({ shown: 15, truncated: false, notice: NONVOTERS });
  });
  it('pages all 400 paired ballots under the byte budget without doubling paired participants', async () => {
    votes(http, [
      rawVote(901, {
        DecisionDivisionNumberOfYeas: 0,
        DecisionDivisionNumberOfNays: 0,
        DecisionDivisionNumberOfPaired: 400,
      }),
    ]);
    ballots(
      http,
      Array.from({ length: 400 }, (_, i) => rawPerson(i + 1, { VoteValueName: 'Paired' })),
    );
    const pages = await walk({ limit: 400 });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap(ids)).toEqual(Array.from({ length: 400 }, (_, i) => String(i + 1)).sort());
    for (const [index, page] of pages.entries()) {
      const shown = ids(page).length;
      const last = index === pages.length - 1;
      expect(page).toMatchObject({
        ballotsTotal: 400,
        ballotsMatched: 400,
        tallyMatchesBallots: true,
        byParty: [{ paired: 400, total: 400 }],
        shown,
        cap: 400,
        truncated: !last,
        pagination: { limit: 400 },
        notice: last ? NONVOTERS : `${NONVOTERS} ${budgetNotice(shown)}`,
      });
      expect(shown).toBeLessThan(400);
    }
  });
  it.each([401, 10_000])(
    'clamps limit %i to the 400-ballot cap and keeps both disclosures across budget pages',
    async (limit) => {
      votes(http, [
        rawVote(901, {
          DecisionDivisionNumberOfYeas: 450,
          DecisionDivisionNumberOfNays: 0,
          DecisionDivisionNumberOfPaired: 0,
        }),
      ]);
      ballots(
        http,
        Array.from({ length: 450 }, (_, i) =>
          rawPerson(i + 1, { PersonOfficialLastName: `Surname${String(i).padStart(3, '0')}` }),
        ),
      );
      const clamp = `limit ${limit} exceeds the per-call maximum of 400; returned up to 400.`;
      const pages = await walk({ limit });
      expect(pages.flatMap(ids)).toEqual(Array.from({ length: 450 }, (_, i) => String(i + 1)));
      for (const [index, page] of pages.entries()) {
        const shown = ids(page).length;
        const last = index === pages.length - 1;
        expect(page).toMatchObject({
          ballotsTotal: 450,
          ballotsMatched: 450,
          totalCount: 450,
          shown,
          cap: 400,
          truncated: !last,
          tallyMatchesBallots: true,
          byParty: [{ yea: 450, total: 450 }],
          pagination: { limit: 400, hasMore: !last },
          notice: last ? `${clamp} ${NONVOTERS}` : `${clamp} ${NONVOTERS} ${budgetNotice(shown)}`,
        });
        expect(shown).toBeGreaterThan(1);
      }
    },
  );
  it('fills a budget-stopped page with every ballot that fits and no more', async () => {
    votes(http, [yeas(200)]);
    ballots(
      http,
      Array.from({ length: 200 }, (_, i) =>
        rawPerson(i + 1, {
          PersonOfficialLastName: `Surname ${'é'.repeat(i % 7)}${String(i).padStart(3, '0')}`,
        }),
      ),
    );
    const stopped = ballotParity(await call({ limit: 400, offset: 7 }), getVoteTool);
    const fit = ids(stopped).length;
    expect(stopped).toMatchObject({
      shown: fit,
      cap: 400,
      truncated: true,
      pagination: { offset: 7, limit: 400, nextOffset: 7 + fit, hasMore: true },
      notice: `${NONVOTERS} ${budgetNotice(fit)}`,
    });
    const exact = ballotParity(await call({ limit: fit, offset: 7 }), getVoteTool);
    expect(ids(exact)).toEqual(ids(stopped));
    expect(exact).toMatchObject({ shown: fit, cap: fit, truncated: true, notice: NONVOTERS });
    // The same stopped page holding the next ballot as well measures over the budget.
    const next = ballotParity(await call({ limit: 400, offset: 7 + fit }), getVoteTool);
    const grown: Record<string, unknown> = {
      ...stopped,
      ballots: [...(stopped.ballots as unknown[]), (next.ballots as unknown[])[0]],
      pagination: { offset: 7, limit: 400, nextOffset: 8 + fit, hasMore: true },
      shown: fit + 1,
      notice: `${NONVOTERS} ${budgetNotice(fit + 1)}`,
    };
    const enriched: JsonRecord = {};
    for (const key of Object.keys(getVoteTool.enrichment!))
      if (key in grown) enriched[key] = grown[key] as JsonRecord[string];
    expect(responseBytes(getVoteTool.output.parse(grown), enriched)).toBeGreaterThan(
      RESPONSE_BUDGET,
    );
  });
  const provinces = [...Object.values(PROVINCES), ...Object.keys(PROVINCES)];
  it.each<[Record<string, unknown>, FilterRejection | null]>([
    [
      { party: 'Imaginary' },
      {
        field: 'party',
        rejected: 'Imaginary',
        allowed: [...PARTIES, 'Historical caucus', 'Bloc', 'Green'],
      },
    ],
    [{ province: 'PQ' }, { field: 'province', rejected: 'PQ', allowed: provinces }],
    [{ province: 'Pacific' }, { field: 'province', rejected: 'Pacific', allowed: provinces }],
    [
      { session: '35-2' },
      {
        field: 'session',
        rejected: '35-2',
        allowed: ['45-1', '38-1', '46-2'],
        shape: 'Expected a session in the official House division session index',
      },
    ],
    [{ number: 902 }, null],
  ])('returns declared errors for %j', async (input, expected) => {
    feed();
    const reason =
      'session' in input
        ? 'unsupported_vote_session'
        : 'number' in input
          ? 'vote_not_found'
          : 'invalid_ballot_filter';
    const result = await call(input);
    failure(result, getVoteTool.errors!.find((error) => error.reason === reason)!);
    if (expected) assertFilterRejection(result, expected);
  });
  const ballotValues = ['Yea', 'Nay', 'Paired', 'Yes', 'No'];
  const decimal = 'Expected a decimal official person ID';
  it.each<[Record<string, unknown>, FilterRejection]>([
    [{ ballot: 'Absent' }, { field: 'ballot', rejected: 'Absent', allowed: ballotValues }],
    [{ ballot: 'Didn’t vote' }, { field: 'ballot', rejected: 'Didn’t', allowed: ballotValues }],
    [{ personId: 'M2897' }, { field: 'personId', rejected: 'M2897', shape: decimal }],
    [{ personId: '-41' }, { field: 'personId', rejected: '-41', shape: decimal }],
    [{ personId: '28.97' }, { field: 'personId', rejected: '28.97', shape: decimal }],
    [{ personId: 'river-example' }, { field: 'personId', rejected: 'river', shape: decimal }],
  ])('rejects invalid ballot filter %j before HTTP', async (input, expected) => {
    feed();
    const result = await call(input);
    failure(result, getVoteTool.errors!.find((error) => error.reason === 'invalid_ballot_filter')!);
    assertFilterRejection(result, expected);
    expect(http.calls).toHaveLength(0);
  });
  it.each(['45-0', '9007199254740992-1'])(
    'rejects malformed session %j as unsupported_vote_session before HTTP',
    async (session) => {
      const result = await call({ session });
      failure(
        result,
        getVoteTool.errors!.find((error) => error.reason === 'unsupported_vote_session')!,
      );
      assertFilterRejection(result, {
        field: 'session',
        rejected: session,
        shape: 'Expected a parliament-session token such as 45-1',
      });
      expect(http.calls).toHaveLength(0);
    },
  );
  it.each([404, 200])(
    'distinguishes explicit missing detail from empty listed detail (%s)',
    async (status) => {
      votes(http);
      http.route({
        match: detailUrl(),
        respond: new Response(status === 200 ? '<ArrayOfVoteParticipant/>' : '', { status }),
      });
      const reason = status === 404 ? 'vote_not_found' : 'vote_detail_unavailable';
      const result = await call();
      failure(result, getVoteTool.errors!.find((error) => error.reason === reason)!);
      if (status === 200)
        expect(result.structuredContent).toMatchObject({ error: { data: { retryable: true } } });
    },
  );
  it.each([{ number: 0 }, { number: 1.5 }, { limit: 10_001 }, { limit: 0 }, { offset: -1 }])(
    'rejects invalid input before HTTP %j',
    async (input) => {
      expect((await call(input)).structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(http.calls).toHaveLength(0);
    },
  );
});
