/** @fileoverview Bounded speech scanning and historical attribution contracts. @module tests/tools/search-speeches.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchSpeechesTool } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import {
  actor,
  api,
  bill,
  failure,
  member,
  membership,
  pages,
  parity,
  profile,
  settle,
  setup,
  speech,
  teardown,
} from '../fixtures/speech-tools/harness.js';

describe('canparl_search_speeches production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
  });
  afterEach(() => teardown(http));
  const call = (input: Record<string, unknown> = {}) =>
    settle(runToolContract(searchSpeechesTool, input));
  const success = async (input: Record<string, unknown> = {}) =>
    parity(await call({ dateFrom: '2026-10-19', ...input }), searchSpeechesTool);
  const fail = async (input: Record<string, unknown>, reason: string) =>
    failure(
      await call(input),
      searchSpeechesTool.errors!.find((error) => error.reason === reason)!,
    );
  it('intersects normalized speaker, both identical bills, dates, and literal English text', async () => {
    profile(http);
    bill(http);
    pages(http, [speech(1, { politician_membership_url: member })], {
      politician: actor,
      bill_debated: '/bills/45-1/S-321/',
      mentioned_bill: '/bills/45-1/S-321/',
      time__gte: '2026-10-19',
      time__lt: '2026-10-20',
    });
    http.route({ match: `${api}${member}`, respond: Response.json(membership()) });
    const data = await success({
      politician: ' https://openparliament.ca/politicians/river-example/ ',
      billDebated: { session: '045-01', code: ' bill s321 ' },
      mentionedBill: { session: { parliament: 45, session: 1 }, code: 'S321' },
      dateTo: '2026-10-19',
      contains: ' e\u0301cole [x].* ',
    });
    expect(data).toMatchObject({
      scanned: 1,
      exhausted: true,
      nextOffset: null,
      shown: 1,
      cap: 5,
      truncated: false,
      excludedCommittees: 0,
      speeches: [
        {
          party: 'Historical [party]',
          riding: 'Old riding\n第二行',
          content: 'École [x].* & 中文\nnext line\n\n# heading\r\n``` fence',
          time: '2026-10-19 23:59:59',
        },
      ],
      appliedFilters: { politician: 'river-example', contains: 'e\u0301cole [x].*' },
    });
    expect(http.calls).toHaveLength(4);
  });
  it('validates distinct bill identities once each', async () => {
    bill(http);
    bill(http, 'C-19');
    pages(http, [], { bill_debated: '/bills/45-1/S-321/', mentioned_bill: '/bills/45-1/C-19/' });
    parity(
      await call({
        billDebated: { session: '45-1', code: 's321' },
        mentionedBill: { session: '45-1', code: 'c19' },
      }),
      searchSpeechesTool,
    );
    expect(http.calls).toHaveLength(3);
  });
  it.each([{ dateFrom: '2026-10-19' }, { dateTo: '2026-10-19' }])(
    'supports independent date bound %j',
    async (input) => {
      pages(
        http,
        [speech()],
        'dateFrom' in input ? { time__gte: '2026-10-19' } : { time__lt: '2026-10-20' },
      );
      const data = parity(await call(input), searchSpeechesTool);
      expect(data.scanned).toBe(1);
    },
  );
  it.each([0, 2, 5, 10])('discloses terminal pages at %i matches', async (count) => {
    pages(
      http,
      Array.from({ length: count }, (_, i) => speech(i)),
      { time__gte: '2026-10-19' },
    );
    expect(await success({ limit: count || 5 })).toMatchObject({
      scanned: count,
      shown: count,
      exhausted: true,
      nextOffset: null,
      truncated: false,
    });
  });
  it('keeps raw mid-page continuation and consumes the remainder with identical filters', async () => {
    pages(
      http,
      Array.from({ length: 8 }, (_, i) => speech(i)),
      { time__gte: '2026-10-19' },
    );
    expect(await success({ limit: 5 })).toMatchObject({
      scanned: 5,
      nextOffset: 5,
      exhausted: false,
    });
    expect(await success({ limit: 5, offset: 5 })).toMatchObject({
      scanned: 3,
      nextOffset: null,
      exhausted: true,
      speeches: [{ id: '5' }, { id: '6' }, { id: '7' }],
    });
  });
  it.each([true, false])(
    'scans at most 100 unmatched candidates, terminal=%s',
    async (terminal) => {
      pages(
        http,
        Array.from({ length: 100 }, (_, i) =>
          speech(i, { politician_membership_url: `/politicians/memberships/${i + 1}/` }),
        ),
        { time__gte: '2026-10-19' },
        terminal,
      );
      const data = await success({ contains: 'never present' });
      expect(data).toMatchObject({
        speeches: [],
        scanned: 100,
        exhausted: terminal,
        nextOffset: terminal ? null : 100,
        truncated: !terminal,
      });
      expect(data.notice).toContain(terminal ? 'does not establish' : 'identical filters');
      expect(http.calls).toHaveLength(5);
    },
  );
  it('uses next_url rather than short page length to establish exhaustion', async () => {
    pages(http, [speech()], { time__gte: '2026-10-19' }, false);
    expect(await success({ limit: 1 })).toMatchObject({
      scanned: 1,
      exhausted: false,
      nextOffset: 20,
    });
  });
  it('returns empty past-end source page without inventing totals', async () => {
    pages(http, [speech()], { time__gte: '2026-10-19' });
    expect(await success({ offset: 200 })).toMatchObject({
      speeches: [],
      scanned: 0,
      exhausted: true,
      nextOffset: null,
    });
  });
  it('excludes committees and missing documents while preserving institutional and missing-body rows', async () => {
    pages(
      http,
      [
        speech(1, { document_url: '/committees/finance/1/' }),
        speech(2, { url: '/committees/finance/2/' }),
        speech(3, { document_url: null }),
        speech(4, {
          politician_url: null,
          content: { fr: 'French only phrase' },
          h1: null,
          h2: null,
          attribution: null,
        }),
      ],
      { time__gte: '2026-10-19' },
    );
    expect(await success()).toMatchObject({
      scanned: 4,
      excludedCommittees: 3,
      speeches: [{ id: '4', content: null, politician: null, party: null, riding: null }],
    });
    expect(await success({ contains: 'French only phrase' })).toMatchObject({
      speeches: [],
      scanned: 4,
    });
  });
  it('allows procedural records only when explicitly requested and omits blank filters', async () => {
    pages(http, [speech(1, { procedural: true })], {
      time__gte: '2026-10-19',
      procedural: undefined,
    });
    const data = await success({
      substantiveOnly: false,
      politician: ' ',
      dateTo: '',
      contains: '',
    });
    expect(data).toMatchObject({
      shown: 1,
      appliedFilters: { substantiveOnly: false, contains: null, politician: null, dateTo: null },
    });
  });
  it.each([{}, { contains: 'something' }, { politician: ' ', dateFrom: '', dateTo: ' ' }])(
    'requires a nonblank scope %j',
    async (input) => {
      await fail(input, 'speech_scope_required');
      expect(http.calls).toHaveLength(0);
    },
  );
  it.each([
    { politician: 'First Last' },
    { politician: 'https://evil.test/politicians/river-example/' },
    { billDebated: {} },
    { billDebated: { session: '45-1', code: '' } },
    { mentionedBill: { session: '45-1', code: 'C-0' } },
    { dateFrom: '2026-02-30' },
    { dateTo: '9999-12-31' },
    { dateFrom: '2026-10-20', dateTo: '2026-10-19' },
  ])('returns invalid filter recovery %j', async (input) => {
    await fail(input, 'invalid_speech_filter');
    expect(http.calls).toHaveLength(0);
  });
  it.each([{ politician: 'river-example' }, { billDebated: { session: '45-1', code: 'S321' } }])(
    'maps absent scope entity %j',
    async (input) => {
      http.route({ match: () => true, respond: new Response('missing', { status: 404 }) });
      await fail(input, 'speech_entity_not_found');
      expect(http.calls).toHaveLength(1);
    },
  );
  it.each([
    { limit: 0 },
    { limit: 11 },
    { offset: -1 },
    { billDebated: { session: '45-1', code: 'S321', other: true } },
  ])('rejects schema-invalid input %j', async (input) => {
    expect((await call(input)).structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });
  it.each([
    { procedural: true },
    { procedural: null },
    { time: '2026-10-18 23:59:59' },
    { time: '2026-10-20 00:00:00' },
    { politician_url: '/politicians/different-person/' },
  ])('fails closed for ignored upstream filters %j', async (extra) => {
    profile(http);
    pages(http, [speech(1, extra)], {
      politician: actor,
      time__gte: '2026-10-19',
      time__lt: '2026-10-20',
    });
    await fail(
      { politician: 'river-example', dateFrom: '2026-10-19', dateTo: '2026-10-19' },
      'upstream_filter_not_honored',
    );
  });
  it.each([
    { start_date: '2026-10-20' },
    { end_date: '2026-10-18' },
    { start_date: null },
    { politician_url: '/politicians/different-person/' },
  ])('does not substitute current affiliation for invalid membership %j', async (extra) => {
    pages(http, [speech(1, { politician_membership_url: member })], { time__gte: '2026-10-19' });
    http.route({ match: `${api}${member}`, respond: Response.json(membership(extra)) });
    expect(await success()).toMatchObject({
      speeches: [{ party: null, riding: null }],
      notice: expect.stringContaining('unavailable'),
    });
  });
  it('deduplicates only returned memberships, not every scanned candidate', async () => {
    pages(
      http,
      [
        speech(1, {
          content: { en: 'ignore' },
          politician_membership_url: '/politicians/memberships/902/',
        }),
        speech(2, { politician_membership_url: member }),
        speech(3, { politician_membership_url: member }),
      ],
      { time__gte: '2026-10-19' },
    );
    http.route({ match: `${api}${member}`, respond: Response.json(membership()) });
    expect(await success({ contains: 'École' })).toMatchObject({ shown: 2, scanned: 3 });
    expect(http.calls).toHaveLength(2);
  });
  it.each([404, 503, 429])(
    'preserves speeches when optional affiliation returns %i',
    async (status) => {
      pages(http, [speech(1, { politician_membership_url: member })], { time__gte: '2026-10-19' });
      http.route({ match: `${api}${member}`, respond: new Response('unavailable', { status }) });
      expect(await success()).toMatchObject({
        speeches: [{ party: null, riding: null }],
        notice: expect.stringContaining('SourceUnavailable'),
      });
    },
  );
  it('honors caller cancellation during membership without a partial success', async () => {
    const caller = new AbortController();
    pages(http, [speech(1, { politician_membership_url: member })], { time__gte: '2026-10-19' });
    http.route({
      match: `${api}${member}`,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
          caller.abort();
        }),
    });
    const result = await settle(
      runToolContract(
        searchSpeechesTool,
        { dateFrom: '2026-10-19' },
        { context: { signal: caller.signal } },
      ),
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('cancel') }),
      ]),
    );
    expect(http.calls).toHaveLength(2);
  });
  it('hydrates at most ten distinct returned memberships within the shared cold budget', async () => {
    pages(
      http,
      Array.from({ length: 10 }, (_, i) =>
        speech(i, { politician_membership_url: `/politicians/memberships/${i + 1}/` }),
      ),
      { time__gte: '2026-10-19' },
    );
    http.route({
      match: (request) => new URL(request.url).pathname.startsWith('/politicians/memberships/'),
      respond: (request) => Response.json(membership({ url: new URL(request.url).pathname })),
    });
    expect(await success({ limit: 10 })).toMatchObject({ shown: 10, scanned: 10, exhausted: true });
    expect(http.calls).toHaveLength(11);
  });
  it('returns speeches when only the optional 45 second child budget expires', async () => {
    pages(
      http,
      Array.from({ length: 10 }, (_, i) =>
        speech(i, { politician_membership_url: `/politicians/memberships/${i + 1}/` }),
      ),
      { time__gte: '2026-10-19' },
    );
    http.route({
      match: (request) => new URL(request.url).pathname.startsWith('/politicians/memberships/'),
      respond: (request) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(Response.json(membership({ url: new URL(request.url).pathname }))),
            6_000,
          );
          request.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(request.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const pending = runToolContract(searchSpeechesTool, { dateFrom: '2026-10-19', limit: 10 });
    await vi.advanceTimersByTimeAsync(45_001);
    const data = parity(await pending, searchSpeechesTool);
    expect(data).toMatchObject({ shown: 10, notice: expect.stringContaining('Timeout') });
    const callsAtDeadline = http.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.calls).toHaveLength(callsAtDeadline);
  });
  it('fails required scans on budget exhaustion rather than returning a negative result', async () => {
    http.route({
      match: (request) => new URL(request.url).pathname === '/speeches/',
      respond: (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          }),
        ),
    });
    const pending = runToolContract(searchSpeechesTool, { dateFrom: '2026-10-19' });
    await vi.advanceTimersByTimeAsync(50_001);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
  });
  it('keeps complete long prose and stops at ten matches before the source page ends', async () => {
    const prose = 'École 中文 [literal].*\n'.repeat(800);
    pages(
      http,
      Array.from({ length: 20 }, (_, i) => speech(i, { content: { en: prose } })),
      { time__gte: '2026-10-19' },
    );
    const data = await success({ limit: 10 });
    expect(data).toMatchObject({
      shown: 10,
      scanned: 10,
      exhausted: false,
      nextOffset: 10,
      truncated: true,
    });
    expect((data.speeches as { content: string }[]).every((row) => row.content === prose)).toBe(
      true,
    );
    expect(http.calls).toHaveLength(1);
  });
  it('never turns outer deadline expiry during optional membership into partial success', async () => {
    pages(http, [speech(1, { politician_membership_url: member })], { time__gte: '2026-10-19' });
    http.route({
      match: `${api}${member}`,
      respond: () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(Response.json(membership())), 51_000),
        ),
    });
    const pending = runToolContract(searchSpeechesTool, { dateFrom: '2026-10-19' });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('50 second') }),
      ]),
    );
    expect(http.calls).toHaveLength(2);
  });
});
