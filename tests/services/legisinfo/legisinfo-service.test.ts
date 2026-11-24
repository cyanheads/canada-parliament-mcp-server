/**
 * @fileoverview Network-boundary LEGISinfo transport, cache and shared-budget tests.
 * @module tests/services/legisinfo/legisinfo-service.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockResponder,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CallBudget, createRequestContext } from '@/domain/request-context.js';
import type { Source } from '@/domain/schemas.js';
import { BillTextCache, LegisinfoService } from '@/services/legisinfo/legisinfo-service.js';
import type { BillTextDocument } from '@/services/legisinfo/types.js';
import {
  type BillTextXml,
  billTextFixture,
  capturedRedirects,
  capturedXml,
  type ViewerPage,
} from '../../fixtures/bill-tools/bill-text.js';
import { expectLinearCpu } from '../../fixtures/cpu-timing.js';

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

describe('LegisinfoService.getBill lineage', () => {
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
  const reinstated = () =>
    Response.json([
      {
        ...bill,
        DidReinstateFromPreviousSession: false,
        ReinstatedFromBillNumberCode: null,
        DidReinstateInNextSession: true,
        ReinstatedAsBillNumberCode: 'C-7',
      },
    ]);
  it.each([
    ['lists', ['45-2', '45-1'], '45-2'],
    ['lacks', ['45-1'], null],
  ])(
    'resolves the successor session from the index it verifies when the picker %s it, with no further request',
    async (_case, listed, session) => {
      http.route(
        { match: picker, respond: new Response(html(listed)) },
        { match: detail, respond: reinstated() },
      );
      const result = await settle(service.getBill('45-1', 'C-901', budget));
      expect(result.data.reinstatement).toEqual({ from: null, as: { session, billCode: 'C-7' } });
      expect(http.calls.map((c) => c.request.url)).toEqual([picker, detail]);
    },
  );
  it('resolves against a stale picker augmented by the verified current session', async () => {
    http.route(
      { match: picker, respond: new Response(html(['45-1'])) },
      { match: current, respond: Response.json([{ ...bill, SessionNumber: 2 }]) },
      { match: detail, respond: reinstated() },
    );
    expect((await settle(service.getCurrentSession(budget))).data).toBe('45-2');
    const result = await settle(service.getBill('45-1', 'C-901', budget));
    expect(result.data.reinstatement.as).toEqual({ session: '45-2', billCode: 'C-7' });
    expect(http.calls.map((c) => c.request.url)).toEqual([current, picker, detail]);
  });
});

const S2 = 13_542_656;
const viewerUrl = (id: number, language: 'en' | 'fr' = 'en') =>
  `${origin}/DocumentViewer/${language}/${id}`;
const s2Page = `${origin}${capturedRedirects.s2FirstReading}`;
const s2Html = billTextFixture('viewer-S-2-first-reading.html');
const s2Href = '/Content/Bills/451/Government/S-2/S-2_1/S-2_E.xml';
const s2FirstLine =
  '(1) The definition mentally incompetent Indian in subsection 2(1) of the Indian Act is repealed.';
const redirect = (location: string) => new Response('', { status: 302, headers: { location } });
const viewerPage = (name: ViewerPage) => new Response(billTextFixture(name));
const billXml = (name: BillTextXml) => new Response(billTextFixture(name));
const cutXml = () => new Response(billTextFixture('S-2_1_E.xml').slice(0, 12_000));
const unavailable = (message: string) => ({
  code: JsonRpcErrorCode.NotFound,
  message,
  data: { reason: 'bill_text_unavailable', retryable: false },
});
const invalid = { data: { reason: 'upstream_response_invalid', retryable: false } };
const noViewerPage = unavailable('The official document viewer has no page for this publication.');
/**
 * A streamed page body: `head` in one chunk, then 1 KiB filler chunks closing after about 1 MiB, or a
 * stall that errors when the request aborts. `state` counts the chunks pulled and records a cancel.
 */
