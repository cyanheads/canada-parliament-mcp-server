/**
 * @fileoverview Complete-session and sponsor-intersection bill tool contracts.
 * @module tests/tools/search-bills.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchBillsTool } from '@/mcp-server/tools/definitions/search-bills.tool.js';
import {
  assertDomainParity,
  assertError,
  current,
  expectedText,
  listing,
  parseMarkdown,
  rawBill,
  sessions,
  settle,
  setup,
  teardown,
} from '../fixtures/bill-tools/harness.js';

const rows = [
  rawBill('S-20', { OriginatingChamberNameEn: 'Senate' }),
  rawBill('C-10'),
  rawBill('C-2'),
  rawBill('C-8', {
    LongTitleEn: 'Other subject',
    LongTitleFr: null,
    ShortTitleEn: null,
    ShortTitleFr: null,
    StatusNameEn: 'Historical synthetic stage',
    BillDocumentTypeNameEn: 'Historical synthetic type',
  }),
];
const profile = 'https://api.openparliament.ca/politicians/synthetic-member/';
const hint =
  'Call canparl_list_reference with topic bill_types or bill_statuses, then retry canparl_search_bills with a listed value.';

describe('canparl_search_bills production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
    sessions(http);
  });
  afterEach(() => teardown(http));
  const feed = (data = rows) => http.route({ match: listing(), respond: Response.json(data) });
  const call = (input: Record<string, unknown> = {}) =>
    settle(runToolContract(searchBillsTool, input));
  const sponsor = (pages: string[][], continuation = false) => {
    http.route({
      match: profile,
      respond: Response.json({ url: '/politicians/synthetic-member/', name: 'Synthetic Member' }),
    });
    http.route({
      match: (request) => new URL(request.url).pathname === '/bills/',
      respond: (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('sponsor_politician')).toBe('/politicians/synthetic-member/');
        expect(url.searchParams.get('session')).toBe('45-1');
        expect(url.searchParams.get('limit')).toBe('100');
        const offset = Number(url.searchParams.get('offset'));
        const index = offset / 100;
        const next = index + 1 < pages.length || continuation;
        const nextUrl = new URL(url);
        nextUrl.searchParams.set('offset', String(offset + 100));
        return Response.json({
          objects: (pages[index] ?? []).map((code) => ({
            session: '45-1',
            number: code,
            url: `/bills/45-1/${code}/`,
          })),
          pagination: { offset, limit: 100, next_url: next ? nextUrl.href : null },
        });
      },
    });
  };
  function check(result: Awaited<ReturnType<typeof call>>) {
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    // The body is checked separately so trailer presentation cannot hide domain rows.
    const body = result.content.find((block) => block.type === 'text');
    expect(body?.type).toBe('text');
    const parsedBody = searchBillsTool.output.parse(structured);
    assertDomainParity(parsedBody, searchBillsTool.format!(parsedBody));
    assertDomainParity(parsedBody, [body!]);
    const enrichment = searchBillsTool.enrichment;
    if (!enrichment) throw new Error('Missing declared enrichment');
    for (const [key, schema] of Object.entries(enrichment)) schema.parse(structured[key]);
    const trailer = parseMarkdown(
      result.content
        .slice(1)
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    ).text;
    expect(trailer).toContain(expectedText(structured.appliedFilters, 'appliedFilters'));
    for (const key of ['shown', 'cap', 'truncated'])
      expect(trailer).toContain(`${key}: ${String(structured[key])}`);
    expect(trailer).toContain(`${String(structured.totalCount)} total`);
    if (structured.notice) expect(trailer).toContain(structured.notice);
    expect(structured.totalCount).toBe(parsedBody.total);
    expect(structured.shown).toBe(parsedBody.bills.length);
    expect(structured.cap).toBe(parsedBody.pagination.limit);
    expect(structured.truncated).toBe(parsedBody.pagination.hasMore);
    return structured;
  }

  it('resolves current from the source and sorts numbers numerically before paginating', async () => {
    http.route({ match: current, respond: Response.json([rawBill()]) });
    feed();
    const result = await call({ limit: 2 });
    check(result);
    expect(result.structuredContent).toMatchObject({
      session: '45-1',
      total: 4,
      bills: [{ billCode: 'C-2' }, { billCode: 'C-8' }],
      pagination: { offset: 0, limit: 2, nextOffset: 2, hasMore: true },
      sponsorCoverage: 'not_applied',
    });
    expect(http.calls.map((c) => c.request.url)).toEqual([
      current,
      'https://www.parl.ca/legisinfo/en/bills',
      listing(),
    ]);
  });
  it('applies every filter together, aliases values, and computes totals before slicing', async () => {
    feed();
    sponsor([
      ['C-2', 'C-10'],
      ['S-20', 'C-999'],
    ]);
    const result = await call({
      session: { parliament: 45, session: 1 },
      query: '  MARINE  ',
      billCode: 'bill c10',
      originatingChamber: ' house OF commons ',
      billType: ' government   bill ',
      status: ' at second reading in the house of commons ',
      sponsor: 'https://openparliament.ca/politicians/synthetic-member/',
      limit: 1,
    });
    check(result);
    expect(result.structuredContent).toMatchObject({
      total: 1,
      bills: [{ billCode: 'C-10' }],
      pagination: { nextOffset: null, hasMore: false },
      sponsorCoverage: 'openparliament_index',
    });
    expect(http.calls.filter((c) => new URL(c.request.url).pathname === '/bills/')).toHaveLength(2);
    expect(JSON.stringify(result.structuredContent)).toContain('appliedFilters');
    expect(
      parseMarkdown(
        result.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
      ).text,
    ).toContain('synthetic-member');
  });
  it.each([
    [{ limit: 4 }, 4, 4, false, null],
    [{ limit: 10 }, 4, 4, false, null],
    [{ limit: 2, offset: 2 }, 4, 2, false, null],
    [{ offset: 10 }, 4, 0, false, null],
    [{ titleContains: 'absent' }, 0, 0, false, null],
  ])(
    'keeps exact totals and honest continuation for %j',
    async (input, total, shown, hasMore, nextOffset) => {
      feed();
      const result = await call({ session: '045-01', ...input });
      check(result);
      expect(result.structuredContent).toMatchObject({
        total,
        pagination: { hasMore, nextOffset },
      });
      expect((result.structuredContent as { bills: unknown[] }).bills).toHaveLength(shown);
      if ('offset' in input && input.offset === 10)
        expect(JSON.stringify(result.structuredContent)).toContain('past the matching bills');
      if (total === 0)
        expect(JSON.stringify(result.structuredContent)).toContain('No bills matched');
    },
  );
  it.each(['LongTitleEn', 'LongTitleFr', 'ShortTitleEn', 'ShortTitleFr'])(
    'matches a literal Unicode title in %s',
    async (field) => {
      feed([
        rawBill('C-11', {
          LongTitleEn: null,
          LongTitleFr: null,
          ShortTitleEn: null,
          ShortTitleFr: null,
          [field]: 'Préfixe ÉCOLE [x].* suffixe',
        }),
      ]);
      const result = await call({ session: '45-1', titleContains: 'e\u0301cole [x].*' });
      check(result);
      expect(result.structuredContent).toMatchObject({ total: 1 });
    },
  );
  it('treats optional blanks as unset and uses session-observed vocabulary', async () => {
    feed();
    const blanks = await call({
      session: '45-1',
      titleContains: ' ',
      billCode: '',
      originatingChamber: '\t',
      billType: '',
      status: ' ',
      sponsor: '',
    });
    check(blanks);
    expect(blanks.structuredContent).toMatchObject({ total: 4 });
    const historical = await call({
      session: '45-1',
      billType: 'historical synthetic TYPE',
      status: 'Historical Synthetic Stage',
    });
    check(historical);
    expect(historical.structuredContent).toMatchObject({ total: 1, bills: [{ billCode: 'C-8' }] });
  });
  it('recognizes known vocabulary even when no source row currently matches', async () => {
    feed([]);
    const result = await call({ session: '45-1', billType: 'House Government Bill' });
    check(result);
    expect(result.structuredContent).toMatchObject({ total: 0, bills: [] });
  });
  it.each([
    [{ originatingChamber: 'senate' }, ['S-20']],
    [{ billCode: 'c2' }, ['C-2']],
    [{ titleContains: 'marine', originatingChamber: 'Senate', billCode: 'C-2' }, []],
    [{ status: 'Royal assent received' }, []],
    [{ billType: 'Private Member\u0027s Bill' }, []],
  ])('combines independent filters with AND for %j', async (input, codes) => {
    feed();
    const result = await call({ session: '45-1', ...input });
    check(result);
    expect(
      (result.structuredContent as { bills: { billCode: string }[] }).bills.map((b) => b.billCode),
    ).toEqual(codes);
    expect(result.structuredContent).toMatchObject({ total: codes.length });
  });
  it('uses an explicitly selected historical session without consulting current', async () => {
    http.route({
      match: listing('35-2'),
      respond: Response.json([rawBill('S-9', { ParliamentNumber: 35, SessionNumber: 2 })]),
    });
    const result = await call({ session: '035-02' });
    check(result);
    expect(result.structuredContent).toMatchObject({
      session: '35-2',
      total: 1,
      bills: [{ session: '35-2', billCode: 'S-9' }],
    });
    expect(http.calls.map((c) => c.request.url)).not.toContain(current);
  });
  it('returns all one hundred rows at the allowed cap without a hidden display limit', async () => {
    feed(Array.from({ length: 100 }, (_, i) => rawBill(`C-${100 - i}`)));
    const result = await call({ session: '45-1', limit: 100 });
    check(result);
    expect(result.structuredContent).toMatchObject({
      total: 100,
      shown: 100,
      cap: 100,
      truncated: false,
      pagination: { hasMore: false, nextOffset: null },
    });
  });
  it.each([
    { billCode: 'C-0' },
    { originatingChamber: 'Assembly' },
    { billType: 'not a known type' },
    { status: 'imaginary stage' },
  ])('returns declared filter recovery for %j', async (input) => {
    feed();
    assertError(
      await call({ session: '45-1', ...input }),
      'invalid_bill_filter',
      JsonRpcErrorCode.ValidationError,
      hint,
    );
  });
  it('returns declared unknown-session recovery without requesting its feed', async () => {
    assertError(
      await call({ session: '46-1' }),
      'unknown_session',
      JsonRpcErrorCode.ValidationError,
      'Call canparl_list_reference with topic sessions and choose a listed bill session.',
    );
    expect(http.calls).toHaveLength(1);
  });
  it('verifies sponsor existence before requesting any indexed bills', async () => {
    feed();
    http.route({ match: profile, respond: new Response('', { status: 404 }) });
    assertError(
      await call({ session: '45-1', sponsor: 'synthetic-member' }),
      'sponsor_not_found',
      JsonRpcErrorCode.NotFound,
      'Call canparl_search_members with a name and use its verified OpenParliament slug.',
    );
    expect(http.calls.some((c) => new URL(c.request.url).pathname === '/bills/')).toBe(false);
  });
  it('intersects the complete sponsor index while disclosing subset coverage', async () => {
    feed();
    sponsor([['C-999'], ['C-10', 'S-20']]);
    const result = await call({
      session: '45-1',
      sponsor: '/politicians/synthetic-member/',
      limit: 1,
    });
    check(result);
    expect(result.structuredContent).toMatchObject({
      total: 2,
      bills: [{ billCode: 'C-10' }],
      pagination: { hasMore: true, nextOffset: 1 },
    });
    expect(JSON.stringify(result.structuredContent)).toContain('does not index Senators');
  });
  it('fails after ten complete 100-row sponsor pages rather than inventing a total', async () => {
    feed();
    sponsor(
      Array.from({ length: 10 }, (_, p) =>
        Array.from({ length: 100 }, (_, i) => `C-${p * 100 + i + 1}`),
      ),
      true,
    );
    assertError(
      await call({ session: '45-1', sponsor: 'synthetic-member' }),
      'sponsor_scan_incomplete',
      JsonRpcErrorCode.ServiceUnavailable,
      'Call canparl_search_bills without sponsor and inspect a specific result with canparl_get_bill.',
    );
    expect(http.calls.filter((c) => new URL(c.request.url).pathname === '/bills/')).toHaveLength(
      10,
    );
  });
  it('fails required sponsor work at its deadline instead of returning a partial total', async () => {
    feed();
    http.route({
      match: profile,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const outcome = runToolContract(searchBillsTool, {
      session: '45-1',
      sponsor: 'synthetic-member',
    });
    await vi.advanceTimersByTimeAsync(45_001);
    const result = await outcome;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
    expect(result.structuredContent).not.toHaveProperty('total');
    expect(
      result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    ).toMatch(/deadline|tim(?:e|ed)/i);
    const count = http.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.calls).toHaveLength(count);
  });
  it('stops a required source fetch on caller cancellation on both error surfaces', async () => {
    const caller = new AbortController();
    http.route({
      match: listing(),
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const outcome = runToolContract(
      searchBillsTool,
      { session: '45-1' },
      { context: { signal: caller.signal } },
    );
    await vi.advanceTimersByTimeAsync(300);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const result = await outcome;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(
      result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    ).toMatch(/cancel/i);
    const count = http.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.calls).toHaveLength(count);
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { session: { parliament: 45, session: 0 } },
  ])('rejects invalid schema input before HTTP %j', async (input) => {
    const result = await call(input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });
});
