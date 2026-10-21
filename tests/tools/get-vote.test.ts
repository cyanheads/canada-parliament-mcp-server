/** @fileoverview Joined division and full-ballot aggregation contracts. @module tests/tools/get-vote.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getVoteTool } from '@/mcp-server/tools/definitions/get-vote.tool.js';
import {
  ballots,
  current,
  detailUrl,
  failure,
  parity,
  rawBill,
  rawPerson,
  rawVote,
  settle,
  setup,
  teardown,
  votes,
} from '../fixtures/vote-tools/harness.js';

describe('canparl_get_vote production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
  });
  afterEach(() => teardown(http));
  const call = (input: Record<string, unknown> = {}) =>
    settle(runToolContract(getVoteTool, { number: 901, session: '45-1', ...input }));
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
    const data = parity(result, getVoteTool);
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
      appliedFilters: { session: '45-1', number: 901, party: 'Bloc Québécois', province: 'Quebec' },
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
    const data = parity(result, getVoteTool);
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
  it.each([
    [null, null],
    [0, false],
  ])('preserves absent or mismatching official counts %s', async (yeas, matches) => {
    votes(http, [rawVote(901, { DecisionDivisionNumberOfYeas: yeas })]);
    ballots(http, people);
    const result = await call();
    const data = parity(result, getVoteTool);
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
    parity(await call({ session: undefined }), getVoteTool);
    votes(http, [rawVote(901, { ParliamentNumber: 38 })], '38-1');
    ballots(http, [rawPerson(1, { ParliamentNumber: 38 })], '38-1');
    const historical = await call({ session: '038-01' });
    parity(historical, getVoteTool);
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
    const data = parity(result, getVoteTool);
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
  it('returns all 400 ballots at the allowed maximum without doubling paired participants', async () => {
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
    const result = await call({ limit: 400 });
    parity(result, getVoteTool);
    expect(result.structuredContent).toMatchObject({
      ballotsTotal: 400,
      ballotsMatched: 400,
      shown: 400,
      tallyMatchesBallots: true,
      byParty: [{ paired: 400, total: 400 }],
      pagination: { hasMore: false, nextOffset: null },
    });
  });
  it.each([
    { party: 'Imaginary' },
    { province: 'PQ' },
    { province: 'Pacific' },
    { session: '35-2' },
    { number: 902 },
  ])('returns declared errors for %j', async (input) => {
    feed();
    const reason =
      'session' in input
        ? 'unsupported_vote_session'
        : 'number' in input
          ? 'vote_not_found'
          : 'invalid_ballot_filter';
    failure(await call(input), getVoteTool.errors!.find((error) => error.reason === reason)!);
  });
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
  it.each([{ number: 0 }, { number: 1.5 }, { limit: 401 }, { limit: 0 }, { offset: -1 }])(
    'rejects invalid input before HTTP %j',
    async (input) => {
      expect((await call(input)).structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(http.calls).toHaveLength(0);
    },
  );
});
