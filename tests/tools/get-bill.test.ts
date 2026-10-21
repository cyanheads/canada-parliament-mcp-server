/**
 * @fileoverview Deep and sparse official bill dossier contract coverage.
 * @module tests/tools/get-bill.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BillSummarySchema, getBillTool } from '@/mcp-server/tools/definitions/get-bill.tool.js';
import { parseBillDossier, parseBillRecords } from '@/services/legisinfo/parsing.js';
import {
  assertDomainParity,
  assertError,
  assertMeasuredResponse,
  current,
  detail,
  expectExact,
  parseMarkdown,
  rawBill,
  realDossier,
  sessions,
  settle,
  setup,
  teardown,
  trailerFields,
  wireBytes,
} from '../fixtures/bill-tools/harness.js';
import { assertFilterRejection } from '../fixtures/filter-rejection.js';

const sectionNames = [
  'sponsor',
  'stages.house',
  'stages.senate',
  'stages.royalAssent',
  'divisions',
  'senateVoteDetails',
  'publications',
  'statute',
  'summary.en',
  'summary.fr',
  'notes.en',
  'notes.fr',
  'milestones',
  'webReferences',
];
type RealDossier = Parameters<typeof realDossier>[0];
/** Identity and production parse of a captured dossier, the oracle for its tool pages. */
function realBill(name: RealDossier) {
  const [parliament, number, prefix, code] = name.split('-');
  const session = `${parliament}-${number}`;
  const billCode = `${prefix?.toUpperCase()}-${code}`;
  return {
    session,
    billCode,
    parsed: parseBillDossier(parseBillRecords(realDossier(name)), session, billCode),
  };
}
/** Values the sparse `rawBill()` dossier carries; every section not listed here is null. */
const sparseSections: Record<string, unknown> = {
  sponsor: { name: null, personId: null, riding: null, title: { en: null, fr: null } },
  milestones: {
    houseFirstReading: null,
    houseSecondReading: null,
    houseThirdReading: null,
    senateFirstReading: null,
    senateSecondReading: null,
    senateThirdReading: null,
  },
};
const budgetStop = (count: number) =>
  `The 24000-byte response budget ended this page after ${count} ${count === 1 ? 'record' : 'records'}; call canparl_get_bill with pagination.nextOffset and the same section to continue.`;

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
    expectExact(trailerFields(result.content.slice(1)).appliedFilters, structured.appliedFilters);
    if (structured.notice) expect(trailer).toContain(structured.notice);
    assertMeasuredResponse(result, getBillTool);
    return domain;
  }
  /** Serve one captured dossier from a picker that advertises its session. */
  function routeReal(name: RealDossier) {
    const bill = realBill(name);
    http.reset();
    sessions(http, ['45-1', '44-1', '42-1', '41-1', '35-1']);
    http.route({
      match: detail(bill.billCode, bill.session),
      respond: new Response(realDossier(name)),
    });
    return bill;
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
    'webReferences',
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
          WebReferences: [],
        }),
      ]),
    });
    const reply = await call({ session: '45-1', billCode: 'C-901', section, offset: 99, limit: 1 });
    expect(check(reply)).toMatchObject({
      pagination: { offset: 99, nextOffset: null },
      disclosure: expect.stringMatching(/past the end|no records/),
    });
  });
  it.each(sectionNames)(
    'returns sparse selected section %s alone, marking an absent one unavailable',
    async (section) => {
      http.route({ match: detail(), respond: Response.json([rawBill()]) });
      const page = check(await call({ session: '45-1', billCode: 'C-901', section }));
      const [parent, child] = section.split('.') as [string, string?];
      const value = sparseSections[section] ?? null;
      expect(page).toEqual({
        kind: 'section',
        totalCount: null,
        bill: expect.objectContaining({ session: '45-1', billCode: 'C-901' }),
        provenance: expect.any(Array),
        [parent]: child === undefined ? value : { [child]: value },
        pagination: { section, offset: 0, limit: 20, total: null, nextOffset: null },
        ...(value === null ? { disclosure: 'Section is unavailable in the official source.' } : {}),
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
    const atCap = await call({
      session: '45-1',
      billCode: 'C-901',
      section: 'stages.house',
      offset: 1,
      limit: 100,
    });
    const second = check(atCap);
    expect(first.stages?.house).toEqual([expectedStage(1, 'House')]);
    expect(first.pagination).toMatchObject({ total: 2, nextOffset: 1, limit: 1 });
    expect(second.stages?.house).toEqual([expectedStage(2, 'House')]);
    expect(second.pagination).toMatchObject({ total: 2, nextOffset: null, limit: 100 });
    expect(atCap.structuredContent).not.toHaveProperty('notice');
  });
  it.each([150, 10_000])(
    'clamps a collection limit of %i to 100 records and continues from nextOffset',
    async (limit) => {
      const records = Array.from({ length: 150 }, (_, n) => ({ n }));
      http.route({
        match: detail(),
        respond: Response.json([rawBill('C-901', { SenateVoteDetails: records })]),
      });
      const notice = `limit ${limit} exceeds the per-call maximum of 100; returned up to 100.`;
      const select = (offset: number) =>
        call({ session: '45-1', billCode: 'C-901', section: 'senateVoteDetails', offset, limit });
      const firstReply = await select(0);
      const first = check(firstReply);
      expect(first.senateVoteDetails).toEqual(records.slice(0, 100));
      expect(first.pagination).toEqual({
        section: 'senateVoteDetails',
        offset: 0,
        limit: 100,
        total: 150,
        nextOffset: 100,
      });
      expect(firstReply.structuredContent).toMatchObject({ notice });
      const restReply = await select(100);
      const rest = check(restReply);
      expect(rest.senateVoteDetails).toEqual(records.slice(100));
      expect(rest.pagination).toMatchObject({ offset: 100, limit: 100, nextOffset: null });
      expect(restReply.structuredContent).toMatchObject({ notice });
    },
  );
  it('measures the clamp notice inside the 24000-byte section budget', async () => {
    // The large record leaves room for a few small ones beside the clamp notice and stop disclosure.
    const records = [
      { big: 'x'.repeat(10_300) },
      ...Array.from({ length: 149 }, (_, n) => ({ n: n + 1 })),
    ];
    http.route({
      match: detail(),
      respond: Response.json([rawBill('C-901', { SenateVoteDetails: records })]),
    });
    const reply = await call({
      session: '45-1',
      billCode: 'C-901',
      section: 'senateVoteDetails',
      limit: 150,
    });
    const page = check(reply);
    const count = page.senateVoteDetails?.length ?? 0;
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThan(100);
    expect(page.senateVoteDetails).toEqual(records.slice(0, count));
    expect(page.pagination).toMatchObject({ limit: 100, total: 150, nextOffset: count });
    expect(reply.structuredContent).toMatchObject({
      notice: 'limit 150 exceeds the per-call maximum of 100; returned up to 100.',
      disclosure: budgetStop(count),
    });
    expect(wireBytes(reply)).toBeLessThanOrEqual(24_000);
  });
  it('discloses a response-budget stop below the effective limit, measured inside the budget', async () => {
    const { parsed, ...bill } = routeReal('42-1-c-86');
    const reply = await call({ ...bill, section: 'webReferences', limit: 10_000 });
    const page = check(reply);
    const count = page.webReferences?.length ?? 0;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(23);
    expect(page.webReferences).toEqual(parsed.webReferences?.slice(0, count));
    expect(page.pagination).toEqual({
      section: 'webReferences',
      offset: 0,
      limit: 100,
      total: 23,
      nextOffset: count,
    });
    expect(reply.structuredContent).toMatchObject({
      notice: 'limit 10000 exceeds the per-call maximum of 100; returned up to 100.',
      disclosure: budgetStop(count),
    });
    expect(wireBytes(reply)).toBeLessThanOrEqual(24_000);
  });
  it.each([
    { section: 'missing' },
    { section: 'summary' },
    { section: 'notes.de' },
    { offset: 1 },
    { limit: 150 },
    { section: 'sponsor', offset: 1 },
    { section: 'statute', limit: 3 },
    { section: 'statute', limit: 150 },
    { section: 'summary.en', offset: 1 },
    { section: 'summary.fr', limit: 5 },
    { section: 'notes.en', offset: 1 },
    { section: 'notes.fr', limit: 1 },
    { section: 'milestones', offset: 2 },
  ])('rejects incompatible selection %j with recovery', async (selection) => {
    http.route({ match: detail(), respond: Response.json([rawBill()]) });
    const reply = await call({ session: '45-1', billCode: 'C-901', ...selection });
    assertError(
      reply,
      'invalid_bill_section',
      JsonRpcErrorCode.ValidationError,
      'Choose an available section from the outline and use offset and limit only for collections.',
    );
    const unknown = `Unknown section. Available sections: ${sectionNames.join(', ')}.`;
    if ('offset' in selection || 'limit' in selection)
      expect(JSON.stringify(reply)).not.toContain('Available sections');
    else {
      expect(reply.structuredContent).toMatchObject({ error: { message: unknown } });
      expect(JSON.stringify(reply.content)).toContain(unknown);
    }
  });
  it.each([{ offset: -1 }, { limit: 0 }, { limit: 10_001 }])(
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
      SponsorAffiliationTitleEn: 'Minister of Synthetic Affairs',
      SponsorAffiliationTitleFr: 'ministre des Affaires synthétiques',
      ShortLegislativeSummaryEn: '<div>First line.<br/><br/>1 & [two]</div>',
      ShortLegislativeSummaryFr: null,
      NotesEn:
        '<div>Refer to the <a href="https://sencanada.ca/en/committees/nffn/45-1">committee</a>.</div>',
      NotesFr: '',
      PassedHouseFirstReadingDateTime: '2026-01-01T15:12:48.157',
      PassedHouseSecondReadingDateTime: null,
      PassedHouseThirdReadingDateTime: null,
      PassedSenateFirstReadingDateTime: null,
      PassedSenateSecondReadingDateTime: null,
      PassedSenateThirdReadingDateTime: '2026-01-02T00:00:00',
      WebReferences: [
        {
          BillDocumentId: 0,
          TitleEn: 'Costing note',
          TitleFr: 'Note de coût',
          Title: 'Costing note',
          WebReferenceTypeId: 13,
          WebReferenceTypeNameEn: 'Legislative Costing Note',
          WebReferenceTypeNameFr: 'Note sur le coût',
          WebReferenceTypeName: 'Legislative Costing Note',
          UrlEn: 'https://www.pbo-dpb.ca/en/publications/x?a=1&b=2',
          UrlFr: 'http://www.pbo-dpb.ca/fr/publications/x',
          Url: 'https://www.pbo-dpb.ca/en/publications/x?a=1&b=2',
        },
        {
          TitleEn: 'Citation',
          TitleFr: null,
          WebReferenceTypeId: 8,
          WebReferenceTypeNameEn: 'Related Links',
          WebReferenceTypeNameFr: 'Liens connexes',
          UrlEn: 'Parliament of Canada. « 7. Section 8 ». 2015.',
          UrlFr: '',
        },
      ],
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
        latestMajorStage: { name: 'First reading', chamber: 'House' },
        royalAssentDate: '2026-01-03',
        url: 'https://www.parl.ca/legisinfo/en/bill/45-1/c-901',
      },
      sponsor: {
        name: 'Synthetic Sponsor',
        personId: '90909',
        riding: 'Synthetic Bay',
        title: {
          en: 'Minister of Synthetic Affairs',
          fr: 'ministre des Affaires synthétiques',
        },
      },
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
      summary: { en: 'First line.\n\n1 & [two]', fr: null },
      notes: {
        en: 'Refer to the committee (https://sencanada.ca/en/committees/nffn/45-1).',
        fr: null,
      },
      milestones: {
        houseFirstReading: '2026-01-01T15:12:48.157Z',
        houseSecondReading: null,
        houseThirdReading: null,
        senateFirstReading: null,
        senateSecondReading: null,
        senateThirdReading: '2026-01-02T00:00:00Z',
      },
      webReferences: [
        {
          title: { en: 'Costing note', fr: 'Note de coût' },
          typeId: 13,
          type: { en: 'Legislative Costing Note', fr: 'Note sur le coût' },
          url: {
            en: 'https://www.pbo-dpb.ca/en/publications/x?a=1&b=2',
            fr: 'http://www.pbo-dpb.ca/fr/publications/x',
          },
        },
        {
          title: { en: 'Citation', fr: null },
          typeId: 8,
          type: { en: 'Related Links', fr: 'Liens connexes' },
          url: { en: 'Parliament of Canada. « 7. Section 8 ». 2015.', fr: null },
        },
      ],
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
  it('reports a dossier royal assent UTC clock with its Z designator', async () => {
    http.route({
      match: detail(),
      respond: Response.json([
        rawBill('C-901', { ReceivedRoyalAssentDateTime: '2026-03-26T10:50:00' }),
      ]),
    });
    const result = check(await call({ session: '45-1', billCode: 'C-901', section: 'statute' }));
    expect(result.bill.royalAssentDate).toBe('2026-03-26T10:50:00Z');
  });
  it('starts a notes block that follows inline text on a new paragraph on both surfaces', async () => {
    http.route({
      match: detail(),
      respond: Response.json([
        rawBill('C-901', {
          NotesEn:
            '<div>On December 14, 2021, the Senate adopted the following motion:<p>That, notwithstanding any provisions of the Rules:</p></div>',
          NotesFr:
            '<div>Le Sénat a adopté la motion suivante le 14 décembre 2021 : <p>Que, nonobstant toute disposition du Règlement :</p></div>',
        }),
      ]),
    });
    expect(check(await call()).notes).toEqual({
      en: 'On December 14, 2021, the Senate adopted the following motion:\n\nThat, notwithstanding any provisions of the Rules:\n\n',
      fr: 'Le Sénat a adopté la motion suivante le 14 décembre 2021 : \n\nQue, nonobstant toute disposition du Règlement :\n\n',
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
    expect(domain).toMatchObject({
      sponsor: { title: { en: null, fr: null } },
      summary: { en: null, fr: null },
      notes: { en: null, fr: null },
      milestones: {
        houseFirstReading: null,
        houseSecondReading: null,
        houseThirdReading: null,
        senateFirstReading: null,
        senateSecondReading: null,
        senateThirdReading: null,
      },
      webReferences: null,
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
  it.each(['C-0', 'C-1/S-1', '', 'https://evil.test/C-1', 'C - 901', 'C-0901', 'C-15AB', 'C-15A1'])(
    'returns invalid-code recovery before HTTP for %s',
    async (billCode) => {
      const result = await call({ session: '45-1', billCode });
      assertError(
        result,
        'invalid_bill_code',
        JsonRpcErrorCode.ValidationError,
        'Call canparl_search_bills by title and copy the returned billCode and session.',
      );
      assertFilterRejection(result, {
        field: 'billCode',
        rejected: billCode,
        shape: 'Expected a House or Senate bill code such as C-15',
      });
      expect(http.calls).toHaveLength(0);
    },
  );
  it.each(['C 901', 'c–901', 'Bill C 901'])(
    'reads the canonical dossier for separator variant %j',
    async (billCode) => {
      http.route({ match: detail(), respond: Response.json([rawBill()]) });
      const result = await call({ session: '45-1', billCode });
      expect(check(result)).toMatchObject({ bill: { billCode: 'C-901' } });
      expect(result.structuredContent).toMatchObject({
        appliedFilters: { session: '45-1', billCode: 'C-901' },
      });
    },
  );
  it.each(['C-15A', 'c-15a', 'C 15A', 'bill c15a'])(
    'reads split-bill dossier %j at its lowercase suffixed path',
    async (billCode) => {
      http.route({ match: detail('C-15A'), respond: Response.json([rawBill('C-15A')]) });
      const result = await call({ session: '45-1', billCode });
      expect(check(result)).toMatchObject({
        bill: { billCode: 'C-15A', url: 'https://www.parl.ca/legisinfo/en/bill/45-1/c-15a' },
      });
      expect(result.structuredContent).toMatchObject({
        appliedFilters: { session: '45-1', billCode: 'C-15A' },
      });
      expect(http.calls.map((c) => c.request.url)).toContain(
        'https://www.parl.ca/legisinfo/en/bill/45-1/c-15a/json',
      );
    },
  );
  it('returns the declared unknown-session recovery', async () => {
    const result = await call({ session: '46-1', billCode: 'C-901' });
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
      const result = await call({ session, billCode: 'C-901' });
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
  it('outlines 45-1 C-15 with its sponsor, statute, and milestones inline and all 14 sections', async () => {
    const { parsed, ...bill } = routeReal('45-1-c-15');
    const reply = await call(bill);
    const outline = check(reply);
    expect(Object.keys(outline).sort()).toEqual(
      [
        'kind',
        'bill',
        'sponsor',
        'statute',
        'milestones',
        'provenance',
        'sections',
        'disclosure',
      ].sort(),
    );
    expect(outline).toMatchObject({
      kind: 'outline',
      sponsor: {
        name: 'François-Philippe Champagne',
        personId: '88633',
        riding: 'Saint-Maurice—Champlain',
        title: {
          en: 'Minister of Finance and National Revenue',
          fr: 'ministre des Finances et du Revenu national',
        },
      },
      statute: { year: 2026, chapter: '3', citation: 'S.C. 2026, c. 3' },
      milestones: parsed.milestones,
    });
    expect(Object.values(outline.milestones ?? {})).not.toContain(null);
    expect(outline.sections).toEqual(
      sectionNames.map((name) => ({
        name,
        count: name === 'publications' ? 4 : name === 'webReferences' ? 21 : null,
      })),
    );
    expect(wireBytes(reply)).toBeLessThanOrEqual(24_000);
    expect(http.calls).toHaveLength(2);
  });
  it('returns 44-1 C-69 summary.en alone and whole, with the oversized-section disclosure', async () => {
    const { parsed, ...bill } = routeReal('44-1-c-69');
    const reply = await call({ ...bill, section: 'summary.en' });
    const page = check(reply);
    expect(page).toEqual({
      kind: 'section',
      totalCount: null,
      bill: parsed.bill,
      provenance: expect.any(Array),
      summary: { en: parsed.summary.en },
      pagination: { section: 'summary.en', offset: 0, limit: 20, total: null, nextOffset: null },
      disclosure:
        'One indivisible record or scalar section exceeds the serialized response budget; returned whole without truncation.',
    });
    expect(parsed.summary.en?.length).toBeGreaterThan(28_000);
    expect(wireBytes(reply)).toBeGreaterThan(24_000);
  });
  it.each([
    ['summary.fr', 'summary', 'fr'],
    ['notes.en', 'notes', 'en'],
    ['notes.fr', 'notes', 'fr'],
  ] as const)('returns 44-1 C-69 %s as its one language', async (section, field, language) => {
    const { parsed, ...bill } = routeReal('44-1-c-69');
    const page = check(await call({ ...bill, section }));
    expect(page[field]).toEqual({ [language]: parsed[field][language] });
    expect(page.pagination).toMatchObject({ section, total: null, nextOffset: null });
    expect(parsed[field][language]).toEqual(expect.any(String));
  });
  it('returns the milestones section of 45-1 C-15 without disclosure', async () => {
    const { parsed, ...bill } = routeReal('45-1-c-15');
    const page = check(await call({ ...bill, section: 'milestones' }));
    expect(page.milestones).toEqual(parsed.milestones);
    expect(page).toMatchObject({ totalCount: null, pagination: { total: null, nextOffset: null } });
    expect(page.disclosure).toBeUndefined();
  });
  // Each page decodes content[] through two CommonMark parsers, which runs past 5 s under load.
  it('pages all 23 web references of 42-1 C-86 by whole records under the byte budget', async () => {
    const { parsed, ...bill } = routeReal('42-1-c-86');
    expect(parsed.webReferences).toHaveLength(23);
    const rebuilt: unknown[] = [];
    const sizes: number[] = [];
    let offset = 0;
    do {
      const reply = await call({ ...bill, section: 'webReferences', offset });
      const page = check(reply);
      expect(page).toMatchObject({ totalCount: 23, pagination: { offset, limit: 20, total: 23 } });
      const shown = page.webReferences?.length ?? 0;
      // A page shorter than the effective limit and the remaining records is a budget stop.
      expect(page.disclosure).toBe(
        shown < Math.min(20, 23 - offset) ? budgetStop(shown) : undefined,
      );
      expect(wireBytes(reply)).toBeLessThanOrEqual(24_000);
      sizes.push(shown);
      rebuilt.push(...(page.webReferences ?? []));
      offset = page.pagination?.nextOffset ?? -1;
    } while (offset !== -1);
    expect(rebuilt).toEqual(parsed.webReferences);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.min(...sizes)).toBeGreaterThan(0);
    const past = check(await call({ ...bill, section: 'webReferences', offset: 23 }));
    expect(past).toMatchObject({
      webReferences: [],
      pagination: { offset: 23, total: 23, nextOffset: null },
      disclosure: 'Offset is past the end of this section.',
    });
    expect(http.calls).toHaveLength(2);
  }, 20_000);
  it('relays http and citation reference values as text on both surfaces', async () => {
    const { parsed, ...bill } = routeReal('41-1-c-38');
    const page = check(await call({ ...bill, section: 'webReferences' }));
    expect(page.webReferences).toEqual(parsed.webReferences);
    expect(page.webReferences?.[0]?.url).toEqual({
      en: 'http://www.fin.gc.ca/n12/12-050-eng.asp',
      fr: 'http://www.fin.gc.ca/n12/12-050-fra.asp',
    });
  });
  it('returns the 35-1 C-1 dossier whole with null new leaves and no web references', async () => {
    const { parsed, ...bill } = routeReal('35-1-c-1');
    const full = check(await call(bill));
    expect(full.kind).toBeUndefined();
    expect(full).toMatchObject({
      sponsor: { title: { en: null, fr: null } },
      summary: { en: null, fr: null },
      notes: { en: null, fr: null },
      milestones: parsed.milestones,
      webReferences: [],
    });
    const references = check(await call({ ...bill, section: 'webReferences' }));
    expect(references).toMatchObject({ webReferences: [], disclosure: 'Section has no records.' });
  });
  it('states the published fractional-second date-time shape for assent and milestones', () => {
    expect(BillSummarySchema.shape.royalAssentDate.description).toBe(
      'Royal assent as a UTC instant ending in Z (YYYY-MM-DDTHH:MM:SS[.fraction]Z), or null; a value in another shape is relayed as published.',
    );
    expect(getBillTool.output.shape.milestones.unwrap().description).toBe(
      'Reading milestones as UTC instants ending in Z (YYYY-MM-DDTHH:MM:SS[.fraction]Z); a value in another shape is relayed as published. Royal assent is bill.royalAssentDate.',
    );
  });
  it('describes division date-times as the LEGISinfo sitting date-time', () => {
    const divisions = getBillTool.output.shape.divisions.unwrap().unwrap().element;
    expect(divisions.shape.dateTime.description).toContain('LEGISinfo sitting date-time');
  });
  it('declares unknown_session for malformed and unsupported sessions alike', () => {
    expect(getBillTool.errors?.find(({ reason }) => reason === 'unknown_session')?.when).toBe(
      'Malformed or unsupported official bill session.',
    );
  });
});
