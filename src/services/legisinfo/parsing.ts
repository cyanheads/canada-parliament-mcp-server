/**
 * @fileoverview Strict official JSON and session-picker parsing without executable HTML.
 * @module services/legisinfo/parsing
 */
import { notFound, serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { parseHTML } from 'linkedom';
import { assertRepresentableText } from '@/domain/normalization.js';
import { type JsonRecord, JsonRecordSchema, type JsonValue } from '@/domain/schemas.js';
import type { BilingualText, BillDossier, BillSummary, LegisinfoSession, Stage } from './types.js';

/** Deterministic malformed-source failure; retries cannot repair schema drift. */
export function invalidResponse(): never {
  throw serializationError('LEGISinfo returned an invalid official record.', {
    reason: 'upstream_response_invalid',
    retryable: false,
  });
}
function record(value: unknown): JsonRecord {
  const result = JsonRecordSchema.safeParse(value);
  if (!result.success) invalidResponse();
  checkText(result.data);
  return result.data;
}
function checkText(value: JsonValue): void {
  if (typeof value === 'string') assertRepresentableText(value);
  else if (Array.isArray(value)) for (const entry of value) checkText(entry);
  else if (value !== null && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) {
      assertRepresentableText(key);
      checkText(entry);
    }
}
function text(value: JsonValue | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') invalidResponse();
  return value.trim() ? value : null;
}
function integer(value: JsonValue | undefined, required = false, positive = false): number | null {
  if (value == null && !required) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (positive && value <= 0))
    invalidResponse();
  return value;
}
function requiredInteger(value: JsonValue | undefined): number {
  return integer(value, true, true) as number;
}
function bilingual(row: JsonRecord, prefix: string): BilingualText {
  return { en: text(row[`${prefix}En`]), fr: text(row[`${prefix}Fr`]) };
}
function records(value: JsonValue | undefined): JsonRecord[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) invalidResponse();
  return value.map(record);
}
function scalar(value: JsonValue | undefined): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalidResponse();
    return String(value);
  }
  return text(value);
}
function bool(value: JsonValue | undefined): boolean | null {
  if (value == null) return null;
  if (typeof value !== 'boolean') invalidResponse();
  return value;
}
/** Parse a complete official JSON array; HTML outages remain transient. */
export function parseBillRecords(body: string): JsonRecord[] {
  if (/^\s*<(?:!doctype\s+html|html\b)/i.test(body))
    throw serviceUnavailable('LEGISinfo returned HTML instead of its JSON feed.');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    invalidResponse();
  }
  if (!Array.isArray(value)) invalidResponse();
  return value.map(record);
}
/** Verified identity, never inferred from requested URL alone. */
export function billIdentity(row: JsonRecord): { session: string; billCode: string } {
  const parliament = requiredInteger(row.ParliamentNumber);
  const session = requiredInteger(row.SessionNumber);
  const billCode = text(row.NumberCode);
  if (!billCode || !/^[CS]-[1-9]\d*$/.test(billCode)) invalidResponse();
  return { session: `${parliament}-${session}`, billCode };
}
/** Parse actual picker options, excluding the all-sessions choice. */
export function parseSessions(body: string): LegisinfoSession[] {
  const { document } = parseHTML(body);
  const seen = new Set<string>();
  const sessions: LegisinfoSession[] = [];
  for (const option of document.querySelectorAll('[data-input="parlsession"][data-value]')) {
    const value = option.getAttribute('data-value');
    if (value === 'all') continue;
    if (!value || !/^[1-9]\d*-[1-9]\d*$/.test(value)) invalidResponse();
    const [parliament, sessionNumber] = value.split('-').map(Number);
    if (
      !parliament ||
      !sessionNumber ||
      !Number.isSafeInteger(parliament) ||
      !Number.isSafeInteger(sessionNumber)
    )
      invalidResponse();
    if (!seen.has(value)) {
      seen.add(value);
      sessions.push({
        session: value,
        parliament,
        sessionNumber,
        coverage: parliament < 37 ? 'basic' : 'full',
      });
    }
  }
  if (!sessions.length) invalidResponse();
  return sessions;
}
/** Require the default feed to identify exactly one ongoing session. */
export function parseCurrentSession(rows: JsonRecord[]): string {
  if (!rows.length) invalidResponse();
  const sessions = new Set(
    rows.map((row) => {
      const identity = billIdentity(row);
      if (row.IsSessionOngoing !== true) invalidResponse();
      return identity.session;
    }),
  );
  if (sessions.size !== 1) invalidResponse();
  return [...sessions][0] as string;
}
/** Normalize a list row without substituting the latest minor event. */
export function parseBillSummary(row: JsonRecord): BillSummary {
  const identity = billIdentity(row);
  const name = text(row.LatestCompletedMajorStageNameEn);
  const chamber = text(row.LatestCompletedMajorStageChamberNameEn);
  const origin = text(row.OriginatingChamberNameEn);
  if (origin !== null && !['House of Commons', 'House', 'Senate'].includes(origin))
    invalidResponse();
  const organization = integer(row.OriginatingChamberOrganizationId);
  if (organization !== null && organization !== 1 && organization !== 2) invalidResponse();
  const house = bool(row.IsHouseBill);
  const senate = bool(row.IsSenateBill);
  const evidence = (
    [
      origin === null ? null : origin === 'Senate' ? 'Senate' : 'House',
      organization === null ? null : organization === 1 ? 'House' : 'Senate',
      house === true ? 'House' : null,
      senate === true ? 'Senate' : null,
    ] satisfies BillSummary['originatingChamber'][]
  ).filter((value) => value !== null);
  const identities = new Set(evidence);
  if (identities.size > 1) invalidResponse();
  const originatingChamber = evidence[0] ?? null;
  if (
    (originatingChamber === 'House' && house === false) ||
    (originatingChamber === 'Senate' && senate === false)
  )
    invalidResponse();
  return {
    ...identity,
    longTitle: bilingual(row, 'LongTitle'),
    shortTitle: bilingual(row, 'ShortTitle'),
    billType: text(row.BillDocumentTypeNameEn),
    originatingChamber,
    status: text(row.StatusNameEn),
    latestMajorStage: name === null && chamber === null ? null : { name, chamber },
    royalAssentDate: text(row.ReceivedRoyalAssentDateTime),
    url: `https://www.parl.ca/legisinfo/en/bill/${identity.session}/${identity.billCode.toLowerCase()}`,
  };
}
function parseStage(row: JsonRecord, chamber: Stage['chamber']): Stage {
  const committee = row.Committee == null ? null : record(row.Committee);
  return {
    id: requiredInteger(row.BillStageId),
    name: bilingual(row, 'BillStageName'),
    chamber,
    state: { id: integer(row.State), ...bilingual(row, 'StateName') },
    stateAsOf: text(row.StateAsOfDate),
    committee:
      committee === null
        ? null
        : {
            id: integer(committee.CommitteeOrganizationId),
            acronym: text(committee.CommitteeAcronym),
            name: bilingual(committee, 'CommitteeName'),
          },
    sittings:
      records(row.Sittings)?.map((sitting) => ({
        number: scalar(sitting.Number),
        date: text(sitting.Date),
        name: bilingual(sitting, 'Name'),
        published: bool(sitting.IsPublished),
      })) ?? null,
    committeeMeetings:
      records(row.CommitteeMeetings)?.map((meeting) => ({
        number: scalar(meeting.Number),
        date: text(meeting.Date),
        committeeId: integer(meeting.CommitteeOrganizationId),
        acronym: text(meeting.CommitteeAcronym),
        name: bilingual(meeting, 'CommitteeName'),
      })) ?? null,
    decisions: records(row.Decisions),
    significantEvents: records(row.SignificantEvents),
    endOfStageEvent: row.EndOfStageEvent == null ? null : record(row.EndOfStageEvent),
  };
}
/** Require one exact bill identity and preserve null versus empty collections. */
export function parseBillDossier(
  rows: JsonRecord[],
  session: string,
  billCode: string,
): BillDossier {
  const matching = rows.filter((row) => {
    const identity = billIdentity(row);
    return identity.session === session && identity.billCode === billCode;
  });
  if (!matching.length)
    throw notFound('The official bill dossier was not found.', {
      reason: 'bill_not_found',
      retryable: false,
    });
  if (matching.length !== 1 || rows.length !== 1) invalidResponse();
  const row = matching[0];
  if (!row) invalidResponse();
  const stages = row.BillStages == null ? null : record(row.BillStages);
  const year = integer(row.StatuteYear);
  const chapter = scalar(row.StatuteChapter);
  const personId =
    row.SponsorPersonId == null ? null : String(requiredInteger(row.SponsorPersonId));
  return {
    bill: parseBillSummary(row),
    sponsor: {
      name: text(row.SponsorPersonName),
      personId,
      riding: text(row.SponsorConstituencyNameEn),
    },
    stages: {
      house:
        stages === null
          ? null
          : (records(stages.HouseBillStages)?.map((stage) => parseStage(stage, 'House')) ?? null),
      senate:
        stages === null
          ? null
          : (records(stages.SenateBillStages)?.map((stage) => parseStage(stage, 'Senate')) ?? null),
      royalAssent:
        stages === null
          ? null
          : (records(stages.RoyalAssent)?.map((stage) => parseStage(stage, null)) ?? null),
    },
    divisions:
      records(row.HouseVoteDetails)?.map((division) => {
        const number = requiredInteger(division.DivisionNumber);
        return {
          session,
          number,
          subject: bilingual(division, 'DivisionSubject'),
          dateTime: text(division.DecisionDateTime),
          result: text(division.DecisionResultNameEn),
          yeas: integer(division.DivisionVotesYeas),
          nays: integer(division.DivisionVotesNays),
          paired: integer(division.DivisionVotePaired),
          total: integer(division.DivisionVoteTotal),
          url: `https://www.ourcommons.ca/Members/en/votes/${session.replace('-', '/')}/${number}`,
        };
      }) ?? null,
    senateVoteDetails: records(row.SenateVoteDetails),
    publications:
      records(row.Publications)?.map((publication) => {
        const id = requiredInteger(publication.PublicationId);
        return {
          id,
          typeId: integer(publication.PublicationTypeId),
          type: bilingual(publication, 'PublicationTypeName'),
          url: `https://www.parl.ca/DocumentViewer/en/${id}`,
        };
      }) ?? null,
    statute:
      year !== null && chapter !== null
        ? { year, chapter, citation: `S.C. ${year}, c. ${chapter}` }
        : null,
  };
}
