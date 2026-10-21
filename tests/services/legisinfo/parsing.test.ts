/**
 * @fileoverview Official nested and sparse LEGISinfo parsing contracts.
 * @module tests/services/legisinfo/parsing.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import type { JsonRecord } from '@/domain/schemas.js';
import {
  parseBillDossier,
  parseBillRecords,
  parseBillSummary,
  parseCurrentSession,
  parseSessions,
} from '@/services/legisinfo/parsing.js';
import { realDossier } from '../../fixtures/bill-tools/harness.js';

const identity = { ParliamentNumber: 45, SessionNumber: 1, NumberCode: 'C-901' };
const dossier = (row: JsonRecord) => parseBillDossier([row], '45-1', 'C-901');
const invalid = expect.objectContaining({
  data: expect.objectContaining({ reason: 'upstream_response_invalid', retryable: false }),
});
type RealDossier = Parameters<typeof realDossier>[0];
const realRow = (name: RealDossier) => parseBillRecords(realDossier(name))[0] as JsonRecord;
const real = (name: RealDossier) => {
  const row = realRow(name);
  return parseBillDossier(
    [row],
    `${row.ParliamentNumber}-${row.SessionNumber}`,
    String(row.NumberCode),
  );
};

describe('official bill records', () => {
  it.each([
    [{ IsHouseBill: true, IsSenateBill: false, OriginatingChamberOrganizationId: 1 }, 'House'],
    [{ IsHouseBill: false, IsSenateBill: true, OriginatingChamberOrganizationId: 2 }, 'Senate'],
    [{ OriginatingChamberNameEn: 'House of Commons' }, 'House'],
    [{ OriginatingChamberNameEn: 'House' }, 'House'],
    [{ OriginatingChamberNameEn: 'Senate', OriginatingChamberOrganizationId: 2 }, 'Senate'],
    [{ OriginatingChamberOrganizationId: 1 }, 'House'],
    [{ IsSenateBill: true }, 'Senate'],
    [{ IsHouseBill: false, IsSenateBill: false }, null],
    [{}, null],
  ])('reconciles explicit originating chamber %j', (fields, chamber) => {
    expect(parseBillSummary({ ...identity, ...fields }).originatingChamber).toBe(chamber);
    expect(dossier({ ...identity, ...fields }).bill.originatingChamber).toBe(chamber);
  });
  it.each([
    { OriginatingChamberNameEn: 'Senate', IsHouseBill: true },
    { IsHouseBill: true, IsSenateBill: true },
    { OriginatingChamberOrganizationId: 1, IsHouseBill: false },
    { OriginatingChamberNameEn: 'Senate', IsSenateBill: false },
    { OriginatingChamberNameEn: 'House of Commons', OriginatingChamberOrganizationId: 2 },
    { OriginatingChamberNameEn: 'Parliament' },
    { OriginatingChamberOrganizationId: 0 },
    { OriginatingChamberOrganizationId: '1' },
  ])('rejects contradictory chamber evidence %j', (fields) => {
    expect(() => parseBillSummary({ ...identity, ...fields })).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'upstream_response_invalid', retryable: false }),
      }),
    );
  });
  const major = (name: string | null, organization: number | null, extra: JsonRecord = {}) => ({
    ...identity,
    LatestCompletedMajorStageNameEn: 'Royal assent',
    LatestCompletedMajorStageChamberNameEn: name,
    LatestCompletedMajorStageChamberOrganizationId: organization,
    ...extra,
  });
  it.each([
    ['organization ID 1 only', major(null, 1), 'House'],
    ['organization ID 2 only', major(null, 2), 'Senate'],
    ['House of Commons only', major('House of Commons', null), 'House'],
    ['House only', major('House', null), 'House'],
    ['Senate only', major('Senate', null), 'Senate'],
    ['agreeing House of Commons and 1', major('House of Commons', 1), 'House'],
    ['agreeing Senate and 2', major('Senate', 2), 'Senate'],
    ['neither', major(null, null), null],
    [
      'originating flags that do not apply',
      major(null, 1, { IsHouseBill: false, IsSenateBill: true }),
      'House',
    ],
  ])('reconciles the latest major stage chamber from %s', (_case, row, chamber) => {
    for (const bill of [parseBillSummary(row), dossier(row).bill])
      expect(bill.latestMajorStage).toEqual({ name: 'Royal assent', chamber });
  });
  it.each([
    ['contradictory name and ID', major('House of Commons', 2)],
    ['contradictory Senate and 1', major('Senate', 1)],
    ['an unknown name', major('Parliament', null)],
    ['an unknown organization ID', major(null, 3)],
    ['a placeholder organization ID', major(null, 0)],
  ])('rejects a latest major stage chamber with %s on both feeds', (_case, row) => {
    for (const parse of [() => parseBillSummary(row), () => dossier(row)])
      expect(parse).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ reason: 'upstream_response_invalid', retryable: false }),
        }),
      );
  });
  const assent = (value: string | null) => ({ ...identity, ReceivedRoyalAssentDateTime: value });
  it.each([
    [
      'an Ottawa daylight instant',
      '2026-03-26T06:50:00-04:00',
      '2026-03-26T10:50:00',
      '2026-03-26T10:50:00Z',
    ],
    [
      'a date-only midnight',
      '2018-06-20T20:00:00-04:00',
      '2018-06-21T00:00:00',
      '2018-06-21T00:00:00Z',
    ],
    [
      'an Ottawa standard-time midnight',
      '2012-12-13T19:00:00-05:00',
      '2012-12-14T00:00:00',
      '2012-12-14T00:00:00Z',
    ],
    [
      'fractional seconds',
      '2017-10-06T08:28:30.38-04:00',
      '2017-10-06T12:28:30.38',
      '2017-10-06T12:28:30.38Z',
    ],
    [
      'a positive offset',
      '2026-03-27T00:20:00+05:30',
      '2026-03-26T18:50:00Z',
      '2026-03-26T18:50:00Z',
    ],
    [
      'an explicit UTC designator',
      '2026-03-26T10:50:00Z',
      '2026-03-26T06:50:00-04:00',
      '2026-03-26T10:50:00Z',
    ],
  ])(
    'reports royal assent from %s as one UTC instant on both feeds',
    (_case, list, detail, instant) => {
      expect(parseBillSummary(assent(list)).royalAssentDate).toBe(instant);
      expect(dossier(assent(detail)).bill.royalAssentDate).toBe(instant);
    },
  );
  it.each([
    ['a date without a time', '2026-01-03'],
    ['free text', 'pending'],
    ['an impossible calendar date', '2026-02-30T00:00:00-05:00'],
    ['hour 24', '2026-03-26T24:00:00-04:00'],
    ['an out-of-range offset', '2026-03-26T06:50:00-25:00'],
  ])('relays royal assent with %s as published on both feeds', (_case, value) => {
    expect(parseBillSummary(assent(value)).royalAssentDate).toBe(value);
    expect(dossier(assent(value)).bill.royalAssentDate).toBe(value);
  });
  it('relays an offset-less list clock, whose zone the list never states, and keeps absence null', () => {
    expect(parseBillSummary(assent('2026-03-26T10:50:00')).royalAssentDate).toBe(
      '2026-03-26T10:50:00',
    );
    for (const value of [null, '  '])
      expect([
        parseBillSummary(assent(value)).royalAssentDate,
        dossier(assent(value)).bill.royalAssentDate,
      ]).toEqual([null, null]);
  });
  it('keeps the latest major stage null only when both its name and chamber are absent', () => {
    expect(parseBillSummary(identity).latestMajorStage).toBeNull();
    expect(
      parseBillSummary({ ...identity, LatestCompletedMajorStageChamberOrganizationId: 2 })
        .latestMajorStage,
    ).toEqual({ name: null, chamber: 'Senate' });
    expect(
      parseBillSummary({ ...identity, LatestCompletedMajorStageNameEn: 'First reading' })
        .latestMajorStage,
    ).toEqual({ name: 'First reading', chamber: null });
  });
  it.each(['C-15A', 'C-10B', 'C-333A', 'S-1001'])(
    'reads split-bill or plain code %s as the bill identity',
    (code) => {
      const row = { ...identity, NumberCode: code };
      expect(parseBillSummary(row)).toMatchObject({
        billCode: code,
        url: `https://www.parl.ca/legisinfo/en/bill/45-1/${code.toLowerCase()}`,
      });
      expect(parseBillDossier([row], '45-1', code).bill.billCode).toBe(code);
    },
  );
  it.each(['C-15AB', 'C-15A1', 'C-15a', 'C-015', 'C 15A', 'C-A'])(
    'rejects malformed upstream bill code %s',
    (code) => {
      expect(() => parseBillSummary({ ...identity, NumberCode: code })).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ reason: 'upstream_response_invalid', retryable: false }),
        }),
      );
    },
  );
  it('reads nested chamber stages and retains variable event depth', () => {
    const event = {
      EventNameEn: 'Synthetic event',
      details: { steps: [null, false, { text: 'a\r\nb' }] },
    };
    const stage = {
      BillStageId: 901,
      BillStageNameEn: 'Synthetic stage',
      BillStageNameFr: 'Étape fictive',
      State: 2,
      StateNameEn: 'Not reached',
      StateAsOfDate: null,
      ChamberOrganizationId: 0,
      Committee: {
        CommitteeOrganizationId: 902,
        CommitteeAcronym: 'TEST',
        CommitteeNameEn: 'Synthetic committee',
      },
      Sittings: [
        { Number: 3, Date: '2026-01-02', NameEn: 'Synthetic sitting', IsPublished: false },
      ],
      CommitteeMeetings: [{ Number: '04', CommitteeOrganizationId: 902, CommitteeAcronym: 'TEST' }],
      Decisions: [event],
      SignificantEvents: [event],
      EndOfStageEvent: event,
    };
    const result = dossier({
      ...identity,
      HouseBillStages: [{ BillStageId: 999 }],
      BillStages: {
        HouseBillStages: [stage, { BillStageId: 903, Sittings: [] }],
        SenateBillStages: [stage],
        RoyalAssent: [{ BillStageId: 904, State: null }],
      },
      SponsorPersonName: 'Alex Example',
      SponsorPersonId: 905,
      SponsorConstituencyNameEn: 'Example North',
      HouseVoteDetails: [
        {
          DivisionNumber: 906,
          DivisionSubjectEn: 'Synthetic division',
          DivisionVotesYeas: 0,
          DivisionVotesNays: 5,
          DivisionVotePaired: 2,
          DivisionVoteTotal: 7,
        },
      ],
      SenateVoteDetails: [event],
      Publications: [
        {
          PublicationId: 907,
          PublicationTypeId: 1,
          PublicationTypeNameEn: 'Synthetic publication',
        },
      ],
      StatuteYear: 2026,
      StatuteChapter: 12,
    });
    expect(result.stages.house).toHaveLength(2);
    expect(result.stages.house?.[0]).toMatchObject({
      id: 901,
      chamber: 'House',
      committee: { id: 902 },
      sittings: [{ number: '3', published: false }],
      committeeMeetings: [{ number: '04', committeeId: 902 }],
      decisions: [event],
      significantEvents: [event],
      endOfStageEvent: event,
    });
    expect(result.stages.house?.[1]?.sittings).toEqual([]);
    expect(result.stages.senate?.[0]?.chamber).toBe('Senate');
    expect(result.stages.royalAssent?.[0]).toMatchObject({ chamber: null, state: { id: null } });
    expect(result.sponsor).toEqual({
      name: 'Alex Example',
      personId: '905',
      riding: 'Example North',
      title: { en: null, fr: null },
    });
    expect(result.divisions?.[0]).toMatchObject({
      session: '45-1',
      number: 906,
      yeas: 0,
      nays: 5,
      paired: 2,
      total: 7,
      url: 'https://www.ourcommons.ca/Members/en/votes/45/1/906',
    });
    expect(result.senateVoteDetails).toEqual([event]);
    expect(result.publications?.[0]?.url).toBe('https://www.parl.ca/DocumentViewer/en/907');
    expect(result.statute).toEqual({ year: 2026, chapter: '12', citation: 'S.C. 2026, c. 12' });
  });

  it.each([35, 36])(
    'preserves sparse parliament %i records without invented data',
    (parliament) => {
      const result = parseBillDossier(
        [{ ...identity, ParliamentNumber: parliament, SponsorPersonName: '  ' }],
        `${parliament}-1`,
        'C-901',
      );
      expect(result).toMatchObject({
        sponsor: { name: null, personId: null, riding: null },
        stages: { house: null, senate: null, royalAssent: null },
        publications: null,
        divisions: null,
        senateVoteDetails: null,
        statute: null,
      });
    },
  );

  it('distinguishes omitted, null and explicitly empty collections', () => {
    expect(dossier({ ...identity, BillStages: null }).stages).toEqual({
      house: null,
      senate: null,
      royalAssent: null,
    });
    expect(
      dossier({
        ...identity,
        BillStages: { HouseBillStages: [], SenateBillStages: null, RoyalAssent: [] },
        HouseVoteDetails: [],
        Publications: [],
        SenateVoteDetails: [],
      }),
    ).toMatchObject({
      stages: { house: [], senate: null, royalAssent: [] },
      divisions: [],
      publications: [],
      senateVoteDetails: [],
    });
    expect(
      dossier({ ...identity, StatuteYear: 2026, StatuteChapter: 'A-2' }).statute?.chapter,
    ).toBe('A-2');
    expect(dossier({ ...identity, StatuteYear: 2026 }).statute).toBeNull();
  });

  it('uses major stage and canonical chamber while preserving bilingual whitespace', () => {
    expect(
      parseBillSummary({
        ...identity,
        LongTitleEn: '  Example\n',
        OriginatingChamberNameEn: 'House of Commons',
        LatestCompletedMajorStageNameEn: 'Major',
        LatestCompletedMajorStageChamberNameEn: 'House',
        LatestEventNameEn: 'Minor',
      }),
    ).toMatchObject({
      longTitle: { en: '  Example\n', fr: null },
      originatingChamber: 'House',
      latestMajorStage: { name: 'Major', chamber: 'House' },
    });
  });

  it.each([
    { rows: [] },
    { rows: [{ ...identity, NumberCode: 'S-901' }] },
    { rows: [{ ...identity, SessionNumber: 2 }] },
  ])('requires the exact dossier identity: $rows', ({ rows }) => {
    expect(() => parseBillDossier(rows, '45-1', 'C-901')).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'bill_not_found', retryable: false }),
      }),
    );
  });
  it('rejects duplicated and mixed dossier records', () => {
    for (const rows of [
      [identity, identity],
      [identity, { ...identity, NumberCode: 'S-901' }],
    ]) {
      expect(() => parseBillDossier(rows, '45-1', 'C-901')).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ reason: 'upstream_response_invalid', retryable: false }),
        }),
      );
    }
  });
  it.each(['{', '{}', '[null]'])('rejects malformed JSON %s', (body) => {
    expect(() => parseBillRecords(body)).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'upstream_response_invalid', retryable: false }),
      }),
    );
  });
  it.each(['[{"text":"\\u0000"}]', '[{"text":"\\ud800"}]'])(
    'rejects unrepresentable source text without lossy replacement %s',
    (body) => {
      expect(() => parseBillRecords(body)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.SerializationError,
          message: 'Upstream text contains characters that cannot be represented losslessly.',
          data: expect.objectContaining({ retryable: false }),
        }),
      );
    },
  );
  it.each([
    { ...identity, ParliamentNumber: '45' },
    { ...identity, BillStages: { RoyalAssent: {} } },
    { ...identity, Publications: [{ PublicationId: 0 }] },
    {
      ...identity,
      BillStages: { HouseBillStages: [{ BillStageId: 1, Sittings: [{ IsPublished: 'false' }] }] },
    },
  ])('rejects invalid required and nested scalar shapes', (row) => {
    expect(() => dossier(row)).toThrow();
  });
});

describe('dossier summary, notes, web references, and reading milestones', () => {
  it('surfaces the sponsor title, all six reading milestones, and every web reference of 45-1 C-15', () => {
    const row = realRow('45-1-c-15');
    const result = real('45-1-c-15');
    expect(result.sponsor.title).toEqual({
      en: 'Minister of Finance and National Revenue',
      fr: 'ministre des Finances et du Revenu national',
    });
    expect(result.milestones).toEqual({
      houseFirstReading: '2025-11-18T15:12:48.157Z',
      houseSecondReading: '2025-12-10T16:01:20Z',
      houseThirdReading: '2026-02-26T16:29:18.793Z',
      senateFirstReading: '2026-02-26T10:15:00Z',
      senateSecondReading: '2026-03-10T10:10:00Z',
      senateThirdReading: '2026-03-26T10:10:00Z',
    });
    expect(result.bill.royalAssentDate).toBe('2026-03-26T10:50:00Z');
    const refs = row.WebReferences as JsonRecord[];
    expect(result.webReferences).toHaveLength(21);
    expect(result.webReferences).toEqual(
      refs.map((ref) => ({
        title: { en: ref.TitleEn, fr: ref.TitleFr },
        typeId: ref.WebReferenceTypeId,
        type: { en: ref.WebReferenceTypeNameEn, fr: ref.WebReferenceTypeNameFr },
        url: { en: ref.UrlEn, fr: ref.UrlFr },
      })),
    );
    expect(result.webReferences?.[0]).toEqual({
      title: {
        en: 'Legislative Costing Note - Enhancing the Scientific Research and Experimental Development Tax Incentives (Published 2026-02-12)',
        fr: "Note sur l'évaluation du coût d'une mesure législative - Bonifier les encouragements fiscaux pour la recherche scientifique et le développement expérimental (Publié 2026-02-12)",
      },
      typeId: 13,
      type: {
        en: 'Legislative Costing Note',
        fr: 'Note sur l’évaluation du coût d’une mesure législative',
      },
      url: {
        en: 'https://www.pbo-dpb.ca/en/publications/LEG-2526-011-S--enhancing-scientific-research-experimental-development-tax-incentives--bonifier-encouragements-fiscaux-recherche-scientifique-developpement-experimental?utm_source=posto&utm_medium=email&utm_campaign=LEG-2526-011-S',
        fr: 'https://www.pbo-dpb.ca/fr/publications/LEG-2526-011-S--enhancing-scientific-research-experimental-development-tax-incentives--bonifier-encouragements-fiscaux-recherche-scientifique-developpement-experimental',
      },
    });
    expect(result.webReferences?.[20]?.url).toEqual({
      en: 'Parlement du Canada. « 7. Section 8 : Projets de loi de finances ». La procédure du Sénat en pratique, 2015.',
      fr: 'https://sencanada.ca/fr/a-propos/references-procedures/procedure-du-senat-en-pratique/',
    });
  });

  it('relays http, blank, padded, and prose reference URLs as published', () => {
    expect(real('41-1-c-38').webReferences?.[0]).toMatchObject({
      typeId: 5,
      type: { en: 'Press Release', fr: 'Communiqué de presse' },
      url: {
        en: 'http://www.fin.gc.ca/n12/12-050-eng.asp',
        fr: 'http://www.fin.gc.ca/n12/12-050-fra.asp',
      },
    });
    const reference = {
      BillDocumentId: 0,
      TitleEn: 'Minister of Finance Introduces the Jobs and Economic Growth Act',
      TitleFr: 'Le ministre des Finances dépose la Loi sur l’emploi et la croissance économique',
      Title: 'Minister of Finance Introduces the Jobs and Economic Growth Act',
      WebReferenceTypeId: 5,
      WebReferenceTypeNameEn: 'Press Release',
      WebReferenceTypeNameFr: 'Communiqué de presse',
      WebReferenceTypeName: 'Press Release',
      UrlEn: '',
      UrlFr: '',
      Url: '',
    };
    expect(
      dossier({
        ...identity,
        WebReferences: [reference, { ...reference, UrlEn: ' https://x.test/a ', UrlFr: null }],
      }).webReferences,
    ).toEqual([
      {
        title: { en: reference.TitleEn, fr: reference.TitleFr },
        typeId: 5,
        type: { en: 'Press Release', fr: 'Communiqué de presse' },
        url: { en: null, fr: null },
      },
      {
        title: { en: reference.TitleEn, fr: reference.TitleFr },
        typeId: 5,
        type: { en: 'Press Release', fr: 'Communiqué de presse' },
        url: { en: ' https://x.test/a ', fr: null },
      },
    ]);
  });

  it('returns null summary, notes, and title leaves and no web references for 35-1 C-1', () => {
    expect(real('35-1-c-1')).toMatchObject({
      sponsor: { name: null, personId: null, riding: null, title: { en: null, fr: null } },
      summary: { en: null, fr: null },
      notes: { en: null, fr: null },
      webReferences: [],
      milestones: {
        houseFirstReading: '1994-01-18T00:00:00Z',
        houseSecondReading: null,
        houseThirdReading: null,
        senateFirstReading: null,
        senateSecondReading: null,
        senateThirdReading: null,
      },
    });
  });

  it.each([
    ['44-1-c-69', 10, 9],
    ['45-1-c-15', 11, 11],
  ] as const)(
    'keeps every notes link of %s as text (href) in source order without markup',
    (name, en, fr) => {
      const row = realRow(name);
      const { notes, summary } = real(name);
      for (const [language, count] of [
        ['En', en],
        ['Fr', fr],
      ] as const) {
        const { document } = parseHTML(`<div id="root">${row[`Notes${language}`]}</div>`);
        const anchors = [...document.querySelectorAll('#root a')];
        expect(anchors).toHaveLength(count);
        const text = notes[language === 'En' ? 'en' : 'fr'] ?? '';
        let cursor = 0;
        for (const anchor of anchors) {
          const rendered = `${anchor.textContent} (${anchor.getAttribute('href')?.trim()})`;
          const at = text.indexOf(rendered, cursor);
          expect(at, rendered).toBeGreaterThanOrEqual(cursor);
          cursor = at + rendered.length;
        }
        for (const value of [text, summary.en, summary.fr])
          expect(value ?? '').not.toMatch(/<\/?[a-z][^>]*>/i);
      }
      if (name === '45-1-c-15')
        expect(notes.en).toContain(
          'the Standing Senate Committee on National Finance (https://sencanada.ca/en/committees/nffn/45-1)be authorized',
        );
    },
  );

  it('converts the heaviest sampled summary, 44-1 C-69, to plain text in each language', () => {
    const { summary } = real('44-1-c-69');
    expect(summary.en).toMatch(
      /^A legislative summary is currently being prepared for this bill by the Library of Parliament\. Meanwhile, the following executive summary is available\.\n\nOn 2 May 2024, /,
    );
    expect(Buffer.byteLength(summary.en ?? '')).toBe(28_143);
    expect(Buffer.byteLength(summary.fr ?? '')).toBe(34_118);
    for (const value of [summary.en, summary.fr]) {
      expect(value).not.toMatch(/<\/?[a-z][^>]*>/i);
      expect(value).toContain('\n');
    }
  });

  it('keeps absent, blank, and markup-only text null and preserves null versus empty references', () => {
    expect(dossier(identity)).toMatchObject({
      sponsor: { title: { en: null, fr: null } },
      summary: { en: null, fr: null },
      notes: { en: null, fr: null },
      webReferences: null,
      milestones: {
        houseFirstReading: null,
        houseSecondReading: null,
        houseThirdReading: null,
        senateFirstReading: null,
        senateSecondReading: null,
        senateThirdReading: null,
      },
    });
    expect(
      dossier({
        ...identity,
        SponsorAffiliationTitleEn: '  ',
        SponsorAffiliationTitleFr: 'député',
        ShortLegislativeSummaryEn: '',
        ShortLegislativeSummaryFr: '<div><br></div>',
        NotesEn: '<p></p>',
        NotesFr: '<div>Texte <b>gras</b></div>',
        WebReferences: [],
      }),
    ).toMatchObject({
      sponsor: { title: { en: null, fr: 'député' } },
      summary: { en: null, fr: null },
      notes: { en: null, fr: 'Texte gras' },
      webReferences: [],
    });
    expect(dossier({ ...identity, WebReferences: null }).webReferences).toBeNull();
  });

  it('maps each reading milestone from its own field and converts or relays it like royal assent', () => {
    expect(
      dossier({
        ...identity,
        PassedHouseFirstReadingDateTime: '2026-01-01T00:00:00',
        PassedHouseSecondReadingDateTime: '2026-01-02T00:00:00.5',
        PassedHouseThirdReadingDateTime: '2026-01-03T06:50:00-05:00',
        PassedSenateFirstReadingDateTime: '2026-01-04T00:00:00Z',
        PassedSenateSecondReadingDateTime: 'pending',
        PassedSenateThirdReadingDateTime: '  ',
        ReceivedRoyalAssentDateTime: '2026-01-07T00:00:00',
      }).milestones,
    ).toEqual({
      houseFirstReading: '2026-01-01T00:00:00Z',
      houseSecondReading: '2026-01-02T00:00:00.5Z',
      houseThirdReading: '2026-01-03T11:50:00Z',
      senateFirstReading: '2026-01-04T00:00:00Z',
      senateSecondReading: 'pending',
      senateThirdReading: null,
    });
  });

  it.each([
    { WebReferences: {} },
    { WebReferences: ['https://x.test/'] },
    { WebReferences: [{ WebReferenceTypeId: '8' }] },
    { WebReferences: [{ UrlEn: 7 }] },
    { WebReferences: [{ TitleFr: false }] },
    { NotesEn: 1 },
    { ShortLegislativeSummaryFr: ['<div></div>'] },
    { SponsorAffiliationTitleEn: {} },
    { PassedSenateThirdReadingDateTime: 20260326 },
  ])('rejects a malformed new dossier field %j', (fields) => {
    expect(() => dossier({ ...identity, ...fields })).toThrow(invalid);
  });
});

describe('session evidence', () => {
  it('uses exact picker selectors, excludes all, deduplicates and identifies basic coverage', () => {
    const html =
      '<a data-input="parlsession" data-value="all"></a><a data-input="other" data-value="99-1"></a>' +
      ['35-1', '36-2', '45-1', '45-1']
        .map((s) => `<a data-input="parlsession" data-value="${s}"></a>`)
        .join('');
    expect(parseSessions(html).map(({ session, coverage }) => ({ session, coverage }))).toEqual([
      { session: '35-1', coverage: 'basic' },
      { session: '36-2', coverage: 'basic' },
      { session: '45-1', coverage: 'full' },
    ]);
  });
  it.each([
    '',
    '<a data-input="parlsession" data-value="all"></a>',
    '<a data-input="parlsession" data-value="45-0"></a>',
  ])('rejects an absent or invalid picker', (body) => expect(() => parseSessions(body)).toThrow());
  it('requires consistent ongoing default-feed identities', () => {
    expect(
      parseCurrentSession([
        { ...identity, IsSessionOngoing: true },
        { ...identity, NumberCode: 'S-902', IsSessionOngoing: true },
      ]),
    ).toBe('45-1');
    for (const rows of [
      [],
      [identity],
      [{ ...identity, IsSessionOngoing: false }],
      [
        { ...identity, IsSessionOngoing: true },
        { ...identity, ParliamentNumber: 46, IsSessionOngoing: true },
      ],
    ])
      expect(() => parseCurrentSession(rows)).toThrow();
  });
});
