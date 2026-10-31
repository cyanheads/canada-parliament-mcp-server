/**
 * @fileoverview Complete-session and sponsor-intersection bill tool contracts.
 * @module tests/tools/search-bills.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILL_STATUSES, BILL_TYPES } from '@/domain/reference-catalog.js';
import { searchBillsTool } from '@/mcp-server/tools/definitions/search-bills.tool.js';
import { disposeOurCommonsService, initOurCommonsService } from '@/services/ourcommons/index.js';
import {
  assertDomainParity,
  assertError,
  assertMeasuredResponse,
  current,
  expectExact,
  listing,
  parseMarkdown,
  rawBill,
  sessions,
  settle,
  setup,
  teardown,
  trailerFields,
} from '../fixtures/bill-tools/harness.js';
import {
  assertArgumentRejection,
  assertFilterRejection,
  type FilterRejection,
} from '../fixtures/filter-rejection.js';
import { collection, rawPerson, rosterUrl } from '../fixtures/vote-tools/harness.js';

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
  "Retry canparl_search_bills with a value or shape the error names; canparl_list_reference topics bill_types and bill_statuses list types and statuses, and a sponsor is member.slug from canparl_get_member, a slug from an includeFormer canparl_search_members row, or a current MP's personId.";

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
    expectExact(trailerFields(result.content.slice(1)).appliedFilters, structured.appliedFilters);
    for (const key of ['shown', 'cap', 'truncated'])
      expect(trailer).toContain(`${key}: ${String(structured[key])}`);
    expect(trailer).toContain(`totalCount: ${String(structured.totalCount)}`);
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
  it.each([1500, 15000])(
    'fits whole bill records with repeated %i-character titles',
    async (size) => {
      const title = 'é'.repeat(size);
      feed(Array.from({ length: 8 }, (_, i) => rawBill(`C-${i + 1}`, { LongTitleEn: title })));
      const ids: string[] = [];
      let offset: number | null = 0;
      let pages = 0;
      do {
        const result = await call({ session: '45-1', limit: 10_000, offset });
        expect(result.isError).not.toBe(true);
        const data = result.structuredContent as {
          bills: { billCode: string; longTitle: { en: string } }[];
          pagination: { nextOffset: number | null };
        };
        const bytes = assertMeasuredResponse(result, searchBillsTool, data.bills);
        check(result);
        expect(data.bills.length).toBeGreaterThan(0);
        expect(result.structuredContent).toMatchObject({
          total: 8,
          cap: 100,
          notice: expect.stringContaining('maximum of 100'),
        });
        for (const row of data.bills) expect(row.longTitle.en).toBe(title);
        if (bytes > 24_000)
          expect(result.structuredContent).toMatchObject({
            shown: 1,
            notice: expect.stringContaining('exceeds'),
          });
        ids.push(...data.bills.map((row) => row.billCode));
        offset = data.pagination.nextOffset;
        if (offset !== null) expect(offset).toBe(ids.length);
        expect(++pages).toBeLessThanOrEqual(8);
      } while (offset !== null);
      expect(pages).toBeGreaterThan(1);
      expect(ids).toEqual(Array.from({ length: 8 }, (_, i) => `C-${i + 1}`));
    },
  );
  it.each([
    ['House', 'C-901'],
    ['Senate', 'S-902'],
  ])('filters explicit chamber evidence for %s', async (chamber, code) => {
    feed([
      rawBill('C-901', {
        OriginatingChamberNameEn: null,
        IsHouseBill: true,
        IsSenateBill: false,
        OriginatingChamberOrganizationId: 1,
      }),
      rawBill('S-902', {
        OriginatingChamberNameEn: null,
        IsHouseBill: false,
        IsSenateBill: true,
        OriginatingChamberOrganizationId: 2,
      }),
    ]);
    const reply = await call({ session: '45-1', originatingChamber: chamber });
    check(reply);
    expect(reply.structuredContent).toMatchObject({
      total: 1,
      bills: [{ billCode: code, originatingChamber: chamber }],
    });
  });
  it('reports the latest major stage chamber from the list organization ID', async () => {
    feed([
      rawBill('C-15', {
        LatestCompletedMajorStageNameEn: 'Royal assent',
        LatestCompletedMajorStageChamberNameEn: null,
        LatestCompletedMajorStageChamberOrganizationId: 2,
      }),
      rawBill('S-3', {
        OriginatingChamberNameEn: 'Senate',
        LatestCompletedMajorStageChamberNameEn: null,
        LatestCompletedMajorStageChamberOrganizationId: 1,
      }),
    ]);
    const reply = await call({ session: '45-1' });
    check(reply);
    expect(
      (reply.structuredContent as { bills: { latestMajorStage: unknown }[] }).bills.map(
        (bill) => bill.latestMajorStage,
      ),
    ).toEqual([
      { name: 'Royal assent', chamber: 'Senate' },
      { name: 'First reading', chamber: 'House' },
    ]);
  });
  it('reports list royal assent values as the UTC instants of their Ottawa clocks', async () => {
    feed([
      rawBill('C-15', { ReceivedRoyalAssentDateTime: '2026-03-26T06:50:00-04:00' }),
      rawBill('C-2', { ReceivedRoyalAssentDateTime: '1997-12-17T19:00:00-05:00' }),
    ]);
    const reply = await call({ session: '45-1' });
    check(reply);
    expect(reply.structuredContent).toMatchObject({
      bills: [
        { billCode: 'C-2', royalAssentDate: '1997-12-18T05:00:00Z' },
        { billCode: 'C-15', royalAssentDate: '2026-03-26T14:50:00Z' },
      ],
    });
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
  it('matches a title typed without its accents or with other apostrophes, returning it as published', async () => {
    const title = "Loi sur l'unit\u00e9 de l'\u00e9conomie canadienne";
    feed([
      rawBill('C-5', { ShortTitleFr: title }),
      rawBill('C-6', { ShortTitleFr: "Loi sur l'unit\u00e9 de la recherche" }),
    ]);
    const typed = 'loi sur l\u2019unite  de l\u2019economie';
    const result = await call({ session: '45-1', titleContains: typed });
    check(result);
    expect(result.structuredContent).toMatchObject({
      total: 1,
      bills: [{ billCode: 'C-5', shortTitle: { fr: title } }],
      appliedFilters: { titleContains: typed },
    });
  });
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
    [{ billCode: 'C 2' }, ['C-2']],
    [{ billCode: 'bill c–10' }, ['C-10']],
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
  const split = [
    rawBill('C-16'),
    rawBill('C-15B'),
    rawBill('C-15'),
    rawBill('S-1', { OriginatingChamberNameEn: 'Senate' }),
    rawBill('C-15A'),
    rawBill('C-2'),
  ];
  const codes = (result: Awaited<ReturnType<typeof call>>) =>
    (result.structuredContent as { bills: { billCode: string }[] }).bills.map((b) => b.billCode);
  it.each([
    [{}, ['C-2', 'C-15', 'C-15A', 'C-15B', 'C-16', 'S-1'], 2],
    [{ limit: 2, offset: 2 }, ['C-15A', 'C-15B'], 4],
    [{ limit: 2, offset: 4 }, ['C-16', 'S-1'], null],
  ])(
    'orders split bills after their base number and before the next, %j',
    async (input, expected, nextOffset) => {
      feed(split);
      const result = await call({ session: '45-1', ...input });
      check(result);
      expect(codes(result)).toEqual(expected);
      expect(result.structuredContent).toMatchObject({
        total: 6,
        pagination: {
          nextOffset: 'limit' in input ? nextOffset : null,
          hasMore: 'limit' in input && nextOffset !== null,
        },
      });
    },
  );
  it.each(['c-15a', 'C 15A', 'bill c15a', 'C–15A'])(
    'filters split bill code %j exactly',
    async (billCode) => {
      feed(split);
      const result = await call({ session: '45-1', billCode });
      check(result);
      expect(codes(result)).toEqual(['C-15A']);
      expect(result.structuredContent).toMatchObject({ appliedFilters: { billCode: 'C-15A' } });
    },
  );
  it('intersects split-bill sponsor rows by their exact suffixed code', async () => {
    feed(split);
    sponsor([['C-15A', 'C-16']]);
    const result = await call({ session: '45-1', sponsor: 'synthetic-member' });
    check(result);
    expect(codes(result)).toEqual(['C-15A', 'C-16']);
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
  it('returns 10 rows by default inside the byte budget that ends an explicit 25-row page', async () => {
    feed(Array.from({ length: 30 }, (_, i) => rawBill(`C-${i + 1}`)));
    const byDefault = check(await call({ session: '45-1' }));
    expect(byDefault).toMatchObject({
      totalCount: 30,
      shown: 10,
      cap: 10,
      truncated: true,
      pagination: { offset: 0, limit: 10, nextOffset: 10, hasMore: true },
    });
    expect(byDefault.notice).toBeUndefined();
    expect(check(await call({ session: '45-1', limit: 25 }))).toMatchObject({
      shown: 21,
      cap: 25,
      pagination: { limit: 25, nextOffset: 21 },
      notice: expect.stringContaining('24000-byte response budget'),
    });
  });
  it('preserves the 100-row cap while applying the disclosed byte budget', async () => {
    feed(Array.from({ length: 100 }, (_, i) => rawBill(`C-${100 - i}`)));
    const result = await call({ session: '45-1', limit: 100 });
    check(result);
    expect(result.structuredContent).toMatchObject({
      total: 100,
      shown: 21,
      cap: 100,
      truncated: true,
      pagination: { hasMore: true, nextOffset: 21 },
      notice: expect.stringContaining('24000-byte response budget'),
    });
    assertMeasuredResponse(
      result,
      searchBillsTool,
      (result.structuredContent as { bills: unknown[] }).bills,
    );
  });
  it.each([150, 10_000])(
    'clamps limit %i to the 100-row cap and continues from nextOffset',
    async (limit) => {
      feed(Array.from({ length: 150 }, (_, i) => rawBill(`C-${i + 1}`)));
      const notice = `limit ${limit} exceeds the per-call maximum of 100; returned up to 100.`;
      const ids: string[] = [];
      let offset: number | null = 0;
      do {
        const result = await call({ session: '45-1', limit, offset });
        const data = check(result) as {
          bills: { billCode: string }[];
          pagination: { nextOffset: number | null };
        };
        assertMeasuredResponse(result, searchBillsTool, data.bills);
        expect(result.structuredContent).toMatchObject({
          total: 150,
          cap: 100,
          notice: expect.stringContaining(notice),
          pagination: { offset, limit: 100 },
        });
        expect(data.bills.length).toBeGreaterThan(0);
        ids.push(...data.bills.map((row) => row.billCode));
        offset = data.pagination.nextOffset;
        if (offset !== null) expect(offset).toBe(ids.length);
        expect(ids.length).toBeLessThanOrEqual(150);
      } while (offset !== null);
      expect(ids).toEqual(Array.from({ length: 150 }, (_, i) => `C-${i + 1}`));
    },
  );
  it.each([
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
  it.each(['C-0', 'Q-77777'])(
    'rejects billCode %j by its advertised format before any request',
    async (billCode) => {
      feed();
      assertArgumentRejection(await call({ session: '45-1', billCode }), {
        lines: [
          'billCode: Expected a House or Senate bill code such as C-15, C-15A, or S-1001: C or S, an optional single dash or space, a number without leading zeros, then an optional suffix letter.',
        ],
        rejected: billCode,
      });
      expect(http.calls).toHaveLength(0);
    },
  );
  it.each<[Record<string, string>, FilterRejection]>([
    [
      { originatingChamber: 'Zz Assembly' },
      {
        field: 'originatingChamber',
        rejected: 'Zz Assembly',
        allowed: ['House', 'House of Commons', 'Senate'],
      },
    ],
    [
      { billType: 'zz unknown type' },
      {
        field: 'billType',
        rejected: 'zz unknown type',
        allowed: [...BILL_TYPES, 'Government Bill', 'Historical synthetic type'],
      },
    ],
    [
      { status: 'passed' },
      {
        field: 'status',
        rejected: 'passed',
        allowed: [...BILL_STATUSES, 'Historical synthetic stage'],
      },
    ],
    [
      { sponsor: 'Justin Trudeau' },
      {
        field: 'sponsor',
        rejected: 'Justin Trudeau',
        shape: 'Expected an OpenParliament politician slug',
      },
    ],
    [
      { sponsor: 'https://' },
      {
        field: 'sponsor',
        rejected: 'https://',
        shape: 'Expected an OpenParliament politician slug',
      },
    ],
  ])('names the rejected field and what it accepts for %j', async (input, expected) => {
    feed();
    const result = await call({ session: '45-1', ...input });
    assertError(result, 'invalid_bill_filter', JsonRpcErrorCode.ValidationError, hint);
    assertFilterRejection(result, expected);
    expect(http.calls.some((c) => c.request.url.includes('openparliament'))).toBe(false);
  });
  it('returns declared unknown-session recovery without requesting its feed', async () => {
    const result = await call({ session: '46-1' });
    assertError(
      result,
      'unknown_session',
      JsonRpcErrorCode.ValidationError,
      'Call canparl_list_reference with topic sessions and choose a listed bill session.',
    );
    assertFilterRejection(result, {
      field: 'session',
      rejected: '46-1',
      allowed: ['45-1', '35-2'],
      shape: 'Expected a session in the official bill session index',
    });
    expect(http.calls).toHaveLength(1);
  });
  it.each(['45-0', '9007199254740992-1'])(
    'rejects malformed session %j as unknown_session before HTTP',
    async (session) => {
      const result = await call({ session });
      assertError(
        result,
        'unknown_session',
        JsonRpcErrorCode.ValidationError,
        'Call canparl_list_reference with topic sessions and choose a listed bill session.',
      );
      assertFilterRejection(result, {
        field: 'session',
        rejected: session,
        shape: 'Expected a parliament-session token such as 45-1',
      });
      expect(http.calls).toHaveLength(0);
    },
  );
  it('verifies sponsor existence before requesting any indexed bills', async () => {
    feed();
    http.route({ match: profile, respond: new Response('', { status: 404 }) });
    assertError(
      await call({ session: '45-1', sponsor: 'synthetic-member' }),
      'sponsor_not_found',
      JsonRpcErrorCode.NotFound,
      'Call canparl_search_members with includeFormer true and a surname or full name, then pass a returned slug as sponsor.',
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
    { limit: 10_001 },
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

describe('canparl_search_bills sponsor identity', () => {
  const api = 'https://api.openparliament.ca';
  const river = '/politicians/river-example/';
  const namePage = `${api}/politicians/?limit=4&offset=0&include=all&name=River+Example`;
  const notFound = searchBillsTool.errors!.find((error) => error.reason === 'sponsor_not_found')!;
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
    initOurCommonsService({ userAgent: 'synthetic-bill-contract-tests' });
    sessions(http);
    http.route({ match: listing(), respond: Response.json(rows) });
  });
  afterEach(() => {
    disposeOurCommonsService();
    teardown(http);
  });
  const roster = (...ids: number[]) =>
    http.route({
      match: rosterUrl,
      respond: new Response(
        collection(
          'ArrayOfMemberOfParliament',
          'MemberOfParliament',
          ids.map((id) => rawPerson(id)),
        ),
      ),
    });
  const politician = (path: string, extra: Record<string, unknown> = {}) =>
    http.route({
      match: `${api}${path}`,
      respond: Response.json({ url: path, name: 'River Example', ...extra }),
    });
  const candidates = (paths: string[]) =>
    http.route({
      match: namePage,
      respond: Response.json({
        objects: paths.map((url) => ({ url, name: 'River Example' })),
        pagination: { offset: 0, limit: 4, next_url: null },
      }),
    });
  const indexed = (path: string, pages: string[][]) =>
    pages.forEach((codes, index) => {
      const url = new URL('/bills/', api);
      url.searchParams.set('limit', '100');
      url.searchParams.set('offset', String(index * 100));
      url.searchParams.set('sponsor_politician', path);
      url.searchParams.set('session', '45-1');
      const next = new URL(url);
      next.searchParams.set('offset', String((index + 1) * 100));
      http.route({
        match: url.href,
        respond: Response.json({
          objects: codes.map((code) => ({
            session: '45-1',
            number: code,
            url: `/bills/45-1/${code}/`,
          })),
          pagination: {
            offset: index * 100,
            limit: 100,
            next_url: index + 1 < pages.length ? next.href : null,
          },
        }),
      });
    });
  const call = (input: Record<string, unknown>) =>
    settle(runToolContract(searchBillsTool, { session: '45-1', ...input }));
  const urls = () => http.calls.map((c) => c.request.url);
  function contract(result: Awaited<ReturnType<typeof call>>) {
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    const body = searchBillsTool.output.parse(structured);
    assertDomainParity(body, searchBillsTool.format!(body));
    assertDomainParity(body, [result.content[0]!]);
    for (const [key, schema] of Object.entries(searchBillsTool.enrichment!))
      schema.parse(structured[key]);
    expectExact(trailerFields(result.content.slice(1)).appliedFilters, structured.appliedFilters);
    return structured;
  }

  it('filters by the verified profile when sponsor is a current personId', async () => {
    roster(2897);
    candidates([river]);
    politician(river, { other_info: { parl_mp_id: ['2897'] } });
    politician('/politicians/2897/', { name: 'Unrelated Candidate' });
    indexed(river, [['C-10', 'S-20']]);
    const data = contract(await call({ sponsor: ' 2897 ' }));
    expect(data).toMatchObject({
      total: 2,
      bills: [{ billCode: 'C-10' }, { billCode: 'S-20' }],
      sponsorCoverage: 'openparliament_index',
      appliedFilters: { sponsor: 'river-example', sponsorName: 'River Example' },
    });
    expect(urls().filter((url) => new URL(url).origin === api || url === rosterUrl)).toEqual([
      rosterUrl,
      namePage,
      `${api}${river}`,
      `${api}/bills/?limit=100&offset=0&sponsor_politician=%2Fpoliticians%2Friver-example%2F&session=45-1`,
    ]);
  });
  it('resolves Judy Sgro through the surname fallback for sponsor personId 1787', async () => {
    const judy = '/politicians/judy-sgro/';
    http.route({
      match: rosterUrl,
      respond: new Response(
        collection('ArrayOfMemberOfParliament', 'MemberOfParliament', [
          rawPerson(1787, { PersonOfficialFirstName: 'Judy A.', PersonOfficialLastName: 'Sgro' }),
        ]),
      ),
    });
    const exact = `${api}/politicians/?limit=4&offset=0&include=all&name=Judy+A.+Sgro`;
    const surname = `${api}/politicians/?limit=4&offset=0&include=all&family_name=Sgro`;
    http.route(
      {
        match: exact,
        respond: Response.json({
          objects: [],
          pagination: { offset: 0, limit: 4, next_url: null },
        }),
      },
      {
        match: surname,
        respond: Response.json({
          objects: [{ url: judy, name: 'Judy Sgro' }],
          pagination: { offset: 0, limit: 4, next_url: null },
        }),
      },
    );
    politician(judy, {
      name: 'Judy Sgro',
      other_info: { parl_mp_id: ['1787'], alternate_name: ['judy a. sgro'] },
    });
    indexed(judy, [['C-10']]);
    expect(contract(await call({ sponsor: '1787' }))).toMatchObject({
      total: 1,
      bills: [{ billCode: 'C-10' }],
      appliedFilters: { sponsor: 'judy-sgro', sponsorName: 'Judy Sgro' },
    });
    expect(urls().filter((url) => new URL(url).origin === api || url === rosterUrl)).toEqual([
      rosterUrl,
      exact,
      surname,
      `${api}${judy}`,
      `${api}/bills/?limit=100&offset=0&sponsor_politician=%2Fpoliticians%2Fjudy-sgro%2F&session=45-1`,
    ]);
  });
  it.each(['/politicians/2897/', 'https://openparliament.ca/politicians/2897/'])(
    'reads sponsor %j, holding a current personId, through the verified crosswalk',
    async (sponsor) => {
      roster(2897);
      candidates([river]);
      politician(river, { other_info: { parl_mp_id: ['2897'] } });
      indexed(river, [['C-10']]);
      expect(contract(await call({ sponsor }))).toMatchObject({
        total: 1,
        appliedFilters: { sponsor: 'river-example', sponsorName: 'River Example' },
      });
      expect(urls().filter((url) => new URL(url).origin === api || url === rosterUrl)).toEqual([
        rosterUrl,
        namePage,
        `${api}${river}`,
        `${api}/bills/?limit=100&offset=0&sponsor_politician=%2Fpoliticians%2Friver-example%2F&session=45-1`,
      ]);
    },
  );
  it('describes how sponsor reads a current personId', () => {
    expect(searchBillsTool.input.shape.sponsor.description).toBe(
      "MP OpenParliament slug or politician path/HTTPS URL (member.slug from canparl_get_member, or an includeFormer canparl_search_members row), or a current MP's official personId; Senators are not indexed. A digit-only value equal to a current personId, or its /politicians/<digits>/ path or profile URL, is read as that personId.",
    );
  });
  it.each([
    ['no candidate', [] as string[]],
    ['an unverified candidate', [river]],
  ])(
    'fails sponsor_not_found for a current personId with %s, before any bill index request',
    async (_case, paths) => {
      roster(2897);
      candidates(paths);
      const surnamePage = `${api}/politicians/?limit=4&offset=0&include=all&family_name=Example`;
      if (!paths.length)
        http.route({
          match: surnamePage,
          respond: Response.json({
            objects: [],
            pagination: { offset: 0, limit: 4, next_url: null },
          }),
        });
      politician(river, { other_info: { parl_mp_id: ['1'] } });
      assertError(
        await call({ sponsor: '2897' }),
        'sponsor_not_found',
        JsonRpcErrorCode.NotFound,
        notFound.recovery,
      );
      expect(urls().filter((url) => new URL(url).origin === api)).toEqual([
        namePage,
        ...(!paths.length ? [surnamePage] : []),
        ...paths.map((path) => `${api}${path}`),
      ]);
    },
  );
  it('filters by a sponsor profile whose links are relative or protocol-relative', async () => {
    politician(river, {
      links: [{ url: '/members/relative-link/' }, { url: '//example-mp.test/home' }],
    });
    indexed(river, [['C-2']]);
    const data = contract(await call({ sponsor: 'river-example' }));
    expect(data).toMatchObject({
      total: 1,
      bills: [{ billCode: 'C-2' }],
      appliedFilters: { sponsor: 'river-example', sponsorName: 'River Example' },
    });
  });
  it('keeps a numeric sponsor absent from the roster as an OpenParliament ID, read after the roster', async () => {
    roster(1);
    politician('/politicians/5724/', { name: 'Numeric Example' });
    indexed('/politicians/5724/', [['C-2']]);
    const data = contract(await call({ sponsor: 'https://openparliament.ca/politicians/5724/' }));
    expect(data).toMatchObject({
      total: 1,
      bills: [{ billCode: 'C-2' }],
      appliedFilters: { sponsor: '5724', sponsorName: 'Numeric Example' },
    });
    expect(
      urls()
        .filter((url) => new URL(url).origin === api || url === rosterUrl)
        .slice(0, 2),
    ).toEqual([rosterUrl, `${api}/politicians/5724/`]);
  });
  it('fails sponsor_not_found when a numeric sponsor answers with another canonical profile', async () => {
    roster(1);
    politician('/politicians/413/', { url: river });
    assertError(
      await call({ sponsor: '413' }),
      'sponsor_not_found',
      JsonRpcErrorCode.NotFound,
      notFound.recovery,
    );
    expect(urls().some((url) => new URL(url).pathname === '/bills/')).toBe(false);
  });
  it('names a slug sponsor without reading the roster, and echoes null without a sponsor', async () => {
    politician(river);
    indexed(river, [['C-8']]);
    expect(contract(await call({ sponsor: 'river-example' }))).toMatchObject({
      appliedFilters: { sponsor: 'river-example', sponsorName: 'River Example' },
    });
    expect(contract(await call({}))).toMatchObject({
      appliedFilters: { sponsor: null, sponsorName: null },
    });
    expect(urls()).not.toContain(rosterUrl);
  });
  it('reuses the cached roster on a later digit-only sponsor call', async () => {
    roster(1);
    politician('/politicians/5724/', { name: 'Numeric Example' });
    indexed('/politicians/5724/', [['C-2']]);
    contract(await call({ sponsor: '5724' }));
    const second = contract(await call({ sponsor: '5724' }));
    expect(urls().filter((url) => url === rosterUrl)).toHaveLength(1);
    expect(second.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: rosterUrl, cached: true })]),
    );
  });
  it('completes the cold maximum 14 OpenParliament operations for a current personId sponsor', async () => {
    roster(2897);
    const paths = [0, 1, 2].map((i) => `/politicians/candidate-${i}/`);
    candidates(paths);
    for (const [i, path] of paths.entries())
      politician(path, { other_info: { parl_mp_id: [i === 2 ? '2897' : '99'] } });
    indexed(
      paths[2]!,
      Array.from({ length: 10 }, (_, page) => [page === 9 ? 'C-10' : `C-${1000 + page}`]),
    );
    const pending = runToolContract(searchBillsTool, { session: '45-1', sponsor: '2897' });
    await vi.advanceTimersByTimeAsync(44_000);
    const data = contract(await pending);
    expect(data).toMatchObject({
      total: 1,
      bills: [{ billCode: 'C-10' }],
      appliedFilters: { sponsor: 'candidate-2', sponsorName: 'River Example' },
    });
    expect(urls().filter((url) => new URL(url).origin === api)).toHaveLength(14);
  });
});
