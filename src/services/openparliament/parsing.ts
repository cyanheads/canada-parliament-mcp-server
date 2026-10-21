/**
 * @fileoverview Strict sparse OpenParliament parsers and safe pagination references.
 * @module services/openparliament/parsing
 */
import { serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { parseHTML } from 'linkedom';
import {
  assertRepresentableText,
  normalizeDate,
  normalizeProvince,
} from '@/domain/normalization.js';
import type {
  Ballot,
  BallotValue,
  BilingualText,
  Bill,
  Membership,
  Politician,
  PoliticianProfile,
  Speech,
  Vote,
} from './types.js';

/** Fixed request origin; returned public links use the public website. */
export const API_ORIGIN = 'https://api.openparliament.ca';
const PUBLIC_ORIGIN = 'https://openparliament.ca';
type RecordValue = Record<string, unknown>;
/** Deterministic upstream mismatches never enter a retry ladder. */
export function malformed(field: string): never {
  throw serializationError('OpenParliament returned a malformed response.', {
    field,
    retryable: false,
  });
}
/** Require an upstream JSON object. */
export function record(value: unknown, field = 'record'): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed(field);
  return value as RecordValue;
}
/** Missing source text remains null; wrong scalar types are malformed. */
export function text(value: unknown, field = 'text'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return malformed(field);
  assertRepresentableText(value);
  return value;
}
function requiredText(value: unknown, field: string): string {
  const result = text(value, field);
  if (!result) return malformed(field);
  return result;
}
function nested(value: unknown, key: string): unknown {
  return value == null ? undefined : record(value)[key];
}
function english(value: unknown): string | null {
  return text(nested(value, 'en'));
}
function bilingual(value: unknown): BilingualText {
  return { en: english(value), fr: text(nested(value, 'fr')) };
}
function province(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  try {
    return normalizeProvince(raw);
  } catch {
    return malformed('province');
  }
}
function date(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  try {
    return normalizeDate(raw);
  } catch {
    return malformed('date');
  }
}