function streamedPage(head: string, rest: 'filler' | 'stall' = 'filler') {
  const state = { pulls: 0, cancelled: false };
  const encoder = new TextEncoder();
  const filler = encoder.encode(`<p>${'x'.repeat(1017)}</p>`);
  const respond = (request: Request) =>
    new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            state.pulls++;
            if (state.pulls === 1) controller.enqueue(encoder.encode(head));
            else if (rest === 'stall')
              await new Promise<void>((resolve) => {
                request.signal.addEventListener(
                  'abort',
                  () => {
                    controller.error(request.signal.reason);
                    resolve();
                  },
                  { once: true },
                );
              });
            else if (state.pulls > 1024) controller.close();
            else controller.enqueue(filler);
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  return { state, respond };
}

describe('LegisinfoService bill text', () => {
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
  const failure = (promise: Promise<unknown>) => settle(promise).catch((error: unknown) => error);
  /** A fresh call budget starting at `time`. */
  const at = (time: number) => {
    budget.dispose();
    vi.setSystemTime(time);
    budget = createRequestContext(createMockContext());
  };
  /** Route 45-1 S-2's English first reading: viewer redirect, page, XML; each replaceable. */
  const routeS2 = (
    replace: {
      viewer?: FetchMockResponder;
      page?: FetchMockResponder;
      xml?: FetchMockResponder;
    } = {},
  ) =>
    http.route(
      {
        match: viewerUrl(S2),
        respond: replace.viewer ?? redirect(capturedRedirects.s2FirstReading),
      },
      { match: s2Page, respond: replace.page ?? viewerPage('viewer-S-2-first-reading.html') },
      { match: capturedXml.s2En, respond: replace.xml ?? billXml('S-2_1_E.xml') },
    );
  const readS2 = (target = service) => target.getBillText('45-1', 'S-2', S2, 'en', budget);
  const urls = () => http.calls.map((call) => call.request.url);
  const s2Urls = [viewerUrl(S2), s2Page, capturedXml.s2En];

  describe('reads', () => {
    it('follows the viewer redirect to the page head, then the XML, with manual redirects and source headers', async () => {
      routeS2();
      const result = await settle(service.getBillText('045-01', 'bill s2', S2, 'en', budget));
      expect(urls()).toEqual(s2Urls);
      expect(http.calls.map((call) => call.request.redirect)).toEqual([
        'manual',
        'manual',
        'manual',
      ]);
      expect(http.calls.map((call) => call.request.headers.get('user-agent'))).toEqual(
        Array(3).fill('synthetic-test-agent'),
      );
      expect(http.calls.map((call) => call.request.headers.get('accept'))).toEqual([
        'text/html',
        'text/html',
        'application/xml, text/xml',
      ]);
      expect(result.data).toMatchObject({
        publicationId: S2,
        url: viewerUrl(S2),
        xmlUrl: capturedXml.s2En,
        billCode: 'S-2',
        session: '45-1',
        language: 'en',
        stage: 'first-reading-senate',
        stageDate: '2025-05-29',
        sponsor: 'THE HONOURABLE SENATOR GOLD, P.C.',
      });
      expect(result.data.body).toHaveLength(11);
      expect(result.data.body[0]?.text?.split('\n')[0]).toBe(s2FirstLine);
      expect(result.provenance).toEqual([
        { source: 'legisinfo', url: viewerUrl(S2), retrievedAt: expect.any(String), cached: false },
        {
          source: 'legisinfo',
          url: capturedXml.s2En,
          retrievedAt: expect.any(String),
          cached: false,
        },
      ]);
    });

    it('reads the French version through the French viewer route', async () => {
      const page = `${origin}${capturedRedirects.s2PremiereLecture}`;
      http.route(
        { match: viewerUrl(S2, 'fr'), respond: redirect(capturedRedirects.s2PremiereLecture) },
        { match: page, respond: viewerPage('viewer-S-2-premiere-lecture.html') },
        { match: capturedXml.s2Fr, respond: billXml('S-2_1_F.xml') },
      );
      const result = await settle(service.getBillText('45-1', 'S-2', S2, 'fr', budget));
      expect(urls()).toEqual([viewerUrl(S2, 'fr'), page, capturedXml.s2Fr]);
      expect(result.data).toMatchObject({
        language: 'fr',
        url: viewerUrl(S2, 'fr'),
        xmlUrl: capturedXml.s2Fr,
      });
      expect(result.data.body).toHaveLength(11);
    });

    it('reads a Royal Assent version from a Private bill folder', async () => {
      http.route(
        { match: viewerUrl(13_577_949), respond: redirect(capturedRedirects.c202RoyalAssent) },
        {
          match: `${origin}${capturedRedirects.c202RoyalAssent}`,
          respond: viewerPage('viewer-C-202-royal-assent.html'),
        },
        { match: capturedXml.c202En, respond: billXml('C-202_4_E.xml') },
      );
      const result = await settle(service.getBillText('45-1', 'C-202', 13_577_949, 'en', budget));
      expect(result.data).toMatchObject({
        xmlUrl: capturedXml.c202En,
        stage: 'assented-to',
        stageDate: '2025-06-26',
        sponsor: null,
      });
      expect(result.data.body.map((section) => section.label)).toEqual(['1']);
    });

    it('starts the XML request at least 250 ms after the viewer request, on one pacer', async () => {
      const starts = new Map<string, number>();
      const timed =
        (response: () => Response): FetchMockResponder =>
        (request) => {
          starts.set(request.url, Date.now());
          return response();
        };
      routeS2({
        viewer: timed(() => redirect(capturedRedirects.s2FirstReading)),
        xml: timed(() => billXml('S-2_1_E.xml')),
      });
      await settle(readS2());
      const viewerStart = starts.get(viewerUrl(S2)) as number;
      expect((starts.get(capturedXml.s2En) as number) - viewerStart).toBeGreaterThanOrEqual(250);
    });

    it.each([
      ['a malformed session', '45-0', 'S-2', 'unknown_session'],
      ['a malformed bill code', '45-1', 'S-0', 'invalid_bill_code'],
    ])('rejects %s before any request', async (_case, session, code, reason) => {
      await expect(service.getBillText(session, code, S2, 'en', budget)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason, retryable: false },
      });
      expect(http.calls).toHaveLength(0);
    });
  });

  describe('page body', () => {
    it('cancels the page body once the export link is read', async () => {
      const page = streamedPage(s2Html);
      routeS2({ page: page.respond });
      expect((await settle(readS2())).data.body).toHaveLength(11);
      expect(page.state.cancelled).toBe(true);
      // The head holds the link; the transport's passthrough may buffer one chunk ahead of the reader.
      expect(page.state.pulls).toBeLessThanOrEqual(2);
    });

    it('cancels the page body when its export anchor has no href', async () => {
      const page = streamedPage(s2Html.replace(` href="${s2Href}"`, ''));
      routeS2({ page: page.respond });
      expect(await failure(readS2())).toMatchObject(invalid);
      expect(page.state.cancelled).toBe(true);
      expect(page.state.pulls).toBeLessThanOrEqual(2);
      expect(urls()).toEqual(s2Urls.slice(0, 2));
    });

    it("stops at the caller's cancel while the page is read, before any XML request", async () => {
      budget.dispose();
      const caller = new AbortController();
      budget = createRequestContext(createMockContext({ signal: caller.signal }));
      const page = streamedPage(s2Html.slice(0, 2_000), 'stall');
      routeS2({ page: page.respond });
      const outcome = readS2().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(page.state.pulls).toBe(2);
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(urls()).toEqual(s2Urls.slice(0, 2));
    });

    it('times out a stalled XML body within the call budget', async () => {
      routeS2({
        xml: (request) =>
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
      expect(await failure(readS2())).toMatchObject({ code: JsonRpcErrorCode.Timeout });
      expect(urls().slice(0, 3)).toEqual(s2Urls);
    });
  });

  describe('unavailable text', () => {
    it.each<[string, Parameters<typeof routeS2>[0], object, number]>([
      ['a viewer 404', { viewer: new Response('', { status: 404 }) }, noViewerPage, 1],
      [
        'a viewer redirect to its error page',
        { viewer: redirect(capturedRedirects.viewerError) },
        noViewerPage,
        1,
      ],
      [
        'a viewer redirect to the 404 error page',
        { viewer: redirect('/ErrorPage/Default.aspx?StatusCode=404') },
        noViewerPage,
        1,
      ],
      ['a page 404', { page: new Response('', { status: 404 }) }, noViewerPage, 2],
      [
        'a page redirect to the error page',
        { page: redirect(capturedRedirects.viewerError) },
        noViewerPage,
        2,
      ],
      [
        'an XML 404',
        { xml: new Response('', { status: 404 }) },
        unavailable("The publication's XML text was not found."),
        3,
      ],
      [
        'an XML redirect to the 404 error page',
        { xml: redirect(capturedRedirects.xmlError) },
        unavailable("The publication's XML text was not found."),
        3,
      ],
    ])(
      'fails %s as bill_text_unavailable without a retry',
      async (_case, replace, error, calls) => {
        routeS2(replace);
        expect(await failure(readS2())).toMatchObject(error);
        expect(urls()).toEqual(s2Urls.slice(0, calls));
      },
    );

    it.each([
      [
        'the 41-2 C-8 table-of-contents export',
        '41-2',
        'C-8',
        6_270_288,
        capturedRedirects.c8TocFirstReading,
        'viewer-41-2-C-8-toc.html',
        "The publication's XML export is a table-of-contents cover, not the bill text.",
      ],
      [
        'the 37-1 C-15A PDF-only page',
        '37-1',
        'C-15A',
        2_336_876,
        capturedRedirects.c15aRoyalAssent,
        'viewer-37-1-C-15A-pdf-only.html',
        'The publication has no XML export of its text.',
      ],
    ] as const)(
      'fails %s as bill_text_unavailable',
      async (_case, session, code, id, location, name, message) => {
        http.route(
          { match: viewerUrl(id), respond: redirect(location) },
          { match: `${origin}${location}`, respond: viewerPage(name) },
        );
        expect(await failure(service.getBillText(session, code, id, 'en', budget))).toMatchObject(
          unavailable(message),
        );
        expect(urls()).toEqual([viewerUrl(id), `${origin}${location}`]);
      },
    );

    it('retries a page that ends without an export link or publication content, never reporting no text', async () => {
      // A maintenance or challenge page served with 200 is an upstream fault, not a PDF-only version.
      routeS2({
        page: () =>
          new Response(
            '<html><head><title>Maintenance</title></head><body>Try later</body></html>',
          ),
      });
      expect(await failure(readS2())).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message:
          'LEGISinfo returned a page that ends before its publication content. (failed after 3 attempts)',
        data: { retryAttempts: 3 },
      });
      expect(urls()).toEqual([...s2Urls.slice(0, 2), ...s2Urls.slice(0, 2), ...s2Urls.slice(0, 2)]);
    });
  });

  describe('redirect and link policy', () => {
    it.each([
      ['another session', '/documentviewer/en/45-2/bill/S-2/first-reading'],
      ['another bill', '/documentviewer/en/45-1/bill/S-3/first-reading'],
      ['another language', '/documentviewer/fr/45-1/bill/S-2/first-reading'],
      ['another origin', 'https://evil.test/documentviewer/en/45-1/bill/S-2/first-reading'],
      ['plain http', 'http://www.parl.ca/documentviewer/en/45-1/bill/S-2/first-reading'],
      ['a query', '/documentviewer/en/45-1/bill/S-2/first-reading?print=1'],
      ['a fragment', '/documentviewer/en/45-1/bill/S-2/first-reading#top'],
      ['an extra segment', '/documentviewer/en/45-1/bill/S-2/first-reading/extra'],
      ['no stage', '/documentviewer/en/45-1/bill/S-2'],
      ['an encoded stage', '/documentviewer/en/45-1/bill/S-2/first%2freading'],
      [
        'credentials',
        'https://user:pass@www.parl.ca/documentviewer/en/45-1/bill/S-2/first-reading',
      ],
      ['a content path', s2Href],
      ['the error page with status 500', '/ErrorPage/Default.aspx?StatusCode=500'],
    ])('refuses a viewer redirect to %s without following it', async (_case, location) => {
      routeS2({ viewer: redirect(location) });
      expect(await failure(readS2())).toMatchObject(invalid);
      expect(urls()).toEqual([viewerUrl(S2)]);
    });

    it('accepts the viewer redirect in any case of its root and bill code', async () => {
      const location = '/DocumentViewer/en/45-1/bill/s-2/first-reading';
      http.route({
        match: `${origin}${location}`,
        respond: viewerPage('viewer-S-2-first-reading.html'),
      });
      routeS2({ viewer: redirect(location) });
      expect((await settle(readS2())).data.body).toHaveLength(11);
      expect(urls()).toEqual([viewerUrl(S2), `${origin}${location}`, capturedXml.s2En]);
    });

    it('refuses a second redirect from the page', async () => {
      routeS2({ page: redirect('/documentviewer/en/45-1/bill/S-2/third-reading') });
      expect(await failure(readS2())).toMatchObject(invalid);
      expect(urls()).toEqual(s2Urls.slice(0, 2));
    });

    it.each([
      ['another origin', 'https://evil.test/Content/Bills/451/Government/S-2/S-2_1/S-2_E.xml'],
      [
        'a protocol-relative origin',
        '//evil.test/Content/Bills/451/Government/S-2/S-2_1/S-2_E.xml',
      ],
      ['plain http', 'http://www.parl.ca/Content/Bills/451/Government/S-2/S-2_1/S-2_E.xml'],
      ['the other language', '/Content/Bills/451/Government/S-2/S-2_1/S-2_F.xml'],
      ['a path outside the bills folder', '/Other/451/S-2_E.xml'],
      ['a page-relative path', 'S-2_E.xml'],
      ['a query', `${s2Href}?v=2`],
      ['a fragment', `${s2Href}#top`],
      ['a dot segment out of the bills folder', '/Content/Bills/../Other/S-2_E.xml'],
      ['a PDF', '/Content/Bills/451/Government/S-2/S-2_1/S-2.pdf'],
      ['credentials', `https://user:pass@www.parl.ca${s2Href}`],
      ['a script URL', 'javascript:alert(1)'],
      ['an unparseable URL', 'http://['],
    ])('refuses an export link to %s without requesting it', async (_case, href) => {
      routeS2({ page: new Response(s2Html.replace(s2Href, href)) });
      expect(await failure(readS2())).toMatchObject(invalid);
      expect(urls()).toEqual(s2Urls.slice(0, 2));
    });

    it('accepts an absolute same-origin export link', async () => {
      routeS2({ page: new Response(s2Html.replace(s2Href, capturedXml.s2En)) });
      expect((await settle(readS2())).data.xmlUrl).toBe(capturedXml.s2En);
      expect(urls()).toEqual(s2Urls);
    });

    it.each([
      ['another bill version', '/Content/Bills/451/Government/S-2/S-2_2/S-2_E.xml'],
      ['the error page without a status', capturedRedirects.viewerError],
      ['the error page with status 500', '/ErrorPage/Default.aspx?StatusCode=500'],
    ])('refuses an XML redirect to %s', async (_case, location) => {
      routeS2({ xml: redirect(location) });
      expect(await failure(readS2())).toMatchObject(invalid);
      expect(urls()).toEqual(s2Urls);
    });

    it.each([
      ['the viewer', { viewer: new Response('', { status: 403 }) }, 1],
      ['the page', { page: new Response('', { status: 403 }) }, 2],
      ['the XML', { xml: new Response('', { status: 403 }) }, 3],
    ] as const)(
      'fails a 403 on %s as upstream_blocked without a retry',
      async (_case, replace, calls) => {
        routeS2(replace);
        expect(await failure(readS2())).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_blocked', source: 'legisinfo', status: 403, retryable: false },
        });
        expect(urls()).toEqual(s2Urls.slice(0, calls));
      },
    );
  });

  describe('retries', () => {
    it('retries an XML body cut before its closing element and caches the whole one', async () => {
      http.route({ match: capturedXml.s2En, once: true, respond: cutXml() });
      routeS2();
      expect((await settle(readS2())).data.body).toHaveLength(11);
      expect(urls()).toEqual([...s2Urls, capturedXml.s2En]);
      expect((await readS2()).provenance.every((source) => source.cached)).toBe(true);
      expect(http.calls).toHaveLength(4);
    });

    it('surfaces a body cut on every attempt as ServiceUnavailable and caches nothing', async () => {
      routeS2({ xml: cutXml() });
      expect(await failure(readS2())).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'The bill XML ended before its closing Bill element. (failed after 3 attempts)',
        data: { retryAttempts: 3 },
      });
      expect(urls()).toEqual([...s2Urls, capturedXml.s2En, capturedXml.s2En]);
      http.reset();
      routeS2();
      at(Date.now());
      await settle(readS2());
      expect(urls()).toEqual(s2Urls);
    });

    it('retries an HTML page served for the XML', async () => {
      http.route({
        match: capturedXml.s2En,
        once: true,
        respond: new Response('<!DOCTYPE html><html><body>Busy</body></html>'),
      });
      routeS2();
      expect((await settle(readS2())).data.body).toHaveLength(11);
      expect(urls()).toEqual([...s2Urls, capturedXml.s2En]);
    });

    it('retries a viewer 503 from the viewer request', async () => {
      http.route({ match: viewerUrl(S2), once: true, respond: new Response('', { status: 503 }) });
      routeS2();
      expect((await settle(readS2())).data.body).toHaveLength(11);
      expect(urls()).toEqual([viewerUrl(S2), ...s2Urls]);
    });

    it.each([
      [
        'a viewer 429',
        { viewer: new Response('', { status: 429 }) },
        { code: JsonRpcErrorCode.RateLimited, data: { status: 429, retryAttempts: 3 } },
        [viewerUrl(S2), viewerUrl(S2), viewerUrl(S2)],
      ],
      [
        'an XML 429',
        { xml: new Response('', { status: 429 }) },
        { code: JsonRpcErrorCode.RateLimited, data: { status: 429, retryAttempts: 3 } },
        [...s2Urls, capturedXml.s2En, capturedXml.s2En],
      ],
      [
        'a viewer 422',
        { viewer: new Response('', { status: 422 }) },
        { code: JsonRpcErrorCode.ValidationError, data: { status: 422 } },
        [viewerUrl(S2)],
      ],
      [
        'an XML 422',
        { xml: new Response('', { status: 422 }) },
        { code: JsonRpcErrorCode.ValidationError, data: { status: 422 } },
        s2Urls,
      ],
    ] as const)(
      'fails %s with its baseline code, retrying only a 429',
      async (_case, replace, error, requested) => {
        routeS2(replace);
        expect(await failure(readS2())).toMatchObject(error);
        expect(urls()).toEqual(requested);
      },
    );

    it("refuses a whole XML for another bill at the requested bill's link without retrying", async () => {
      routeS2({ xml: billXml('C-202_4_E.xml') });
      expect(await failure(readS2())).toMatchObject(invalid);
      expect(urls()).toEqual(s2Urls);
    });
  });

  describe('cache', () => {
    it('serves a repeat from the cache with original timestamps and a fresh copy each time', async () => {
      routeS2();
      const first = await settle(readS2());
      const stamps = first.provenance.map((source) => source.retrievedAt);
      first.data.body[0] = {
        ...(first.data.body[0] as BillTextDocument['body'][number]),
        text: 'x',
      };
      first.data.headings.pop();
      (first.provenance[0] as Source).url = 'mutated';
      const second = await readS2();
      expect(second.data.body[0]?.text?.split('\n')[0]).toBe(s2FirstLine);
      expect(second.data.headings).toHaveLength(2);
      expect(second.data).toMatchObject({
        publicationId: S2,
        url: viewerUrl(S2),
        xmlUrl: capturedXml.s2En,
      });
      expect(second.provenance).toEqual([
        { source: 'legisinfo', url: viewerUrl(S2), retrievedAt: stamps[0], cached: true },
        { source: 'legisinfo', url: capturedXml.s2En, retrievedAt: stamps[1], cached: true },
      ]);
      (second.data.body[0] as BillTextDocument['body'][number]).text = 'again';
      expect((await readS2()).data.body[0]?.text?.split('\n')[0]).toBe(s2FirstLine);
      expect(http.calls).toHaveLength(3);
    });

    it('expires a text 15 minutes after it was read', async () => {
      routeS2();
      const first = await settle(readS2());
      const readAt = Date.parse(first.provenance[1]?.retrievedAt as string);
      at(readAt + 900_000 - 1);
      expect((await readS2()).provenance.every((source) => source.cached)).toBe(true);
      at(readAt + 900_000);
      expect((await settle(readS2())).provenance.some((source) => source.cached)).toBe(false);
      expect(urls()).toEqual([...s2Urls, ...s2Urls]);
    });

    it('keys texts by session, bill code, publication, and language', async () => {
      const page = `${origin}${capturedRedirects.s2PremiereLecture}`;
      routeS2();
      http.route(
        { match: viewerUrl(S2, 'fr'), respond: redirect(capturedRedirects.s2PremiereLecture) },
        { match: page, respond: viewerPage('viewer-S-2-premiere-lecture.html') },
        { match: capturedXml.s2Fr, respond: billXml('S-2_1_F.xml') },
        { match: viewerUrl(13_810_695), respond: new Response('', { status: 404 }) },
      );
      await settle(readS2());
      /** Read under a fresh budget: each settle spends 20 seconds of the 50-second call clock. */
      const read = (session: string, code: string, id: number, language: 'en' | 'fr') => {
        at(Date.now());
        return service.getBillText(session, code, id, language, budget);
      };
      // The same publication under another bill or session goes to the source and fails its check.
      expect(await failure(read('45-1', 'S-3', S2, 'en'))).toMatchObject(invalid);
      expect(await failure(read('44-1', 'S-2', S2, 'en'))).toMatchObject(invalid);
      expect(await failure(read('45-1', 'S-2', 13_810_695, 'en'))).toMatchObject(noViewerPage);
      expect((await settle(read('45-1', 'S-2', S2, 'fr'))).data.language).toBe('fr');
      expect(urls()).toEqual([
        ...s2Urls,
        viewerUrl(S2),
        viewerUrl(S2),
        viewerUrl(13_810_695),
        viewerUrl(S2, 'fr'),
        page,
        capturedXml.s2Fr,
      ]);
      expect((await readS2()).provenance.every((source) => source.cached)).toBe(true);
      expect(http.calls).toHaveLength(9);
    });

    it('serves a text larger than the ceiling uncached and keeps its XML location', async () => {
      const small = new LegisinfoService(
        { userAgent: 'synthetic-test-agent' },
        new BillTextCache(4_096),
      );
      try {
        routeS2();
        const first = await settle(readS2(small));
        const second = await settle(readS2(small));
        expect(second.data.body).toHaveLength(11);
        expect(urls()).toEqual([...s2Urls, capturedXml.s2En]);
        expect(second.provenance).toEqual([
          { ...first.provenance[0], cached: true },
          {
            source: 'legisinfo',
            url: capturedXml.s2En,
            retrievedAt: expect.any(String),
            cached: false,
          },
        ]);
        // The location expires 15 minutes after the first read, not after the latest.
        at(Date.parse(first.provenance[1]?.retrievedAt as string) + 900_000);
        await settle(readS2(small));
        expect(urls()).toEqual([...s2Urls, capturedXml.s2En, ...s2Urls]);
      } finally {
        small.dispose();
      }
    });
  });
});

