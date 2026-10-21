/**
 * @fileoverview Exact identifier, geographic, date, and local-filter normalization.
 * @module domain/normalization
 */
import {
  JsonRpcErrorCode,
  McpError,
  serializationError,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { Pagination, SessionInput } from './schemas.js';

/** Canonical English province and territory names. */
export const PROVINCES = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
} as const;
/** Comparison normalization only; never use this to replace returned source text. */
export function normalizeText(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-CA');
}
/** Vocabulary comparison with equivalent apostrophes and whitespace. */
export function vocabularyKey(value: string): string {
  return normalizeText(value.trim()).replace(/[‘’]/g, "'").replace(/\s+/gu, ' ');
}
/** Plain-text list of accepted values, identical on both client surfaces. */
export function quoteValues(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}
function expectedOneOf(allowed: readonly string[]): McpError {
  return validationError(`Expected one of ${quoteValues(allowed)}.`, { allowed: [...allowed] });
}
/** Resolve a known vocabulary spelling or one of its aliases, without fuzzy matching. */
export function normalizeVocabulary(
  value: string,
  vocabulary: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): string {
  const key = vocabularyKey(value);
  const target = Object.entries(aliases).find(([alias]) => vocabularyKey(alias) === key)?.[1];
  const targetKey = target === undefined ? key : vocabularyKey(target);
  const match = vocabulary.find((entry) => vocabularyKey(entry) === targetKey);
  if (!match) throw expectedOneOf([...vocabulary, ...Object.keys(aliases)]);
  return match;
}
/** Normalize a province code or full English name. */
export function normalizeProvince(value: string): string {
  return normalizeVocabulary(value, Object.values(PROVINCES), PROVINCES);
}
/** Canonical positive parliament-session token. */
export function normalizeSession(value: Exclude<SessionInput, undefined>): string;
export function normalizeSession(value: SessionInput): string | undefined;
export function normalizeSession(value: SessionInput): string | undefined {
  if (value === undefined) return undefined;
  const parts =
    typeof value === 'string'
      ? /^(\d+)-(\d+)$/.exec(value.trim())?.slice(1).map(Number)
      : [value.parliament, value.session];
  if (!parts?.every((part) => Number.isSafeInteger(part) && part > 0))
    throw validationError(
      'Expected a parliament-session token such as 45-1, with positive parliament and session numbers.',
    );
  return parts.join('-');
}
const CHAMBERS = ['House', 'House of Commons', 'Senate'] as const;
/** Certain chamber alias, preserving the canonical official spelling. */
export function normalizeChamber(value: string): 'House' | 'Senate' {
  const key = vocabularyKey(value);
  if (key === 'house' || key === 'house of commons') return 'House';
  if (key === 'senate') return 'Senate';
  throw expectedOneOf(CHAMBERS);
}
/**
 * Canonical House or Senate bill code; one space or dash may separate chamber and number, and one
 * ASCII letter may follow the number (split bills such as C-15A). Case classes are explicit, so no
 * Unicode case folding (Kelvin sign, long s) reaches the canonical code.
 */