/** Validate a source path without accepting arbitrary URLs or escaped separators. */
export function sourcePath(value: unknown, pattern: RegExp, field = 'url'): string {
  const raw = requiredText(value, field);
  let url: URL;
  try {
    url = new URL(raw, API_ORIGIN);
  } catch {
    return malformed(field);
  }
  if (
    ![API_ORIGIN, PUBLIC_ORIGIN].includes(url.origin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !pattern.test(url.pathname)
  )
    return malformed(field);
  return url.pathname;
}
/** Canonical actor path, used only after an identifier has been validated. */
export function politicianPath(value: unknown): string {
  return sourcePath(value, /^\/politicians\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/, 'politician');
}
/** Canonical historical membership path. */
export function membershipPath(value: unknown): string {
  return sourcePath(value, /^\/politicians\/memberships\/[1-9]\d*\/$/, 'membership');
}
function optionalPath(value: unknown, pattern: RegExp): string | null {
  return value == null ? null : `${PUBLIC_ORIGIN}${sourcePath(value, pattern)}`;
}
function publicLink(value: unknown): string {
  const raw = requiredText(value, 'link');
  let url: URL;
  try {
    url = new URL(raw, PUBLIC_ORIGIN);
  } catch {
    return malformed('link');
  }
  if (url.protocol !== 'https:' || url.username || url.password) return malformed('link');
  return url.href;
}
/** Parse JSON without repairing partial payloads. HTML failures are transient. */
export function parseJson(body: string): unknown {
  if (/^\s*</.test(body)) throw serviceUnavailable('OpenParliament returned HTML instead of JSON.');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return malformed('json');
  }
}
/** Validate continuation endpoint, complete filter multiset, and increasing offset. */
export function parsePage<T>(
  value: unknown,
  requested: URL,
  parse: (value: unknown) => T,
): { objects: T[]; nextOffset: number | null } {
  const root = record(value);
  if (!Array.isArray(root.objects)) return malformed('objects');
  const pagination = record(root.pagination, 'pagination');
  const offset = Number(requested.searchParams.get('offset'));
  const limit = Number(requested.searchParams.get('limit'));
  if (pagination.offset !== offset || pagination.limit !== limit || root.objects.length > limit)
    return malformed('pagination');
  const next = pagination.next_url;
  let nextOffset: number | null = null;
  if (next !== null) {
    if (typeof next !== 'string') return malformed('pagination.next_url');
    let url: URL;
    try {
      url = new URL(next, API_ORIGIN);
    } catch {
      return malformed('pagination.next_url');
    }
    if (
      url.origin !== API_ORIGIN ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== requested.pathname
    )
      return malformed('pagination.next_url');
    const params = new URLSearchParams(url.searchParams);
    if (params.has('format')) {
      if (params.getAll('format').length !== 1 || params.get('format') !== 'json')
        return malformed('pagination.format');
      params.delete('format');
    }
    const offsets = params.getAll('offset');
    if (offsets.length !== 1 || !/^\d+$/.test(offsets[0] ?? ''))
      return malformed('pagination.offset');
    nextOffset = Number(offsets[0]);
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset)
      return malformed('pagination.offset');
    params.delete('offset');
    const expected = new URLSearchParams(requested.searchParams);
    expected.delete('offset');
    expected.delete('format');
    params.sort();
    expected.sort();
    if (params.toString() !== expected.toString()) return malformed('pagination.filters');
  }
  return { objects: root.objects.map(parse), nextOffset };
}
/** Public index row, including genuinely sparse historical entries. */
export function parsePolitician(value: unknown): Politician {
  const raw = record(value);
  const path = politicianPath(raw.url);
  return {
    slug: path.split('/')[2] ?? malformed('slug'),
    name: requiredText(raw.name, 'name'),
    url: `${PUBLIC_ORIGIN}${path}`,
    party: english(nested(raw.current_party, 'short_name')),
    riding: english(nested(raw.current_riding, 'name')),
    province: province(nested(raw.current_riding, 'province')),
    imageUrl: raw.image == null ? null : publicLink(raw.image),
  };
}
/** Historical party and riding from the membership's own dates. */
export function parseMembership(value: unknown): Membership {
  const raw = record(value);
  return {
    url: `${PUBLIC_ORIGIN}${membershipPath(raw.url)}`,
    party: {
      name: english(nested(raw.party, 'name')),
      shortName: english(nested(raw.party, 'short_name')),
    },
    riding: english(nested(raw.riding, 'name')),
    province: province(nested(raw.riding, 'province')),
    startDate: date(raw.start_date),
    endDate: date(raw.end_date),
    label: english(raw.label),
    politicianUrl: optionalPath(raw.politician_url, /^\/politicians\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/),
  };
}
/** Profile parsing intentionally excludes contact details. */
export function parsePoliticianProfile(value: unknown): PoliticianProfile {
  const raw = record(value);
  const ids = nested(raw.other_info, 'parl_mp_id');
  let personIds: string[] | null = null;
  if (ids != null) {
    if (!Array.isArray(ids)) return malformed('parl_mp_id');
    personIds = ids.map((id) => {
      if (typeof id !== 'string' || !/^\d+$/.test(id)) return malformed('parl_mp_id');
      return id;
    });
  }
  if (raw.memberships != null && !Array.isArray(raw.memberships)) return malformed('memberships');
  if (raw.links != null && !Array.isArray(raw.links)) return malformed('links');
  return {
    ...parsePolitician(raw),
    personIds,
    givenName: text(raw.given_name),
    familyName: text(raw.family_name),
    gender: text(raw.gender),
    memberships:
      raw.memberships == null ? null : (raw.memberships as unknown[]).map(parseMembership),
    links:
      raw.links == null
        ? []
        : (raw.links as unknown[]).map((value) => {
            const link = record(value);
            return { url: publicLink(link.url), note: text(link.note) };
          }),
  };
}
/** Bill list and detail use the same identity, with absent list status kept null. */
export function parseBill(value: unknown): Bill {
  const raw = record(value);
  const path = sourcePath(raw.url, /^\/bills\/[1-9]\d*-[1-9]\d*\/[CS]-[1-9]\d*\/$/);
  const session = requiredText(raw.session, 'session');
  const billCode = requiredText(raw.number, 'number');
  if (path !== `/bills/${session}/${billCode}/`) return malformed('bill.identity');
  const id = raw.legisinfo_id;
  if (
    id != null &&
    !(
      (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === 'string' && /^[1-9]\d*$/.test(id))
    )
  )
    return malformed('legisinfo_id');
  return {
    session,
    billCode,
    legisinfoId: id == null ? null : String(id),
    title: bilingual(raw.name),
    status: english(raw.status),
    url: `${PUBLIC_ORIGIN}${path}`,
  };
}
/** Ballots retain the upstream's exact vote vocabulary. */
export function parseBallot(value: unknown): Ballot {
  const raw = record(value);
  const ballot = requiredText(raw.ballot, 'ballot');
  if (!['Yes', 'No', 'Paired', "Didn't vote"].includes(ballot)) return malformed('ballot');
  return {
    ballot: ballot as BallotValue,
    voteUrl: `${PUBLIC_ORIGIN}${sourcePath(raw.vote_url, /^\/votes\/[1-9]\d*-[1-9]\d*\/[1-9]\d*\/$/)}`,
    politicianUrl: `${PUBLIC_ORIGIN}${politicianPath(raw.politician_url)}`,
    membershipUrl: optionalPath(
      raw.politician_membership_url,
      /^\/politicians\/memberships\/[1-9]\d*\/$/,
    ),
  };
}
/** Vote identity must agree with its source path. */
export function parseVote(value: unknown): Vote {
  const raw = record(value);
  const path = sourcePath(raw.url, /^\/votes\/[1-9]\d*-[1-9]\d*\/[1-9]\d*\/$/);
  const session = requiredText(raw.session, 'session');
  const number = raw.number;
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    path !== `/votes/${session}/${number}/`
  )
    return malformed('vote.identity');
  return {
    session,
    number,
    date: date(raw.date),
    subject: english(raw.description),
    result: text(raw.result),
    url: `${PUBLIC_ORIGIN}${path}`,
  };
}
/** Convert source HTML to complete decoded prose, retaining paragraph and hard breaks. */
export function htmlToText(html: string): string {
  const { document } = parseHTML('<html><body></body></html>');
  const container = document.createElement('div');
  container.innerHTML = html;
  type HtmlNode = {
    nodeType: number;
    nodeName: string;
    textContent: string | null;
    childNodes: ArrayLike<HtmlNode>;
  };
  const blocks = new Set(['p', 'div', 'blockquote', 'li', 'section', 'h1', 'h2', 'h3', 'tr']);
  function visit(node: HtmlNode): string {
    if (node.nodeType === 3) return node.textContent ?? '';
    const name = node.nodeName.toLowerCase();
    if (name === 'br') return '\n';
    const children = Array.from(node.childNodes);
    const content = children
      .map((child, index) => {
        const adjacentBlock = [children[index - 1], children[index + 1]].some(
          (sibling) => sibling && blocks.has(sibling.nodeName.toLowerCase()),
        );
        if (child.nodeType === 3 && /^\s*$/.test(child.textContent ?? '') && adjacentBlock)
          return '';
        return visit(child);
      })
      .join('');
    return node !== container && blocks.has(name) ? `${content}\n\n` : content;
  }
  const rendered = visit(container);
  const last = Array.from((container as HtmlNode).childNodes).findLast(
    (node) => node.nodeType !== 3 || !/^\s*$/.test(node.textContent ?? ''),
  );
  const result =
    last && blocks.has(last.nodeName.toLowerCase()) ? rendered.replace(/\n\n$/, '') : rendered;
  assertRepresentableText(result);
  return result;
}
/** Candidate speech parser; committee exclusion belongs to the bounded tool scan. */
export function parseSpeech(value: unknown): Speech {
  const raw = record(value);
  const path = sourcePath(raw.url, /^\/(?:debates|committees)\/[a-zA-Z0-9/_.-]+\/$/);
  const content = english(raw.content);
  const actor = raw.politician_url == null ? null : politicianPath(raw.politician_url);
  if (raw.procedural != null && typeof raw.procedural !== 'boolean') return malformed('procedural');
  const time = requiredText(raw.time, 'time');
  if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) return malformed('time');
  date(time.slice(0, 10));
  const id = text(raw.source_id) ?? path;
  return {
    id,
    speaker: english(raw.attribution),
    politician: actor?.split('/')[2] ?? null,
    membershipUrl: optionalPath(
      raw.politician_membership_url,
      /^\/politicians\/memberships\/[1-9]\d*\/$/,
    ),
    time,
    h1: english(raw.h1),
    h2: english(raw.h2),
    content: content === null ? null : htmlToText(content),
    procedural: raw.procedural == null ? null : (raw.procedural as boolean),
    url: `${PUBLIC_ORIGIN}${path}`,
    debateUrl: optionalPath(raw.document_url, /^\/(?:debates|committees)\/[a-zA-Z0-9/_.-]+\/$/),
  };
}
