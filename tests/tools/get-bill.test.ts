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