export function normalizeBillCode(value: string): string {
  const match = /^(?:[Bb][Ii][Ll][Ll]\s+)?([CcSs])[\p{Zs}\-‐-―−]?([1-9]\d*)([A-Za-z]?)$/u.exec(
    value.trim(),
  );
  if (!match)
    throw validationError(
      'Expected a House or Senate bill code such as C-15, C-15A, or S-1001: C or S, an optional single dash or space, a number without leading zeros, then an optional suffix letter.',
    );
  return `${match[1]?.toUpperCase()}-${match[2]}${match[3]?.toUpperCase()}`;
}
/** Accept an exact OpenParliament politician reference, never a name-derived slug. */
export function normalizeSlug(value: string): string {
  const invalid = () =>
    validationError(
      "Expected an OpenParliament politician slug of lowercase letters, digits, and single hyphens, its /politicians/ path, or its OpenParliament profile URL: member.slug from canparl_get_member, a slug from an includeFormer canparl_search_members row, or a current MP's official personId.",
    );
  let path = value.trim();
  if (/^https?:/i.test(path)) {
    const url = URL.parse(path);
    if (
      !url ||
      !['https://openparliament.ca', 'https://api.openparliament.ca'].includes(url.origin) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw invalid();
    path = url.pathname;
  }
  const slug = /^\/politicians\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(path)?.[1] ?? path;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw invalid();
  return slug;
}
/** Validate a real Gregorian civil date without timezone conversion. */
export function normalizeDate(value: string): string {
  const date = value.trim();
  const invalid = () => validationError('Expected a real calendar date written YYYY-MM-DD.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(date.slice(0, 4)) < 1) throw invalid();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw invalid();
  return date;
}
/** Validate independently optional `dateFrom`/`dateTo` civil date bounds. */
export function validateDateRange(from?: string, to?: string): void {
  if (from) normalizeDate(from);
  if (to) normalizeDate(to);
  if (from && to && from > to) throw validationError('Expected a date no later than dateTo.');
}

/** Field path and accepted values a rejected filter reports in `data`. */
export type FilterRejectionData = { allowed?: string[]; field: string };
/**
 * Field-named rejection: the message is `<field>: <expectation>` and `data.field` names the path.
 * The expectation states accepted values or the expected shape; it never repeats the caller's value.
 */
export function rejectFilter(
  field: string,
  expectation: string,
  data: Record<string, unknown> = {},
  options?: { cause?: unknown },
): McpError {
  return validationError(`${field}: ${expectation}`, { ...data, field }, options);
}
/** {@link rejectFilter} for a session absent from a source's session index, listing the index. */
export function rejectSession(
  field: string,
  index: string,
  sessions: readonly string[],
  data: Record<string, unknown> = {},
): McpError {
  return rejectFilter(
    field,
    `Expected a session in the ${index} session index: ${quoteValues(sessions)}.`,
    { ...data, allowed: [...sessions] },
  );
}
function isFilterRejection(error: unknown): error is McpError & { data: FilterRejectionData } {
  return (
    error instanceof McpError &&
    error.code === JsonRpcErrorCode.ValidationError &&
    typeof error.data?.field === 'string'
  );
}
/**
 * Normalize one optional filter value. An absent value stays `undefined`; a validation failure from
 * `normalize` becomes a {@link rejectFilter} rejection for `field` that keeps the normalizer's
 * accepted values as `data.allowed` and the original error as `cause`. Other failures pass unchanged.
 */
export function normalizeFilter<V, T>(
  field: string,
  value: V,
  normalize: (value: Exclude<V, undefined>) => T,
): undefined extends V ? T | undefined : T {
  type Result = undefined extends V ? T | undefined : T;
  if (value === undefined) return undefined as Result;
  try {
    return normalize(value as Exclude<V, undefined>) as Result;
  } catch (error) {
    if (
      !(error instanceof McpError) ||
      error.code !== JsonRpcErrorCode.ValidationError ||
      isFilterRejection(error)
    )
      throw error;
    const allowed = error.data?.allowed;
    throw rejectFilter(field, error.message, Array.isArray(allowed) ? { allowed } : {}, {
      cause: error,
    });
  }
}
/**
 * `ctx.fail` arguments for a field-named rejection — `throw ctx.fail(reason, ...filterFailure(e))` —
 * carrying only `field` and `allowed`. Any other error is rethrown unchanged.
 */
export function filterFailure(
  error: unknown,
): [message: string, data: FilterRejectionData, options: { cause: unknown }] {
  if (!isFilterRejection(error)) throw error;
  const { field, allowed } = error.data;
  return [error.message, { field, ...(allowed ? { allowed } : {}) }, { cause: error }];
}

/** Literal Unicode-normalized, case-insensitive substring match. */
export function includesText(value: string | null, query: string): boolean {
  return value !== null && normalizeText(value).includes(normalizeText(query));
}
/** Reject strings that CommonMark cannot preserve exactly. */
export function assertRepresentableText(value: string): void {
  if (value.includes('\0') || !value.isWellFormed())
    throw serializationError(
      'Upstream text contains characters that cannot be represented losslessly.',
      { retryable: false },
    );
}
/**
 * Clamp a count input to its per-call `cap`. Above the cap the result carries a notice naming the
 * field, the requested value, and the effective value; at or below it, no notice.
 */
export function clampCount(
  field: string,
  requested: number,
  cap: number,
): { value: number; notice?: string } {
  if (requested <= cap) return { value: requested };
  return {
    value: cap,
    notice: `${field} ${requested} exceeds the per-call maximum of ${cap}; returned up to ${cap}.`,
  };
}
/** Exact local pagination; past-end pages retain their requested offset. */
export function paginate<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): { items: T[]; total: number; pagination: Pagination } {
  const rows = items.slice(offset, offset + limit);
  const hasMore = offset + rows.length < items.length;
  return {
    items: rows,
    total: items.length,
    pagination: { offset, limit, nextOffset: hasMore ? offset + rows.length : null, hasMore },
  };
}