const source = (url: string): Source => ({
  source: 'legisinfo',
  url,
  retrievedAt: '2026-10-20T00:00:00.000Z',
  cached: false,
});
/** A synthetic parsed text whose one section holds `text`. */
const documentOf = (text: string): BillTextDocument => ({
  billCode: 'C-901',
  session: '45-1',
  language: 'en',
  longTitle: null,
  shortTitle: null,
  sponsor: null,
  stage: null,
  stageDate: null,
  introduction: {
    recommendation: null,
    summary: null,
    preamble: null,
    enactingClause: null,
    explanatoryNotes: null,
  },
  headings: [],
  body: [{ label: '1', marginalNote: null, headings: [], text, explanatoryNotes: null }],
  schedules: [],
});
const store = (cache: BillTextCache, key: string, document: BillTextDocument, ttlMs = 900_000) =>
  cache.set(key, {
    document,
    expiresAt: Date.now() + ttlMs,
    page: source(`https://www.parl.ca/DocumentViewer/en/${key}`),
    xml: source(`https://www.parl.ca/Content/Bills/${key}_E.xml`),
    xmlUrl: `https://www.parl.ca/Content/Bills/${key}_E.xml`,
  });
const textOf = (cache: BillTextCache, key: string) => cache.get(key)?.document?.body[0]?.text;
const latin = (length: number) => 'a'.repeat(length);

