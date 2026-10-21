/**
 * @fileoverview Strict official JSON and session-picker parsing without executable HTML.
 * @module services/legisinfo/parsing
 */
import { notFound, serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { parseHTML } from 'linkedom';
import { htmlToText } from '@/domain/html-to-text.js';
import { assertRepresentableText } from '@/domain/normalization.js';
import {
  type BilingualText,
  type JsonRecord,
  JsonRecordSchema,
  type JsonValue,
} from '@/domain/schemas.js';
import type { BillDossier, BillSummary, Chamber, LegisinfoSession, Stage } from './types.js';

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
function integer(value: JsonValue | undefined): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidResponse();
  return value;
}
function requiredInteger(value: JsonValue | undefined): number {
  const result = integer(value);
  if (result === null || result <= 0) invalidResponse();
  return result;
}
function bilingual(row: JsonRecord, prefix: string): BilingualText {
  return { en: text(row[`${prefix}En`]), fr: text(row[`${prefix}Fr`]) };
}
/** Dossier HTML as plain text with link targets kept; markup without text is unavailable. */
function bilingualHtml(row: JsonRecord, prefix: string): BilingualText {
  const plain = (html: string | null) => {
    const result = html === null ? null : htmlToText(html, { linkTargets: true });
    return result?.trim() ? result : null;
  };
  const { en, fr } = bilingual(row, prefix);
  return { en: plain(en), fr: plain(fr) };
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
/** Which official feed a row came from; their date-time conventions differ. */
type Feed = 'list' | 'dossier';
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|([+-])([01]\d|2[0-3]):([0-5]\d))?$/;
/**
 * Express an official date-time as `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, keeping fraction digits as
 * published. Offset-bearing values convert; an offset-less clock is UTC in the dossier feed, while
 * the list feed never states its zone. Any other value is relayed as published.
 */
function utcInstant(value: string | null, feed: Feed): string | null {
  const match = value === null ? null : DATE_TIME.exec(value);
  if (!match || (match[3] === undefined && feed === 'list')) return value;
  const [, clock = '', fraction = '', , sign, hours = '0', minutes = '0'] = match;
  const local = Date.parse(`${clock}Z`);
  if (Number.isNaN(local) || new Date(local).toISOString().slice(0, 19) !== clock) return value;
  const offset = (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
  return `${new Date(local - offset).toISOString().slice(0, 19)}${fraction}Z`;
}
/** A dossier reading date-time in the same UTC representation as royal assent. */
function reading(value: JsonValue | undefined): string | null {
  return utcInstant(text(value), 'dossier');
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
  if (!billCode || !/^[CS]-[1-9]\d*[A-Z]?$/.test(billCode)) invalidResponse();
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
  const [session, ...others] = new Set(
    rows.map((row) => {
      const identity = billIdentity(row);
      if (row.IsSessionOngoing !== true) invalidResponse();
      return identity.session;
    }),
  );
  if (session === undefined || others.length) invalidResponse();
  return session;
}
/**
 * Reconcile `<prefix>NameEn` (`House of Commons`, `House`, `Senate`), `<prefix>OrganizationId`
 * (1 House, 2 Senate), and any positive chamber flags into one chamber. Disagreeing evidence, an
 * unknown value, or a false flag for the identified chamber is an invalid record; no evidence is
 * null.
 */
function reconcileChamber(
  row: JsonRecord,
  prefix: string,
  flags: Record<Chamber, boolean | null> = { House: null, Senate: null },
): Chamber | null {
  const name = text(row[`${prefix}NameEn`]);
  if (name !== null && !['House of Commons', 'House', 'Senate'].includes(name)) invalidResponse();
  const organization = integer(row[`${prefix}OrganizationId`]);
  if (organization !== null && organization !== 1 && organization !== 2) invalidResponse();
  const evidence = new Set<Chamber>();
  if (name !== null) evidence.add(name === 'Senate' ? 'Senate' : 'House');
  if (organization !== null) evidence.add(organization === 1 ? 'House' : 'Senate');
  for (const chamber of ['House', 'Senate'] as const)
    if (flags[chamber] === true) evidence.add(chamber);
  if (evidence.size > 1) invalidResponse();
  const [chamber = null] = evidence;
  if (chamber !== null && flags[chamber] === false) invalidResponse();
  return chamber;
}
/** Normalize a list or dossier row's summary without substituting the latest minor event. */
export function parseBillSummary(row: JsonRecord, feed: Feed = 'list'): BillSummary {
  const identity = billIdentity(row);
  const name = text(row.LatestCompletedMajorStageNameEn);
  const chamber = reconcileChamber(row, 'LatestCompletedMajorStageChamber');
  return {
    ...identity,
    longTitle: bilingual(row, 'LongTitle'),
    shortTitle: bilingual(row, 'ShortTitle'),
    billType: text(row.BillDocumentTypeNameEn),
    originatingChamber: reconcileChamber(row, 'OriginatingChamber', {
      House: bool(row.IsHouseBill),
      Senate: bool(row.IsSenateBill),
    }),
    status: text(row.StatusNameEn),
    latestMajorStage: name === null && chamber === null ? null : { name, chamber },
    royalAssentDate: utcInstant(text(row.ReceivedRoyalAssentDateTime), feed),
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
  const [row] = matching;
  if (!row)
    throw notFound('The official bill dossier was not found.', {
      reason: 'bill_not_found',
      retryable: false,
    });
  if (matching.length !== 1 || rows.length !== 1) invalidResponse();
  const stages = row.BillStages == null ? null : record(row.BillStages);
  const year = integer(row.StatuteYear);
  const chapter = scalar(row.StatuteChapter);
  const personId =
    row.SponsorPersonId == null ? null : String(requiredInteger(row.SponsorPersonId));
  return {
    bill: parseBillSummary(row, 'dossier'),
    sponsor: {
      name: text(row.SponsorPersonName),
      personId,
      riding: text(row.SponsorConstituencyNameEn),
      title: bilingual(row, 'SponsorAffiliationTitle'),
    },
    stages: {
      house: records(stages?.HouseBillStages)?.map((stage) => parseStage(stage, 'House')) ?? null,
      senate:
        records(stages?.SenateBillStages)?.map((stage) => parseStage(stage, 'Senate')) ?? null,
      royalAssent: records(stages?.RoyalAssent)?.map((stage) => parseStage(stage, null)) ?? null,
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
    summary: bilingualHtml(row, 'ShortLegislativeSummary'),
    notes: bilingualHtml(row, 'Notes'),
    milestones: {
      houseFirstReading: reading(row.PassedHouseFirstReadingDateTime),
      houseSecondReading: reading(row.PassedHouseSecondReadingDateTime),
      houseThirdReading: reading(row.PassedHouseThirdReadingDateTime),
      senateFirstReading: reading(row.PassedSenateFirstReadingDateTime),
      senateSecondReading: reading(row.PassedSenateSecondReadingDateTime),
      senateThirdReading: reading(row.PassedSenateThirdReadingDateTime),
    },
    webReferences:
      records(row.WebReferences)?.map((reference) => ({
        title: bilingual(reference, 'Title'),
        typeId: integer(reference.WebReferenceTypeId),
        type: bilingual(reference, 'WebReferenceTypeName'),
        url: bilingual(reference, 'Url'),
      })) ?? null,
  };
}
