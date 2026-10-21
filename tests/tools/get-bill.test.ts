/**
 * @fileoverview Deep and sparse official bill dossier contract coverage.
 * @module tests/tools/get-bill.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBillTool } from '@/mcp-server/tools/definitions/get-bill.tool.js';
import {
  assertDomainParity,
  assertError,
  current,
  detail,
  expectedText,
  parseMarkdown,
  rawBill,
  sessions,
  settle,
  setup,
  teardown,
} from '../fixtures/bill-tools/harness.js';

const prose = ' Synthetic\rtext\nwith\r\n``` fences &amp; [links](https://evil.test) ';
const decision = {
  'nested\r\nkey': [
    { text: prose, count: 0, flag: false, absent: null },
    ['deep', { last: 'last leaf' }],
  ],
  empty: [],
};
const stage = (id: number) => ({
  BillStageId: id,
  BillStageNameEn: `Synthetic stage ${id}`,
  BillStageNameFr: `Étape ${id}`,
  ChamberOrganizationId: 0,
  State: 3,
  StateNameEn: 'Complete',
  StateNameFr: 'Terminé',
  StateAsOfDate: '2026-01-02',
  Committee: {
    CommitteeOrganizationId: 700,
    CommitteeAcronym: 'SYN',
    CommitteeNameEn: 'Synthetic committee',
    CommitteeNameFr: 'Comité synthétique',
  },
  Sittings: [
    { Number: 17, Date: '2026-01-01', NameEn: prose, NameFr: 'Séance', IsPublished: false },
    { Number: '18A', Date: null, NameEn: null, NameFr: null, IsPublished: true },
  ],
  CommitteeMeetings: [
    {
      Number: '2',
      Date: '2026-01-02',
      CommitteeOrganizationId: 701,
      CommitteeAcronym: 'SYN2',
      CommitteeNameEn: 'Second committee',
      CommitteeNameFr: 'Deuxième comité',
    },
  ],
  Decisions: [decision, { second: { url: 'https://example.test/decision?a=1&b=2' } }],
  SignificantEvents: [{ event: ['first', { deeper: prose }] }],
  EndOfStageEvent: { closed: false, remarks: prose },
});
const expectedStage = (id: number, chamber: 'House' | 'Senate' | null) => ({
  id,
  name: { en: `Synthetic stage ${id}`, fr: `Étape ${id}` },
  chamber,
  state: { id: 3, en: 'Complete', fr: 'Terminé' },
  stateAsOf: '2026-01-02',
  committee: {
    id: 700,
    acronym: 'SYN',
    name: { en: 'Synthetic committee', fr: 'Comité synthétique' },
  },
  sittings: [
    { number: '17', date: '2026-01-01', name: { en: prose, fr: 'Séance' }, published: false },
    { number: '18A', date: null, name: { en: null, fr: null }, published: true },
  ],
  committeeMeetings: [
    {
      number: '2',
      date: '2026-01-02',
      committeeId: 701,
      acronym: 'SYN2',
      name: { en: 'Second committee', fr: 'Deuxième comité' },
    },
  ],
  decisions: [decision, { second: { url: 'https://example.test/decision?a=1&b=2' } }],
  significantEvents: [{ event: ['first', { deeper: prose }] }],
  endOfStageEvent: { closed: false, remarks: prose },
});

describe('canparl_get_bill production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
    sessions(http);
  });
  afterEach(() => teardown(http));
  const call = (input: Record<string, unknown> = { session: '45-1', billCode: 'C-901' }) =>
    // Deliberately permit malformed fixtures to reach the production input validator.
    settle(runToolContract(getBillTool, input as { billCode: string; session?: unknown }));
  function check(result: Awaited<ReturnType<typeof call>>) {
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    const domain = getBillTool.output.parse(structured);
    assertDomainParity(domain, getBillTool.format!(domain));
    assertDomainParity(domain, result.content.slice(0, 1));
    if (!getBillTool.enrichment) throw new Error('Missing declared enrichment');
    for (const [key, schema] of Object.entries(getBillTool.enrichment))
      schema.parse(structured[key]);
    const trailer = parseMarkdown(
      result.content
        .slice(1)
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    ).text;
    expect(trailer).toContain(expectedText(structured.appliedFilters, 'appliedFilters'));
    if (structured.notice) expect(trailer).toContain(structured.notice);
    return domain;
  }
  it('outlines rendered overflow and pages whole nested records without loss', async () => {
    const records = Array.from({ length: 7 }, (_, i) => ({
      id: i,
      nested: { text: 'é & '.repeat(800) },
    }));
    http.route({
      match: detail(),
      respond: Response.json([rawBill('C-901', { SenateVoteDetails: records })]),
    });
    const overview = await call();
    expect(check(overview)).toMatchObject({ kind: 'outline', sections: expect.any(Array) });
    expect(
      Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: overview })),
    ).toBeLessThanOrEqual(24_000);
    const rebuilt: unknown[] = [];
    let offset = 0;
    do {
      const reply = await call({
        session: '45-1',
        billCode: 'C-901',
        section: 'senateVoteDetails',
        offset,
        limit: 3,
      });
      const page = check(reply);
      expect(page.kind).toBe('section');
      expect(page.senateVoteDetails?.length).toBeGreaterThan(0);
      rebuilt.push(...(page.senateVoteDetails ?? []));
      expect(
        Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: reply })),
      ).toBeLessThanOrEqual(24_000);
      offset = page.pagination?.nextOffset ?? -1;
    } while (offset !== -1);
    expect(rebuilt).toEqual(records);
  });
  it('treats a blank section as unset and trims a selected section', async () => {
    http.route({ match: detail(), respond: Response.json([rawBill()]) });
    const full = check(await call({ session: '45-1', billCode: 'C-901', section: '   ' }));
    expect(full.kind).toBeUndefined();
    const selected = check(
      await call({ session: '45-1', billCode: 'C-901', section: ' sponsor ' }),
    );
    expect(selected).toMatchObject({ kind: 'section', sponsor: full.sponsor });
  });
  it.each([
    'stages.house',
    'stages.senate',
    'stages.royalAssent',
    'divisions',
    'senateVoteDetails',
    'publications',
  ])('keeps empty and past-end pages explicit for %s', async (section) => {
    http.route({
      match: detail(),
      respond: Response.json([
        rawBill('C-901', {
          BillStages: {
            HouseBillStages: [stage(1), stage(2)],
            SenateBillStages: [],
            RoyalAssent: [],
          },
          HouseVoteDetails: [],
          SenateVoteDetails: [],
          Publications: [],
        }),
      ]),
    });
    const reply = await call({ session: '45-1', billCode: 'C-901', section, offset: 99, limit: 1 });
    expect(check(reply)).toMatchObject({
      pagination: { offset: 99, nextOffset: null },
      disclosure: expect.stringMatching(/past the end|no records/),
    });
  });
  it.each(['sponsor', 'statute', 'stages.house', 'senateVoteDetails'])(
    'returns sparse selected section %s with parity',
    async (section) => {
      http.route({ match: detail(), respond: Response.json([rawBill()]) });
      expect(check(await call({ session: '45-1', billCode: 'C-901', section }))).toMatchObject({
        kind: 'section',
        pagination: { section, nextOffset: null },
      });
    },
  );
  it('returns an oversized indivisible nested record whole with disclosure', async () => {
    const record = { nested: { text: ' &é'.repeat(9000) } };
    http.route({
      match: detail(),
      respond: Response.json([rawBill('C-901', { SenateVoteDetails: [record] })]),
    });
    const result = check(
      await call({ session: '45-1', billCode: 'C-901', section: 'senateVoteDetails', limit: 1 }),
    );
    expect(result.senateVoteDetails).toEqual([record]);
    expect(result.disclosure).toContain('indivisible');
    expect(result.pagination).toMatchObject({ total: 1, nextOffset: null });
  });
  it('pages deep chamber stages by whole records and retains the requested cap', async () => {
    http.route({
      match: detail(),
      respond: Response.json([
        rawBill('C-901', {
          BillStages: {
            HouseBillStages: [stage(1), stage(2)],
            SenateBillStages: [],
            RoyalAssent: [],
          },
        }),
      ]),
    });
    const first = check(
      await call({ session: '45-1', billCode: 'C-901', section: 'stages.house', limit: 1 }),
    );
    const second = check(
      await call({
        session: '45-1',
        billCode: 'C-901',
        section: 'stages.house',
        offset: 1,
        limit: 100,
      }),
    );
    expect(first.stages?.house).toEqual([expectedStage(1, 'House')]);
    expect(first.pagination).toMatchObject({ total: 2, nextOffset: 1, limit: 1 });
    expect(second.stages?.house).toEqual([expectedStage(2, 'House')]);
    expect(second.pagination).toMatchObject({ total: 2, nextOffset: null, limit: 100 });
  });
  it.each([{ section: 'missing' }, { offset: 1 }, { section: 'sponsor', offset: 1 }])(
    'rejects incompatible selection %j with recovery',
    async (selection) => {
      http.route({ match: detail(), respond: Response.json([rawBill()]) });
      const reply = await call({ session: '45-1', billCode: 'C-901', ...selection });
      assertError(
        reply,
        'invalid_bill_section',
        JsonRpcErrorCode.ValidationError,
        'Choose an available section from the outline and use offset and limit only for collections.',
      );
      if (selection.section === 'missing') expect(JSON.stringify(reply)).toContain('stages.house');
    },
  );
  it.each([{ offset: -1 }, { limit: 0 }, { limit: 101 }])(
    'rejects invalid page %j before HTTP',
    async (page) => {
      const reply = await call({
        session: '45-1',
        billCode: 'C-901',
        section: 'publications',
        ...page,
      });
      expect(reply.isError).toBe(true);
      expect(http.calls).toHaveLength(0);
    },
  );
  it('preserves every nested source leaf from both chambers and all dossier links', async () => {
    const source = rawBill('C-901', {
      SponsorPersonName: 'Synthetic Sponsor',
      SponsorPersonId: 90909,
      SponsorConstituencyNameEn: 'Synthetic Bay',
      BillStages: {
        HouseBillStages: [stage(1), stage(2)],
        SenateBillStages: [stage(3), stage(4)],
        RoyalAssent: [{ BillStageId: 5, Decisions: [], SignificantEvents: [] }, { BillStageId: 6 }],
      },
      HouseBillStages: [{ BillStageId: 999, BillStageNameEn: 'Root decoy' }],
      HouseVoteDetails: [71, 72].map((number) => ({
        DivisionNumber: number,
        DivisionSubjectEn: `Synthetic division ${number}`,
        DivisionSubjectFr: `Vote ${number}`,
        DecisionDateTime: '2026-01-02T12:00:00',
        DecisionResultNameEn: 'Agreed To',
        DivisionVotesYeas: 200,
        DivisionVotesNays: 100,
        DivisionVotePaired: 0,
        DivisionVoteTotal: 300,
        ParliamentNumber: 0,
        SessionNumber: 0,
      })),
      SenateVoteDetails: [{ nested: { result: ['yea', 'nay'], exact: prose } }],
      Publications: [8001, 8002].map((id) => ({
        PublicationId: id,
        PublicationTypeId: 9,
        PublicationTypeNameEn: 'As passed',
        PublicationTypeNameFr: 'Adopté',
      })),
      StatuteYear: 2026,
      StatuteChapter: 'A-1.2',
      ReceivedRoyalAssentDateTime: '2026-01-03',
    });
    http.route({ match: detail(), respond: Response.json([source]) });
    const result = await call();
    const domain = check(result);
    expect(domain).toEqual({
      bill: {
        session: '45-1',
        billCode: 'C-901',
        longTitle: { en: 'Synthetic marine act', fr: 'Loi synthétique sur la mer' },
        shortTitle: { en: 'Marine Act', fr: 'Loi marine' },
        billType: 'Government Bill',
        originatingChamber: 'House',
        status: 'At second reading in the House of Commons',
        latestMajorStage: { name: 'First reading', chamber: 'House of Commons' },
        royalAssentDate: '2026-01-03',
        url: 'https://www.parl.ca/legisinfo/en/bill/45-1/c-901',
      },
      sponsor: { name: 'Synthetic Sponsor', personId: '90909', riding: 'Synthetic Bay' },
      stages: {
        house: [expectedStage(1, 'House'), expectedStage(2, 'House')],
        senate: [expectedStage(3, 'Senate'), expectedStage(4, 'Senate')],
        royalAssent: [5, 6].map((id, index) => ({
          id,
          name: { en: null, fr: null },
          chamber: null,
          state: { id: null, en: null, fr: null },
          stateAsOf: null,
          committee: null,
          sittings: null,
          committeeMeetings: null,
          decisions: index === 0 ? [] : null,
          significantEvents: index === 0 ? [] : null,
          endOfStageEvent: null,
        })),
      },
      divisions: [71, 72].map((number) => ({
        session: '45-1',
        number,
        subject: { en: `Synthetic division ${number}`, fr: `Vote ${number}` },
        dateTime: '2026-01-02T12:00:00',
        result: 'Agreed To',
        yeas: 200,
        nays: 100,
        paired: 0,
        total: 300,
        url: `https://www.ourcommons.ca/Members/en/votes/45/1/${number}`,
      })),
      senateVoteDetails: [{ nested: { result: ['yea', 'nay'], exact: prose } }],
      publications: [8001, 8002].map((id) => ({
        id,
        typeId: 9,
        type: { en: 'As passed', fr: 'Adopté' },
        url: `https://www.parl.ca/DocumentViewer/en/${id}`,
      })),
      statute: { year: 2026, chapter: 'A-1.2', citation: 'S.C. 2026, c. A-1.2' },
      provenance: [
        {
          source: 'legisinfo',
          url: 'https://www.parl.ca/legisinfo/en/bills',
          retrievedAt: '2026-10-20T00:00:00.000Z',
          cached: false,
        },
        { source: 'legisinfo', url: detail(), retrievedAt: expect.any(String), cached: false },
      ],
    });
    expect(http.calls).toHaveLength(2);
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { session: '45-1', billCode: 'C-901' },
    });
  });
  it('retains nulls for a sparse historical dossier and reports limited coverage', async () => {
    http.route({
      match: detail('S-7', '35-2'),
      respond: Response.json([
        {
          ParliamentNumber: 35,
          SessionNumber: 2,
          NumberCode: 'S-7',
          SponsorPersonName: '  ',
          StatuteYear: 1996,
        },
      ]),
    });
    const result = await call({ session: '035-02', billCode: 'bill s7' });
    const domain = check(result);
    expect(domain).toMatchObject({
      bill: {
        session: '35-2',
        billCode: 'S-7',
        longTitle: { en: null, fr: null },
        shortTitle: { en: null, fr: null },
        billType: null,
        originatingChamber: null,
        status: null,
        latestMajorStage: null,
        royalAssentDate: null,
      },
      sponsor: { name: null, personId: null, riding: null },
      stages: { house: null, senate: null, royalAssent: null },
      divisions: null,
      senateVoteDetails: null,
      publications: null,
      statute: null,
    });
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { session: '35-2', billCode: 'S-7' },
      notice:
        'This early session provides basic bill coverage; unavailable dossier fields remain null.',
    });
    expect(http.calls.map((c) => c.request.url)).not.toContain(current);
  });
  it('resolves current session for blank input and accepts canonical numeric code aliases', async () => {
    http.route(
      { match: current, respond: Response.json([rawBill()]) },
      {
        match: detail('S-321'),
        respond: Response.json([
          rawBill('S-321', {
            OriginatingChamberNameEn: 'Senate',
            StatuteYear: 2026,
            StatuteChapter: 17,
            BillStages: { HouseBillStages: [], SenateBillStages: [], RoyalAssent: [] },
            Publications: [],
            HouseVoteDetails: [],
            SenateVoteDetails: [],
          }),
        ]),
      },
    );
    const result = await call({ session: ' ', billCode: ' S321 ' });
    expect(check(result)).toMatchObject({
      bill: { billCode: 'S-321', originatingChamber: 'Senate' },
      statute: { year: 2026, chapter: '17', citation: 'S.C. 2026, c. 17' },
      stages: { house: [], senate: [], royalAssent: [] },
      publications: [],
      divisions: [],
      senateVoteDetails: [],
    });
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { session: '45-1', billCode: 'S-321' },
    });
    expect(http.calls.map((c) => c.request.url)).toContain(current);
  });
  it.each(['C-0', 'C-1/S-1', '', 'https://evil.test/C-1'])(
    'returns invalid-code recovery before HTTP for %s',
    async (billCode) => {
      assertError(
        await call({ session: '45-1', billCode }),
        'invalid_bill_code',
        JsonRpcErrorCode.ValidationError,
        'Call canparl_search_bills by title and copy the returned billCode and session.',
      );
      expect(http.calls).toHaveLength(0);
    },
  );
  it('returns the declared unknown-session recovery', async () => {
    assertError(
      await call({ session: '46-1', billCode: 'C-901' }),
      'unknown_session',
      JsonRpcErrorCode.ValidationError,
      'Call canparl_list_reference with topic sessions and choose a listed bill session.',
    );
    expect(http.calls).toHaveLength(1);
  });
  it.each(['empty', '404', 'redirect'])(
    'returns bill-not-found recovery for %s without following error HTML',
    async (mode) => {
      const response =
        mode === 'empty'
          ? Response.json([])
          : mode === '404'
            ? new Response('', { status: 404 })
            : new Response('', {
                status: 302,
                headers: { location: '/ErrorPage/en?StatusCode=404' },
              });
      http.route({ match: detail(), respond: response });
      assertError(
        await call(),
        'bill_not_found',
        JsonRpcErrorCode.NotFound,
        'Call canparl_search_bills in the same session and copy a returned billCode.',
      );
      expect(http.calls).toHaveLength(2);
    },
  );
  it('rejects missing required billCode through the schema on both error surfaces', async () => {
    const result = await call({ session: '45-1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('billCode') }),
      ]),
    );
    expect(http.calls).toHaveLength(0);
  });
});