describe('BillTextCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('evicts the least recently used text once the ceiling is reached', () => {
    const cache = new BillTextCache(250_000);
    store(cache, 'A', documentOf(latin(100_000)));
    store(cache, 'B', documentOf(latin(100_000)));
    expect(textOf(cache, 'A')).toHaveLength(100_000);
    store(cache, 'C', documentOf(latin(100_000)));
    expect(cache.get('B')).toBeUndefined();
    expect(textOf(cache, 'A')).toHaveLength(100_000);
    expect(textOf(cache, 'C')).toHaveLength(100_000);
  });

  it('prunes expired texts before evicting a live one', () => {
    const cache = new BillTextCache(250_000);
    store(cache, 'B', documentOf(latin(100_000)));
    store(cache, 'A', documentOf(latin(100_000)), 1_000);
    vi.setSystemTime(Date.now() + 1_000);
    store(cache, 'C', documentOf(latin(100_000)));
    expect(textOf(cache, 'B')).toHaveLength(100_000);
    expect(cache.get('A')).toBeUndefined();
  });

  it('releases the bytes of a text a read finds expired', () => {
    const cache = new BillTextCache(250_000);
    store(cache, 'A', documentOf(latin(200_000)), 1_000);
    vi.setSystemTime(Date.now() + 1_000);
    expect(cache.get('A')).toBeUndefined();
    // B and C fit together only once A's 200,000 bytes are free.
    store(cache, 'B', documentOf(latin(100_000)));
    store(cache, 'C', documentOf(latin(100_000)));
    expect(textOf(cache, 'B')).toHaveLength(100_000);
    expect(textOf(cache, 'C')).toHaveLength(100_000);
  });

  it('counts a replaced entry once', () => {
    const cache = new BillTextCache(250_000);
    store(cache, 'A', documentOf(latin(100_000)));
    store(cache, 'A', documentOf(`${latin(99_999)}b`));
    store(cache, 'B', documentOf(latin(100_000)));
    expect(textOf(cache, 'A')?.at(-1)).toBe('b');
    expect(textOf(cache, 'B')).toHaveLength(100_000);
  });

  it('keeps only the location of a text larger than the whole ceiling, evicting nothing', () => {
    const cache = new BillTextCache(250_000);
    store(cache, 'A', documentOf(latin(100_000)));
    store(cache, 'X', documentOf(latin(300_000)));
    expect(cache.get('X')).toMatchObject({
      document: null,
      xmlUrl: 'https://www.parl.ca/Content/Bills/X_E.xml',
      sources: [source('https://www.parl.ca/DocumentViewer/en/X')],
    });
    expect(textOf(cache, 'A')).toHaveLength(100_000);
  });

  it('counts a text with any character outside Latin-1 at two bytes a character', () => {
    const cache = new BillTextCache(150_000);
    store(cache, 'L', documentOf(latin(100_000)));
    store(cache, 'W', documentOf(`${latin(99_999)}—`));
    expect(textOf(cache, 'L')).toHaveLength(100_000);
    expect(cache.get('W')?.document).toBeNull();
  });

  it('stores a copy its caller cannot change', () => {
    const cache = new BillTextCache(250_000);
    const document = documentOf('original');
    store(cache, 'A', document);
    (document.body[0] as BillTextDocument['body'][number]).text = 'changed';
    expect(textOf(cache, 'A')).toBe('original');
  });
});

describe('BillTextCache.set stays linear', { timeout: 0 }, () => {
  const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const cache = new BillTextCache(Number.POSITIVE_INFINITY);
  const section = {
    label: '1',
    marginalNote: null,
    headings: ['h'],
    text: 'abc',
    explanatoryNotes: null,
  };
  it.each([
    ['one Latin-1 text', (n: number) => documentOf(latin(n))],
    ['one text whose only wide character is last', (n: number) => documentOf(`${latin(n - 1)}—`)],
    [
      'many small strings',
      (n: number) => ({
        ...documentOf('x'),
        body: Array.from({ length: n / 8 }, () => ({ ...section })),
      }),
    ],
    ['one long line ending in a break', (n: number) => documentOf(`${'§1 x'.repeat(n / 4)}\ny`)],
    ['line breaks throughout', (n: number) => documentOf('  \r\n'.repeat(n / 4))],
  ])('on %s', (_shape, build) =>
    expectLinearCpu((document: BillTextDocument) => store(cache, 'A', document), build, sizes),
  );
});
