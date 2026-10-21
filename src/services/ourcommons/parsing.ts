/** @fileoverview Strict House XML and session picker mapping. @module services/ourcommons/parsing */
import { serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { XMLParser } from 'fast-xml-parser';
import { parseHTML } from 'linkedom';
import { assertRepresentableText } from '@/domain/normalization.js';
import type {
  Division,
  MemberVote,
  OurCommonsMember,
  RecordedBallot,
  VoteParticipant,
  VoteSession,
} from './types.js';

type RecordValue = Record<string, unknown>;
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  htmlEntities: false,
});
/** Deterministic malformed-source failure, never retried. */
function malformed(field: string): never {
  throw serializationError('House source response does not match its expected schema.', {
    reason: 'upstream_response_invalid',
    field,
    retryable: false,
  });
}
function object(value: unknown, field: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed(field);
  return value as RecordValue;
}
function decode(value: string): string {
  if (/&(?!(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);)/.test(value))
    return malformed('XML character reference');
  const text = value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (entity, token: string) => {
      if (token.startsWith('#')) {
        const point =
          token[1]?.toLowerCase() === 'x'
            ? Number.parseInt(token.slice(2), 16)
            : Number(token.slice(1));
        if (point < 1 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
          return malformed('XML character reference');
        return String.fromCodePoint(point);
      }
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[token] ??
        entity
      );
    },
  );
  assertRepresentableText(text);
  return text;
}
function text(row: RecordValue, key: string): string | null {
  const value = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    const node = object(value, key);
    if (node['@_xsi:nil'] === 'true' || node['@_xsi:nil'] === '1') return null;
    return malformed(key);
  }
  if (typeof value !== 'string') return malformed(key);
  return decode(value);
}
function required(row: RecordValue, key: string): string {
  const value = text(row, key);
  if (value === null || !value.trim()) return malformed(key);
  return value;
}
function integer(row: RecordValue, key: string, nullable = false): number | null {
  const value = text(row, key);
  if (value === null && nullable) return null;
  if (value === null || !/^\d+$/.test(value)) return malformed(key);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return malformed(key);
  return number;
}
function positive(row: RecordValue, key: string): number {
  const value = integer(row, key);
  if (value === null || value < 1) return malformed(key);
  return value;
}
function records(xml: string, root: string, child: string): RecordValue[] {
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(xml))
    throw serviceUnavailable('House source returned HTML instead of XML.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return malformed('XML');
  let document: unknown;
  try {
    document = parser.parse(xml, true);
  } catch {
    return malformed('XML');
  }
  const parsed = object(document, 'XML');
  if (!Object.hasOwn(parsed, root)) return malformed(root);
  const value = parsed[root];
  if (value === '') return [];
  const container = object(value, root);
  if (container['@_xsi:nil'] === 'true' || container['@_xsi:nil'] === '1') return malformed(root);
  const rows = container[child];
  if (rows === undefined) {
    if (Object.keys(container).some((key) => !key.startsWith('@_'))) return malformed(child);
    return [];
  }
  return (Array.isArray(rows) ? rows : [rows]).map((row) => object(row, child));
}
function person(row: RecordValue) {
  const personId = String(positive(row, 'PersonId'));
  const firstName = required(row, 'PersonOfficialFirstName');
  const lastName = required(row, 'PersonOfficialLastName');
  return {
    personId,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    party: text(row, 'CaucusShortName'),
    riding: text(row, 'ConstituencyName'),
    province: text(row, 'ConstituencyProvinceTerritoryName'),
    url: `https://www.ourcommons.ca/Members/en/${personId}`,
  };
}
function rowSession(row: RecordValue): string {
  return `${positive(row, 'ParliamentNumber')}-${positive(row, 'SessionNumber')}`;
}
function identity(row: RecordValue, session: string): void {
  if (rowSession(row) !== session) malformed('session identity');
}
function unique<T>(rows: T[], key: (row: T) => string): T[] {
  if (new Set(rows.map(key)).size !== rows.length) malformed('duplicate identity');
  return rows;
}
function billCode(row: RecordValue): string | null {
  const code = text(row, 'BillNumberCode');
  if (code && !/^[CS]-[1-9]\d*[A-Z]?$/.test(code)) malformed('BillNumberCode');
  return code || null;
}
function divisionUrl(session: string, number: number): string {
  return `https://www.ourcommons.ca/Members/en/votes/${session.replace('-', '/')}/${number}`;
}
/** Recorded ballot whose `IsVote*` flags, when present, agree with it. */
function recordedBallot(row: RecordValue): RecordedBallot {
  const ballot = required(row, 'VoteValueName');
  if (ballot !== 'Yea' && ballot !== 'Nay' && ballot !== 'Paired')
    return malformed('VoteValueName');
  for (const value of ['Yea', 'Nay', 'Paired']) {
    const flag = text(row, `IsVote${value}`);
    if (flag === null) continue;
    if (
      !['true', 'false', '1', '0'].includes(flag) ||
      ['true', '1'].includes(flag) !== (ballot === value)
    )
      malformed(`IsVote${value}`);
  }
  return ballot;
}
/** Parse the real HTML session picker without executing page scripts. */
export function parseVoteSessions(html: string): VoteSession[] {
  // The live page uses HTML's --!> comment terminator, unsupported by linkedom.
  const { document } = parseHTML(html.replace(/--!>/g, '-->'));
  const sessions = [...document.querySelectorAll('[data-input="parlSession"][data-value]')].flatMap(
    (element) => {
      const session = element.getAttribute('data-value');
      if (session === 'all') return [];
      if (!session || !/^[1-9]\d*-[1-9]\d*$/.test(session))
        return malformed('session picker token');
      const [parliament, sessionNumber] = session.split('-').map(Number);
      if (
        !parliament ||
        !sessionNumber ||
        !Number.isSafeInteger(parliament) ||
        !Number.isSafeInteger(sessionNumber)
      )
        return malformed('session picker token');
      return [
        {
          session,
          parliament,
          sessionNumber,
          label: element.textContent.trim().replace(/\s+/gu, ' '),
        },
      ];
    },
  );
  if (!sessions.length) return malformed('session picker');
  return unique(sessions, (row) => row.session);
}
/** Parse the complete current roster. */
export function parseMembers(xml: string): OurCommonsMember[] {
  return unique(
    records(xml, 'ArrayOfMemberOfParliament', 'MemberOfParliament').map((row) => {
      const member = person(row);
      return {
        ...member,
        current: true as const,
        slug: null,
        detailLookup: { personId: member.personId },
      };
    }),
    (row) => row.personId,
  );
}
/** Parse and verify every division against the requested session. */
export function parseVotes(xml: string, session: string): Division[] {
  return unique(
    records(xml, 'ArrayOfVote', 'Vote').map((row) => {
      identity(row, session);
      const number = positive(row, 'DecisionDivisionNumber');
      return {
        session,
        number,
        dateTime: text(row, 'DecisionEventDateTime'),
        subject: text(row, 'DecisionDivisionSubject'),
        result: text(row, 'DecisionResultName'),
        yeas: integer(row, 'DecisionDivisionNumberOfYeas', true),
        nays: integer(row, 'DecisionDivisionNumberOfNays', true),
        paired: integer(row, 'DecisionDivisionNumberOfPaired', true),
        documentType: text(row, 'DecisionDivisionDocumentTypeName'),
        billCode: billCode(row),
        url: divisionUrl(session, number),
      };
    }),
    (row) => String(row.number),
  );
}
/** Parse recorded ballots and reject conflicting identity or boolean flags. */
export function parseVoteParticipants(
  xml: string,
  session: string,
  number: number,
): VoteParticipant[] {
  return unique(
    records(xml, 'ArrayOfVoteParticipant', 'VoteParticipant').map((row) => {
      identity(row, session);
      if (positive(row, 'DecisionDivisionNumber') !== number) malformed('division identity');
      return { ...person(row), ballot: recordedBallot(row) };
    }),
    (row) => row.personId,
  );
}
/**
 * Parse one member's recorded ballots: every row is that person's, all rows share one session (the
 * requested one when given; otherwise the member's latest, which the feed chooses), each division
 * appears once, and date-times are source `YYYY-MM-DDTHH:MM:SS` text.
 */
export function parseMemberVotes(xml: string, personId: string, session?: string): MemberVote[] {
  let feedSession = session;
  return unique(
    records(xml, 'ArrayOfMemberVote', 'MemberVote').map((row) => {
      if (String(positive(row, 'PersonId')) !== personId) malformed('person identity');
      const current = rowSession(row);
      feedSession ??= current;
      if (current !== feedSession) malformed('session identity');
      const number = positive(row, 'DecisionDivisionNumber');
      const dateTime = text(row, 'DecisionEventDateTime');
      if (dateTime !== null && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(dateTime))
        malformed('DecisionEventDateTime');
      return {
        session: current,
        number,
        dateTime,
        subject: text(row, 'DecisionDivisionSubject'),
        result: text(row, 'DecisionResultName'),
        billCode: billCode(row),
        ballot: recordedBallot(row),
        url: divisionUrl(current, number),
      };
    }),
    (row) => String(row.number),
  );
}
