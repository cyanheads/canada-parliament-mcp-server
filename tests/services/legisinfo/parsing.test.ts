/**
 * @fileoverview Official nested and sparse LEGISinfo parsing contracts.
 * @module tests/services/legisinfo/parsing.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import type { JsonRecord } from '@/domain/schemas.js';
import {
  parseBillDossier,
  parseBillRecords,
  parseBillSummary,
  parseCurrentSession,
  parseSessions,
} from '@/services/legisinfo/parsing.js';

const identity = { ParliamentNumber: 45, SessionNumber: 1, NumberCode: 'C-901' };
const dossier = (row: JsonRecord) => parseBillDossier([row], '45-1', 'C-901');

describe('official bill records', () => {
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
