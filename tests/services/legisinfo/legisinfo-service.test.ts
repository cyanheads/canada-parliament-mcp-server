/**
 * @fileoverview Network-boundary LEGISinfo transport, cache and shared-budget tests.
 * @module tests/services/legisinfo/legisinfo-service.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CallBudget, createRequestContext } from '@/domain/request-context.js';
import { LegisinfoService } from '@/services/legisinfo/legisinfo-service.js';

const origin = 'https://www.parl.ca';
const picker = `${origin}/legisinfo/en/bills`;
const current = `${picker}/json`;
const listing = `${current}?parlsession=45-1`;
const detail = `${origin}/legisinfo/en/bill/45-1/c-901/json`;
const bill = {
  ParliamentNumber: 45,
  SessionNumber: 1,
  NumberCode: 'C-901',
  IsSessionOngoing: true,
  LongTitleEn: 'Synthetic bill',
};
const html = (sessions = ['45-1']) =>
  sessions.map((s) => `<a data-input="parlsession" data-value="${s}">Example</a>`).join('');

describe('LegisinfoService network contract', () => {
  let http: ReturnType<typeof createFetchMock>;
  let service: LegisinfoService;
  let budget: CallBudget;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    http = createFetchMock();
    http.install();
    service = new LegisinfoService({ userAgent: 'synthetic-test-agent' });
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
  const sessions = (values?: string[]) =>
    http.route({ match: picker, respond: new Response(html(values)) });

  it('does not retry an official 403 or cache the failure', async () => {
    http.route(
      {
        match: current,
        once: true,
        respond: new Response('<html>Access denied</html>', { status: 403 }),
      },
      { match: current, respond: Response.json([bill]) },
    );
    await expect(settle(service.getCurrentSession(budget))).rejects.toMatchObject({
      data: { status: 403 },
    });
    expect(http.calls).toHaveLength(1);
    expect((await settle(service.getCurrentSession(budget))).data).toBe('45-1');
    expect((await service.getCurrentSession(budget)).provenance[0]?.cached).toBe(true);
    expect(http.calls).toHaveLength(2);
  });

  it('classifies a source refusal without exposing the upstream body', async () => {
    http.route({
      match: current,
      respond: new Response('<html>private refusal marker</html>', { status: 403 }),
    });
    const error = await settle(service.getCurrentSession(budget)).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'LEGISinfo refused the official data request.',
      data: {
        reason: 'upstream_blocked',
        source: 'legisinfo',
        status: 403,
        retryable: false,
        recovery: { hint: 'Retry LEGISinfo later for official parliamentary data.' },
      },
    });
    expect(error).not.toHaveProperty('data.body');
    expect(error).not.toHaveProperty('data.responseBody');
    expect(JSON.stringify(error)).not.toContain('private refusal marker');
    expect(http.calls).toHaveLength(1);
  });
  it('builds only canonical allowlisted requests and supplies manual redirects and headers', async () => {
    sessions();
    http.route({ match: detail, respond: Response.json([bill]) });
    const result = await settle(service.getBill('045-01', 'bill c901', budget));
    expect(result.data.bill.billCode).toBe('C-901');
    expect(http.calls.map((c) => c.request.url)).toEqual([picker, detail]);
    expect(http.calls[1]?.request.redirect).toBe('manual');
    expect(http.calls[1]?.request.headers.get('user-agent')).toBe('synthetic-test-agent');
    expect(http.calls[1]?.request.headers.get('accept')).toBe('application/json');
    expect(result.provenance).toHaveLength(2);
  });
  it('distinguishes a known empty feed from unsupported sessions without probing guesses', async () => {
    sessions();
    http.route({ match: listing, respond: Response.json([]) });
    expect((await settle(service.listBills('45-1', budget))).data).toEqual([]);
    await expect(service.listBills('46-1', budget)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'session: Expected a session in the official bill session index: "45-1".',
      data: { reason: 'unknown_session', retryable: false, field: 'session', allowed: ['45-1'] },
    });
    expect(http.calls.map((c) => c.request.url)).toEqual([picker, listing]);
  });
  it('names the session shape for a malformed token before any request', async () => {
    const rejection = service.listBills('45-0', budget);
    await expect(rejection).rejects.toMatchObject({
      message: expect.stringMatching(/^session: Expected a parliament-session token such as 45-1/),
      data: { reason: 'unknown_session', retryable: false, field: 'session' },
    });
    await expect(rejection).rejects.not.toHaveProperty('data.allowed');
    expect(http.calls).toHaveLength(0);
  });
  it.each(['45-0', '0-1', '9007199254740992-1'])(
    'resolves malformed session %j to the same field-named unknown_session before any request',
    async (session) => {
      const rejection = service.resolveSession(session, budget);
      await expect(rejection).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringMatching(
          /^session: Expected a parliament-session token such as 45-1/,
        ),
        data: { reason: 'unknown_session', retryable: false, field: 'session' },
      });
      await expect(rejection).rejects.not.toHaveProperty('data.allowed');
      expect(http.calls).toHaveLength(0);
    },
  );
  it('resolves a supplied session without a request and an omitted one from the current feed', async () => {
    expect(await service.resolveSession({ parliament: 37, session: 1 }, budget)).toEqual({
      data: '37-1',
      provenance: [],
    });
    http.route({ match: current, respond: Response.json([bill]) });
    expect((await settle(service.resolveSession(undefined, budget))).data).toBe('45-1');
    expect(http.calls.map((c) => c.request.url)).toEqual([current]);
  });
  it('lists a session whose rows include split-bill codes beside their base code', async () => {
    sessions();
    const rows = ['C-15', 'C-15A', 'C-15B'].map((NumberCode) => ({ ...bill, NumberCode }));
    http.route({ match: listing, respond: Response.json(rows) });
    expect(
      (await settle(service.listBills('45-1', budget))).data.map((row) => row.billCode),
    ).toEqual(['C-15', 'C-15A', 'C-15B']);
  });
  it.each([
    { rows: [bill, bill] },
    { rows: [{ ...bill, SessionNumber: 2 }] },
    { rows: [{ ...bill, NumberCode: 'bad' }] },
  ])('rejects duplicate or mismatched whole-session identities', async ({ rows }) => {
    sessions();
    http.route({ match: listing, respond: Response.json(rows) });
    await expect(settle(service.listBills('45-1', budget))).rejects.toMatchObject({
      data: { reason: 'upstream_response_invalid', retryable: false },
    });
    expect(http.calls).toHaveLength(2);
  });
  it('paces independent upstream starts at least 250ms apart', async () => {
    const starts: number[] = [];
    http.route(
      {
        match: picker,
        respond: () => {
          starts.push(Date.now());
          return new Response(html());
        },
      },
      {
        match: current,
        respond: () => {
          starts.push(Date.now());
          return Response.json([bill]);
        },
      },
    );
    await settle(Promise.all([service.getSessions(budget), service.getCurrentSession(budget)]));
    expect(starts).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(250);
  });
  it('does not retain missing dossiers in the cache', async () => {
    sessions();
    http.route(
      { match: detail, once: true, respond: new Response('', { status: 404 }) },
      { match: detail, respond: Response.json([bill]) },
    );
    await expect(settle(service.getBill('45-1', 'C-901', budget))).rejects.toMatchObject({
      data: { reason: 'bill_not_found' },
    });
    expect((await settle(service.getBill('45-1', 'C-901', budget))).data.bill.billCode).toBe(
      'C-901',
    );
    expect(http.calls).toHaveLength(3);
  });
  it.each(['C-0', 'C-1/../../secret', 'https://evil.test/C-1'])(
    'rejects invalid bill code %s as a field-named invalid_bill_code before any request',
    async (code) => {
      const error = await service.getBill('45-1', code, budget).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringMatching(
          /^billCode: Expected a House or Senate bill code such as C-15, C-15A, or S-1001/,
        ),
        data: { reason: 'invalid_bill_code', retryable: false, field: 'billCode' },
        cause: expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }),
      });
      expect(error).not.toHaveProperty('data.allowed');
      const { message, data } = error as { message: string; data: unknown };
      expect(JSON.stringify([message, data])).not.toContain(code);
      expect(http.calls).toHaveLength(0);
    },
  );
  it('augments a stale picker only with a verified current feed and source evidence', async () => {
    sessions(['44-1']);
    http.route({ match: current, respond: Response.json([bill]) });
    expect((await settle(service.getSessions(budget))).data.map((s) => s.session)).toEqual([
      '44-1',
    ]);
    await settle(service.getCurrentSession(budget));
    const result = await service.getSessions(budget);
    expect(result.data.map((s) => s.session)).toEqual(['45-1', '44-1']);
    expect(result.provenance.map((p) => p.url)).toEqual([picker, current]);
    expect(result.provenance.every((p) => p.cached)).toBe(true);
  });
  it('retains retrieval timestamps and deeply isolates cached data and provenance', async () => {
    sessions();
    http.route({
      match: detail,
      respond: Response.json([
        {
          ...bill,
          BillStages: {
            HouseBillStages: [{ BillStageId: 1, Decisions: [{ nested: { value: 'original' } }] }],
          },
        },
      ]),
    });
    const first = await settle(service.getBill('45-1', 'C-901', budget));
    const timestamp = first.provenance[1]?.retrievedAt;
    first.data.bill.longTitle.en = 'mutated';
    first.data.stages.house?.[0]?.decisions?.push({ bad: true });
    if (first.provenance[1]) first.provenance[1].url = 'mutated';
    const second = await service.getBill('45-1', 'C-901', budget);
    expect(second.data.bill.longTitle.en).toBe('Synthetic bill');
    expect(second.data.stages.house?.[0]?.decisions).toEqual([{ nested: { value: 'original' } }]);
    expect(second.provenance[1]).toMatchObject({
      url: detail,
      retrievedAt: timestamp,
      cached: true,
    });
    expect(http.calls).toHaveLength(2);
  });
  it.each([
    new Response('', { status: 404 }),
    new Response('', { status: 302, headers: { location: '/ErrorPage/en?StatusCode=404' } }),
  ])(
    'classifies missing dossiers without following the 200 HTML error-page trap',
    async (response) => {
      sessions();
      http.route({ match: detail, respond: response });
      await expect(settle(service.getBill('45-1', 'C-901', budget))).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'bill_not_found', retryable: false },
      });
      expect(http.calls.map((c) => c.request.url)).toEqual([picker, detail]);
    },
  );
  it.each([
    'https://evil.test/legisinfo/en/bills',
    'http://127.0.0.1/legisinfo/en/bills',
    '/legisinfo/en/bills?changed=1',
    '/other',
    '/legisinfo/en/bills#fragment',
    'https://user:pass@www.parl.ca/legisinfo/en/bills',
  ])('rejects unsafe redirect %s without following', async (location) => {
    http.route({
      match: picker,
      respond: new Response('', { status: 302, headers: { location } }),
    });
    await expect(settle(service.getSessions(budget))).rejects.toMatchObject({
      data: { reason: 'upstream_response_invalid', retryable: false },
    });
    expect(http.calls).toHaveLength(1);
  });
  it('allows a same-origin canonical trailing slash redirect', async () => {
    http.route(
      {
        match: picker,
        respond: new Response('', { status: 301, headers: { location: '/legisinfo/en/bills/' } }),
      },
      { match: `${picker}/`, respond: new Response(html()) },
    );
    expect((await settle(service.getSessions(budget))).data[0]?.session).toBe('45-1');
    expect(http.calls).toHaveLength(2);
  });
  it('retries transient HTML through parsing and does not retry deterministic JSON errors', async () => {
    http.route(
      { match: current, once: true, respond: new Response('<html>Temporary outage</html>') },
      { match: current, respond: Response.json([bill]) },
    );
    expect((await settle(service.getCurrentSession(budget))).data).toBe('45-1');
    expect(http.calls).toHaveLength(2);
    service.dispose();
    service = new LegisinfoService({ userAgent: 'synthetic-test-agent' });
    http.reset();
    http.route({ match: current, respond: new Response('{') });
    await expect(settle(service.getCurrentSession(budget))).rejects.toMatchObject({
      data: { reason: 'upstream_response_invalid', retryable: false },
    });
    expect(http.calls).toHaveLength(1);
  });
  it('does not cache parse errors or substitute stale success after expiry', async () => {
    http.route(
      { match: current, once: true, respond: new Response('{') },
      { match: current, once: true, respond: Response.json([bill]) },
      { match: current, respond: new Response('{') },
    );
    await expect(settle(service.getCurrentSession(budget))).rejects.toThrow();
    expect((await settle(service.getCurrentSession(budget))).data).toBe('45-1');
    budget.dispose();
    await vi.advanceTimersByTimeAsync(300_001);
    budget = createRequestContext(createMockContext());
    await expect(settle(service.getCurrentSession(budget))).rejects.toThrow();
    expect(http.calls).toHaveLength(3);
  });
  it('honors Retry-After before the next attempt', async () => {
    const starts: number[] = [];
    http.route(
      {
        match: current,
        once: true,
        respond: () => {
          starts.push(Date.now());
          return new Response('', { status: 429, headers: { 'retry-after': '4' } });
        },
      },
      {
        match: current,
        respond: () => {
          starts.push(Date.now());
          return Response.json([bill]);
        },
      },
    );
    expect((await settle(service.getCurrentSession(budget))).data).toBe('45-1');
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(4000);
  });
  it('exhausts exactly three 5xx attempts', async () => {
    http.route({ match: current, respond: new Response('', { status: 503 }) });
    await expect(settle(service.getCurrentSession(budget))).rejects.toThrow();
    expect(http.calls).toHaveLength(3);
  });
  it('stops queued network work when the caller cancels', async () => {
    budget.dispose();
    const caller = new AbortController();
    budget = createRequestContext(createMockContext({ signal: caller.signal }));
    http.route({
      match: current,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const outcome = service.getCurrentSession(budget).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.calls).toHaveLength(1);
  });
  it('uses the remaining shared budget rather than restarting an operation clock', async () => {
    await vi.advanceTimersByTimeAsync(44_900);
    http.route({
      match: current,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const outcome = service.getCurrentSession(budget).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await outcome).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(http.calls).toHaveLength(1);
  });
  it('sheds excess waiters without retrying or dispatching them later', async () => {
    budget.dispose();
    const caller = new AbortController();
    budget = createRequestContext(createMockContext({ signal: caller.signal }));
    http.route({
      match: current,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const active = service.getCurrentSession(budget).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(250);
    const second = service.getCurrentSession(budget).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(250);
    const queued = Array.from({ length: 20 }, () =>
      service.getCurrentSession(budget).catch((error: unknown) => error),
    );
    const rejected: unknown[] = [];
    const overflow = service.getCurrentSession(budget).catch((error: unknown) => {
      rejected.push(error);
      return error;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'pacer_shed',
        shedKind: 'queue_full',
        queueDepth: 20,
        retryAfter: expect.any(Number),
      },
    });
    expect(http.calls).toHaveLength(2);
    caller.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    for (const error of await Promise.all([active, second, ...queued]))
      expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(await overflow).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    expect(http.calls).toHaveLength(2);
  });
  it('times out a stalled body read within the operation deadline', async () => {
    http.route({
      match: current,
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
    await expect(settle(service.getCurrentSession(budget))).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
    });
    expect(http.calls.length).toBeLessThanOrEqual(3);
  });
});
