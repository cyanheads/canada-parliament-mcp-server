/** @fileoverview House HTTP transport, cache and budget contracts. @module tests/services/ourcommons/ourcommons-service.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CallBudget, createRequestContext } from '@/domain/request-context.js';
import { OurCommonsService } from '@/services/ourcommons/ourcommons-service.js';

const base = 'https://www.ourcommons.ca/Members/en';
const picker = `${base}/votes`;
const roster = `${base}/search/xml`;
const listing = `${base}/votes/xml?parlSession=45-1`;
const detail = `${base}/votes/45/1/901/xml`;
const html =
  '<!-- synthetic --!><a data-input="parlSession" data-value="all">All</a><a data-input="parlSession" data-value="45-1">Synthetic session</a>';
const person =
  '<PersonId>9001</PersonId><PersonOfficialFirstName>River</PersonOfficialFirstName><PersonOfficialLastName>Example</PersonOfficialLastName>';
const identity =
  '<ParliamentNumber>45</ParliamentNumber><SessionNumber>1</SessionNumber><DecisionDivisionNumber>901</DecisionDivisionNumber>';
const xmlMembers = `<ArrayOfMemberOfParliament><MemberOfParliament>${person}</MemberOfParliament></ArrayOfMemberOfParliament>`;
const xmlVotes = `<ArrayOfVote><Vote>${identity}</Vote></ArrayOfVote>`;
const xmlParticipants = `<ArrayOfVoteParticipant><VoteParticipant>${identity}${person}<VoteValueName>Yea</VoteValueName></VoteParticipant></ArrayOfVoteParticipant>`;

describe('OurCommonsService network boundary', () => {
  let http: ReturnType<typeof createFetchMock>;
  let service: OurCommonsService;
  let budget: CallBudget;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    http = createFetchMock();
    http.install();
    service = new OurCommonsService({ userAgent: 'synthetic-test-agent' });
    budget = createRequestContext(createMockContext());
  });
  afterEach(() => {
    budget.dispose();
    service.dispose();
    http.restore();
    vi.useRealTimers();
  });
  const settle = async <T>(promise: Promise<T>) => {
    const outcome = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(20_001);
    const result = await outcome;
    if ('error' in result) throw result.error;
    return result.value;
  };
  const sessions = () => http.route({ match: picker, respond: new Response(html) });

  it('uses all four fixed canonical routes, complete parsing, headers and manual redirects', async () => {
    sessions();
    http.route(
      { match: roster, respond: new Response(xmlMembers) },
      { match: listing, respond: new Response(xmlVotes) },
      { match: detail, respond: new Response(xmlParticipants) },
    );
    const result = await settle(
      Promise.all([
        service.getVoteSessions(budget),
        service.listMembers(budget),
        service.listVotes('45-1', budget),
        service.getVoteParticipants('45-1', 901, budget),
      ]),
    );
    expect(result[0].data[0]?.session).toBe('45-1');
    expect(result[1].data[0]?.personId).toBe('9001');
    expect(result[2].data[0]?.number).toBe(901);
    expect(result[3].data[0]?.ballot).toBe('Yea');
    expect(new Set(http.calls.map((call) => call.request.url))).toEqual(
      new Set([picker, roster, listing, detail]),
    );
    for (const { request } of http.calls) {
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('user-agent')).toBe('synthetic-test-agent');
      expect(request.headers.get('accept')).toBe(
        request.url === picker ? 'text/html' : 'application/xml',
      );
    }
  });
  it('distinguishes known empty sessions from unsupported ones without guessing URLs', async () => {
    sessions();
    http.route({ match: listing, respond: new Response('<ArrayOfVote/>') });
    expect((await settle(service.listVotes('45-1', budget))).data).toEqual([]);
    await expect(service.listVotes('46-1', budget)).rejects.toMatchObject({
      data: { reason: 'unsupported_vote_session' },
    });
    expect(http.calls.map((call) => call.request.url)).toEqual([picker, listing]);
  });
  it('spaces distinct HTTP starts by at least 250ms', async () => {
    const starts: number[] = [];
    http.route(
      {
        match: roster,
        respond: () => {
          starts.push(Date.now());
          return new Response(xmlMembers);
        },
      },
      {
        match: picker,
        respond: () => {
          starts.push(Date.now());
          return new Response(html);
        },
      },
    );
    await settle(Promise.all([service.listMembers(budget), service.getVoteSessions(budget)]));
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(250);
  });
  it('keeps the picker for six hours and refetches it after expiry', async () => {
    sessions();
    await settle(service.getVoteSessions(budget));
    budget.dispose();
    await vi.advanceTimersByTimeAsync(300_001);
    budget = createRequestContext(createMockContext());
    expect((await service.getVoteSessions(budget)).provenance[0]?.cached).toBe(true);
    expect(http.calls).toHaveLength(1);
    budget.dispose();
    await vi.advanceTimersByTimeAsync(21_600_001);
    budget = createRequestContext(createMockContext());
    expect((await settle(service.getVoteSessions(budget))).provenance[0]?.cached).toBe(false);
    expect(http.calls).toHaveLength(2);
  });
  it.each(['045-01', '45-1/../../secret', 'https://evil.test'])(
    'rejects noncanonical session %s before any HTTP',
    async (session) => {
      await expect(service.listVotes(session, budget)).rejects.toThrow();
      expect(http.calls).toHaveLength(0);
    },
  );
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid division number %s without a detail request',
    async (number) => {
      sessions();
      await expect(settle(service.getVoteParticipants('45-1', number, budget))).rejects.toThrow();
      expect(http.calls.map((call) => call.request.url)).toEqual([picker]);
    },
  );
  it('returns typed detail 404 and does not cache it', async () => {
    sessions();
    http.route(
      { match: detail, once: true, respond: new Response('', { status: 404 }) },
      { match: detail, respond: new Response(xmlParticipants) },
    );
    await expect(settle(service.getVoteParticipants('45-1', 901, budget))).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'vote_not_found' },
    });
    expect((await settle(service.getVoteParticipants('45-1', 901, budget))).data).toHaveLength(1);
    expect(http.calls).toHaveLength(3);
  });
  it('retries unavailable empty detail and reports it without fabricating ballots', async () => {
    sessions();
    http.route({ match: detail, respond: new Response('<ArrayOfVoteParticipant/>') });
    await expect(settle(service.getVoteParticipants('45-1', 901, budget))).rejects.toMatchObject({
      data: { reason: 'vote_detail_unavailable', retryable: true },
    });
    expect(http.calls.filter((call) => call.request.url === detail)).toHaveLength(3);
  });
  it('retains retrieval timestamps and isolates successful cached records', async () => {
    http.route({ match: roster, respond: new Response(xmlMembers) });
    const first = await settle(service.listMembers(budget));
    const timestamp = first.provenance[0]?.retrievedAt;
    first.data[0]!.name = 'Mutated';
    first.data[0]!.detailLookup.personId = 'Mutated';
    first.provenance[0]!.url = 'https://synthetic.test/mutated';
    const second = await service.listMembers(budget);
    expect(second.data[0]).toMatchObject({
      name: 'River Example',
      detailLookup: { personId: '9001' },
    });
    expect(second.provenance[0]).toMatchObject({
      retrievedAt: timestamp,
      cached: true,
      url: roster,
    });
    expect(http.calls).toHaveLength(1);
  });
  it('does not cache malformed responses or substitute expired success', async () => {
    http.route(
      { match: roster, once: true, respond: new Response('<bad/>') },
      { match: roster, once: true, respond: new Response(xmlMembers) },
      { match: roster, respond: new Response('<bad/>') },
    );
    await expect(settle(service.listMembers(budget))).rejects.toThrow();
    expect((await settle(service.listMembers(budget))).data).toHaveLength(1);
    budget.dispose();
    await vi.advanceTimersByTimeAsync(300_001);
    budget = createRequestContext(createMockContext());
    await expect(settle(service.listMembers(budget))).rejects.toMatchObject({
      data: { reason: 'upstream_response_invalid', retryable: false },
    });
    expect(http.calls).toHaveLength(3);
  });
  it('retries transient HTML through the production parser', async () => {
    http.route(
      { match: roster, once: true, respond: new Response('<html>Temporary outage</html>') },
      { match: roster, respond: new Response(xmlMembers) },
    );
    expect((await settle(service.listMembers(budget))).data).toHaveLength(1);
    expect(http.calls).toHaveLength(2);
  });
  it('honors Retry-After and exhausts only three 5xx attempts', async () => {
    const starts: number[] = [];
    http.route(
      {
        match: roster,
        once: true,
        respond: () => {
          starts.push(Date.now());
          return new Response('', { status: 429, headers: { 'retry-after': '4' } });
        },
      },
      {
        match: roster,
        respond: () => {
          starts.push(Date.now());
          return new Response(xmlMembers);
        },
      },
    );
    await settle(service.listMembers(budget));
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(4000);
    http.route({ match: picker, respond: new Response('', { status: 503 }) });
    await expect(settle(service.getVoteSessions(budget))).rejects.toThrow();
    expect(http.calls.filter((call) => call.request.url === picker)).toHaveLength(3);
  });
  it('rejects redirects without following a foreign or loopback destination', async () => {
    http.route({
      match: roster,
      respond: new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    });
    await expect(settle(service.listMembers(budget))).rejects.toThrow();
    expect(http.calls.every((call) => call.request.url === roster)).toBe(true);
  });
  it('cancels outstanding and queued work without more network starts', async () => {
    budget.dispose();
    const caller = new AbortController();
    budget = createRequestContext(createMockContext({ signal: caller.signal }));
    http.route({
      match: roster,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          }),
        ),
    });
    const outcome = service.listMembers(budget).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.calls).toHaveLength(1);
  });
  it('shares the remaining upstream budget instead of restarting its clock', async () => {
    await vi.advanceTimersByTimeAsync(44_900);
    http.route({
      match: roster,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          }),
        ),
    });
    const outcome = service.listMembers(budget).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await outcome).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(http.calls).toHaveLength(1);
  });
  it('times out stalled response bodies within the operation deadline', async () => {
    http.route({
      match: roster,
      respond: (request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                'abort',
                () => controller.error(request.signal.reason),
                { once: true },
              );
            },
          }),
        ),
    });
    await expect(settle(service.listMembers(budget))).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
    });
    expect(http.calls.length).toBeLessThanOrEqual(3);
  });
});
