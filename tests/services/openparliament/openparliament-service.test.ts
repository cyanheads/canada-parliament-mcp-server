/**
 * @fileoverview OpenParliament network boundary, pacing, cache and deadline tests.
 * @module tests/services/openparliament/openparliament-service.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CallBudget, createRequestContext } from '@/domain/request-context.js';
import { OpenParliamentService } from '@/services/openparliament/openparliament-service.js';

const origin = 'https://api.openparliament.ca';
const actor = { name: 'Synthetic Member', url: '/politicians/synthetic-member/' };
const profileUrl = `${origin}${actor.url}`;
const bill = { url: '/bills/45-1/C-901/', session: '45-1', number: 'C-901' };
const vote = { url: '/votes/45-1/901/', session: '45-1', number: 901 };
const page = (objects: unknown[], limit = 2, offset = 0, next: string | null = null) => ({
  objects,
  pagination: { limit, offset, next_url: next },
});

describe('OpenParliamentService network contracts', () => {
  let http: ReturnType<typeof createFetchMock>;
  let service: OpenParliamentService;
  let budget: CallBudget;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    http = createFetchMock();
    http.install();
    service = new OpenParliamentService({ userAgent: 'synthetic-test-agent' });
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
  it('uses canonical profile URLs, manual redirects and versioned JSON headers', async () => {
    http.route({ match: profileUrl, respond: Response.json(actor) });
    expect((await settle(service.getPolitician('synthetic-member', budget))).data.slug).toBe(
      'synthetic-member',
    );
    const request = http.calls[0]?.request;
    expect(request?.url).toBe(profileUrl);
    expect(request?.redirect).toBe('manual');
    expect(request?.headers.get('api-version')).toBe('v1');
    expect(request?.headers.get('accept')).toBe('application/json');
    expect(request?.headers.get('user-agent')).toBe('synthetic-test-agent');
  });
  it('spells historical name, sponsor and ballot filters exactly and preserves null detail fields', async () => {
    http.route(
      {
        match: `${origin}/politicians/?limit=2&offset=0&include=all&name=Synthetic+Member&family_name=Member`,
        respond: Response.json(page([actor])),
      },
      {
        match: `${origin}/bills/?limit=2&offset=0&sponsor_politician=%2Fpoliticians%2Fsynthetic-member%2F&session=45-1`,
        respond: Response.json(page([bill])),
      },
      {
        match: `${origin}/votes/ballots/?limit=2&offset=0&politician=%2Fpoliticians%2Fsynthetic-member%2F`,
        respond: Response.json(
          page([{ ballot: 'Paired', politician_url: actor.url, vote_url: vote.url }]),
        ),
      },
      {
        match: `${origin}${bill.url}`,
        respond: Response.json({ ...bill, status: { en: 'At second reading' } }),
      },
      { match: `${origin}${vote.url}`, respond: Response.json(vote) },
      {
        match: `${origin}/politicians/memberships/901/`,
        respond: Response.json({ url: '/politicians/memberships/901/' }),
      },
    );
    const operations = [
      service.listPoliticians(
        { include: 'all', name: ' Synthetic Member ', familyName: ' Member ', limit: 2, offset: 0 },
        budget,
      ),
      service.listBills(
        { sponsor: 'synthetic-member', session: '45-1', limit: 2, offset: 0 },
        budget,
      ),
      service.listBallots({ politician: 'synthetic-member', limit: 2, offset: 0 }, budget),
      service.getBill('45-1', 'C-901', budget),
      service.getVote('45-1', 901, budget),
      service.getMembership('/politicians/memberships/901/', budget),
    ];
    const results = await settle(Promise.all(operations));
    expect(results).toHaveLength(6);
    expect(results[4]).toMatchObject({ data: { date: null, subject: null } });
    expect(http.calls).toHaveLength(6);
  });
  it.each([
    { dateFrom: '2026-10-20', expected: 'time__gte=2026-10-20' },
    { dateTo: '2026-12-31', expected: 'time__lt=2027-01-01' },
  ])('allows either date bound independently: $expected', async ({ expected, ...dates }) => {
    http.route({
      match: `${origin}/speeches/?limit=2&offset=0&${expected}`,
      respond: Response.json(page([])),
    });
    expect(
      (
        await settle(
          service.listSpeeches({ ...dates, substantiveOnly: false, limit: 2, offset: 0 }, budget),
        )
      ).objects,
    ).toEqual([]);
  });
  it('uses source bill paths and procedural=false, retaining institutional committee candidates', async () => {
    const url = `${origin}/speeches/?limit=2&offset=0&politician=%2Fpoliticians%2Fsynthetic-member%2F&bill_debated=%2Fbills%2F45-1%2FC-901%2F&mentioned_bill=%2Fbills%2F44-1%2FS-901%2F&procedural=false`;
    http.route({
      match: url,
      respond: Response.json(
        page([
          {
            url: '/committees/example/1/',
            time: '2026-10-20 12:00:00',
            content: { en: '<p>Institutional &amp; full</p>' },
          },
        ]),
      ),
    });
    const result = await settle(
      service.listSpeeches(
        {
          politician: 'synthetic-member',
          billDebated: { session: '45-1', code: 'C-901' },
          mentionedBill: { session: '44-1', code: 'S-901' },
          substantiveOnly: true,
          limit: 2,
          offset: 0,
        },
        budget,
      ),
    );
    expect(result.objects[0]).toMatchObject({ politician: null, content: 'Institutional & full' });
  });
  it.each(['profile', 'bill', 'vote', 'ballot', 'membership'])(
    'rejects mismatched requested %s identities after one attempt',
    async (kind) => {
      const operations: Record<string, () => Promise<unknown>> = {
        profile: () => service.getPolitician('synthetic-member', budget),
        bill: () => service.getBill('45-1', 'C-901', budget),
        vote: () => service.getVote('45-1', 901, budget),
        ballot: () =>
          service.listBallots({ politician: 'synthetic-member', limit: 2, offset: 0 }, budget),
        membership: () => service.getMembership('/politicians/memberships/901/', budget),
      };
      const records: Record<string, unknown> = {
        profile: { ...actor, url: '/politicians/other/' },
        bill: { ...bill, number: 'C-902', url: '/bills/45-1/C-902/' },
        vote: { ...vote, number: 902, url: '/votes/45-1/902/' },
        ballot: page([{ ballot: 'No', politician_url: '/politicians/other/', vote_url: vote.url }]),
        membership: { url: '/politicians/memberships/902/' },
      };
      http.route({ match: () => true, respond: Response.json(records[kind]) });
      await expect(
        settle(operations[kind]?.() ?? Promise.reject(new Error('Missing operation'))),
      ).rejects.toMatchObject({ data: { retryable: false } });
      expect(http.calls).toHaveLength(1);
    },
  );
  it('rejects malformed request boundaries without making requests', () => {
    expect(() =>
      service.listPoliticians({ include: 'all', limit: 101, offset: 0 }, budget),
    ).toThrow();
    expect(() =>
      service.listBills({ sponsor: '../secret', limit: 2, offset: 0 }, budget),
    ).toThrow();
    expect(() => service.getVote('45-1', 0, budget)).toThrow();
    expect(() =>
      service.listSpeeches(
        {
          dateFrom: '2026-10-20',
          dateTo: '2026-10-19',
          substantiveOnly: true,
          limit: 2,
          offset: 0,
        },
        budget,
      ),
    ).toThrow();
    expect(() =>
      service.listSpeeches(
        { dateTo: '9999-12-31', substantiveOnly: true, limit: 2, offset: 0 },
        budget,
      ),
    ).toThrow();
    expect(http.calls).toHaveLength(0);
  });
  it('deeply isolates cached records and preserves original retrieval evidence', async () => {
    http.route({
      match: profileUrl,
      respond: Response.json({
        ...actor,
        memberships: [
          { url: '/politicians/memberships/901/', party: { name: { en: 'Historical' } } },
        ],
      }),
    });
    const first = await settle(service.getPolitician('synthetic-member', budget));
    const retrievedAt = first.provenance[0]?.retrievedAt;
    if (first.data.memberships?.[0]) first.data.memberships[0].party.name = 'mutated';
    if (first.provenance[0]) first.provenance[0].url = 'mutated';
    const second = await service.getPolitician('synthetic-member', budget);
    expect(second.data.memberships?.[0]?.party.name).toBe('Historical');
    expect(second.provenance).toEqual([
      { source: 'openparliament', url: profileUrl, retrievedAt, cached: true },
    ]);
    expect(http.calls).toHaveLength(1);
  });
  it('expires profile cache at fifteen minutes', async () => {
    http.route({ match: profileUrl, respond: Response.json(actor) });
    await settle(service.getPolitician('synthetic-member', budget));
    budget.dispose();
    await vi.advanceTimersByTimeAsync(900_001);
    budget = createRequestContext(createMockContext());
    expect(
      (await settle(service.getPolitician('synthetic-member', budget))).provenance[0]?.cached,
    ).toBe(false);
    expect(http.calls).toHaveLength(2);
  });
  it('follows validated source offsets through short/full/past-end pages and expires page cache', async () => {
    const firstUrl = `${origin}/politicians/?limit=2&offset=0&include=all`;
    const secondUrl = `${origin}/politicians/?limit=2&offset=2&include=all`;
    const endUrl = `${origin}/politicians/?limit=2&offset=4&include=all`;
    http.route(
      {
        match: firstUrl,
        respond: Response.json(page([actor], 2, 0, '/politicians/?include=all&limit=2&offset=2')),
      },
      {
        match: secondUrl,
        respond: Response.json(
          page(
            [actor, { ...actor, url: '/politicians/other/' }],
            2,
            2,
            '/politicians/?limit=2&offset=4&include=all',
          ),
        ),
      },
      { match: endUrl, respond: Response.json(page([], 2, 4)) },
    );
    const first = await settle(
      service.listPoliticians({ include: 'all', limit: 2, offset: 0 }, budget),
    );
    expect(first.nextOffset).toBe(2);
    const second = await settle(
      service.listPoliticians({ include: 'all', limit: 2, offset: 2 }, budget),
    );
    expect(second.objects).toHaveLength(2);
    expect(second.nextOffset).toBe(4);
    const end = await service.listPoliticians({ include: 'all', limit: 2, offset: 4 }, budget);
    expect(end).toMatchObject({ objects: [], nextOffset: null });
    const cached = await service.listPoliticians({ include: 'all', limit: 2, offset: 0 }, budget);
    expect(cached.provenance[0]).toMatchObject({
      cached: true,
      retrievedAt: first.provenance[0]?.retrievedAt,
    });
    budget.dispose();
    await vi.advanceTimersByTimeAsync(120_001);
    budget = createRequestContext(createMockContext());
    expect(
      (await settle(service.listPoliticians({ include: 'all', limit: 2, offset: 0 }, budget)))
        .provenance[0]?.cached,
    ).toBe(false);
    expect(http.calls.map((call) => call.request.url)).toEqual([
      firstUrl,
      secondUrl,
      endUrl,
      firstUrl,
    ]);
  });
  it('does not retry deterministic malformed JSON or cache it', async () => {
    http.route(
      { match: profileUrl, once: true, respond: new Response('{') },
      { match: profileUrl, respond: Response.json(actor) },
    );
    await expect(settle(service.getPolitician('synthetic-member', budget))).rejects.toMatchObject({
      data: { retryable: false },
    });
    expect(http.calls).toHaveLength(1);
    expect(
      (await settle(service.getPolitician('synthetic-member', budget))).provenance[0]?.cached,
    ).toBe(false);
    expect(http.calls).toHaveLength(2);
  });
  it.each([302, 404])('does not follow or cache HTTP %s', async (status) => {
    http.route(
      {
        match: profileUrl,
        once: true,
        respond: new Response('', { status, headers: { location: 'https://evil.test/' } }),
      },
      { match: profileUrl, respond: Response.json(actor) },
    );
    await expect(settle(service.getPolitician('synthetic-member', budget))).rejects.toThrow();
    expect((await settle(service.getPolitician('synthetic-member', budget))).data.slug).toBe(
      'synthetic-member',
    );
    expect(http.calls.every((call) => call.request.url === profileUrl)).toBe(true);
  });
  it.each(['html', '503'])(
    'retries complete transient %s responses exactly twice',
    async (failure) => {
      http.route({
        match: profileUrl,
        respond:
          failure === 'html'
            ? new Response('<html>Unavailable</html>')
            : new Response('', { status: 503 }),
      });
      await expect(settle(service.getPolitician('synthetic-member', budget))).rejects.toThrow();
      expect(http.calls).toHaveLength(3);
    },
  );
  it('honors Retry-After and the shared two-second start gap', async () => {
    const starts: number[] = [];
    http.route(
      {
        match: profileUrl,
        once: true,
        respond: () => {
          starts.push(Date.now());
          return new Response('', { status: 429, headers: { 'retry-after': '4' } });
        },
      },
      {
        match: profileUrl,
        respond: () => {
          starts.push(Date.now());
          return Response.json(actor);
        },
      },
    );
    await settle(service.getPolitician('synthetic-member', budget));
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(4000);
  });
  it('serializes requests across service instances through the shared pacer', async () => {
    const other = new OpenParliamentService({ userAgent: 'synthetic-other-agent' });
    const starts: number[] = [];
    http.route({
      match: profileUrl,
      respond: () => {
        starts.push(Date.now());
        return Response.json(actor);
      },
    });
    try {
      await settle(
        Promise.all([
          service.getPolitician('synthetic-member', budget),
          other.getPolitician('synthetic-member', budget),
        ]),
      );
    } finally {
      other.dispose();
    }
    expect(starts).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(2000);
  });
  it('cancels active and queued work without another network start', async () => {
    budget.dispose();
    const caller = new AbortController();
    budget = createRequestContext(createMockContext({ signal: caller.signal }));
    http.route({
      match: profileUrl,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const outcomes = Promise.allSettled([
      service.getPolitician('synthetic-member', budget),
      service.getPolitician('synthetic-member', budget),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    for (const outcome of await outcomes)
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { code: JsonRpcErrorCode.RequestCancelled },
      });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.calls).toHaveLength(1);
  });
  it('sheds the twenty-first waiter at the process-wide queue boundary without retrying it', async () => {
    budget.dispose();
    const caller = new AbortController();
    budget = createRequestContext(createMockContext({ signal: caller.signal }));
    http.route({
      match: profileUrl,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const active = service
      .getPolitician('synthetic-member', budget)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const queued = Array.from({ length: 20 }, () =>
      service.getPolitician('synthetic-member', budget).catch((error: unknown) => error),
    );
    const overflow = service
      .getPolitician('synthetic-member', budget)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await overflow).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'pacer_shed',
        shedKind: 'queue_full',
        queueDepth: 20,
        retryAfter: expect.any(Number),
      },
    });
    expect(http.calls).toHaveLength(1);
    caller.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    for (const error of await Promise.all([active, ...queued]))
      expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(http.calls).toHaveLength(1);
  });
  it('includes stalled body reads in the operation deadline', async () => {
    http.route({
      match: profileUrl,
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
    await expect(settle(service.getPolitician('synthetic-member', budget))).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
    });
    expect(http.calls.length).toBeLessThanOrEqual(3);
  });
  it('consumes the remaining shared budget instead of restarting it', async () => {
    await vi.advanceTimersByTimeAsync(44_900);
    http.route({
      match: profileUrl,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const result = service
      .getPolitician('synthetic-member', budget)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(http.calls).toHaveLength(1);
  });
});
