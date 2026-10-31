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
/** Locale of every comparison's lowercase mapping. */
const COMPARISON_LOCALE = 'en-CA';
/** Comparison normalization only; never use this to replace returned source text. */
export function normalizeText(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase(COMPARISON_LOCALE);
}
/** Vocabulary comparison with equivalent apostrophes and whitespace. */
export function vocabularyKey(value: string): string {
  return normalizeText(value.trim()).replace(/[‘’]/g, "'").replace(/\s+/gu, ' ');
}
const MARK_RUNS = /\p{M}+/gu;
/** Longest run of consecutive combining marks, in code points. */
function longestMarkRun(value: string): number {
  let longest = 0;
  for (const [run] of value.matchAll(MARK_RUNS)) longest = Math.max(longest, [...run].length);
  return longest;
}
/**
 * {@link vocabularyKey} of a caller value compared against the keys of `entries`, or null for a value
 * that cannot equal any of them. Canonical composition merges at most four code points into one, so
 * a value holding more than 4R + 8 consecutive combining marks, R the longest such run in any
 * entry's key, keys to a longer run than every entry's key holds. Runs in time linear in the value's
 * length.
 */
function comparableKey(value: string, entries: readonly string[]): string | null {
  const run = longestMarkRun(value);
  if (run > 8) {
    const keyRun = Math.max(0, ...entries.map((entry) => longestMarkRun(vocabularyKey(entry))));
    if (run > 4 * keyRun + 8) return null;
  }
  return vocabularyKey(value);
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
  const key = comparableKey(value, [...vocabulary, ...Object.keys(aliases)]);
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

/**
 * One input format: the grammar its normalizer accepts and the input schema advertises, and the
 * expectation a value outside it fails with. `source` is a flagless pattern of a single term (no
 * top-level `|`) with ASCII digit classes, so JSON Schema validators read it as the normalizer does.
 */
export interface InputFormat {
  readonly expectation: string;
  readonly source: string;
}
/** `^(?:source)$`: the whole trimmed value in `format`. */
function whole(format: InputFormat): RegExp {
  return new RegExp(`^(?:${format.source})$`);
}
/** Civil date shape; {@link normalizeDate} also requires a real Gregorian day. */
export const DATE_FORMAT: InputFormat = {
  source: '[0-9]{4}-[0-9]{2}-[0-9]{2}',
  expectation: 'Expected a real calendar date written YYYY-MM-DD.',
};
/** Parliament-session token shape; {@link normalizeSession} also requires positive safe integers. */
export const SESSION_FORMAT: InputFormat = {
  source: '[0-9]+-[0-9]+',
  expectation:
    'Expected a parliament-session token such as 45-1, with positive parliament and session numbers.',
};
/** Decimal official personId. */
export const PERSON_ID_FORMAT: InputFormat = {
  source: '[0-9]+',
  expectation:
    'Expected a decimal official person ID, as in a canparl_search_members detailLookup or a canparl_get_vote ballot row.',
};
const BILL_PREFIX = '(?:[Bb][Ii][Ll][Ll]\\s+)?';
const BILL_CHAMBER = '[CcSs]';
/** One optional separator: a Unicode space separator (Zs), a hyphen, U+2010–U+2015, or U+2212. */
const BILL_SEPARATOR =
  '[-\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000\\u2010-\\u2015\\u2212]?';
const BILL_NUMBER = '[1-9][0-9]*';
const BILL_SUFFIX = '[A-Za-z]?';
/**
 * House or Senate bill code: an optional `bill` and whitespace, C or S, at most one separator, a
 * number without leading zeros, and an optional split-bill suffix letter (C-15A). Case classes are
 * explicit, so no Unicode case folding (Kelvin sign, long s) reaches the canonical code.
 */
export const BILL_CODE_FORMAT: InputFormat = {
  source: `${BILL_PREFIX}${BILL_CHAMBER}${BILL_SEPARATOR}${BILL_NUMBER}${BILL_SUFFIX}`,
  expectation:
    'Expected a House or Senate bill code such as C-15, C-15A, or S-1001: C or S, an optional single dash or space, a number without leading zeros, then an optional suffix letter.',
};
/** {@link BILL_CODE_FORMAT} capturing chamber, number, and suffix. */
const BILL_CODE = new RegExp(
  `^${BILL_PREFIX}(${BILL_CHAMBER})${BILL_SEPARATOR}(${BILL_NUMBER})(${BILL_SUFFIX})$`,
);
const SESSION = whole(SESSION_FORMAT);
const DATE = whole(DATE_FORMAT);
/** A whole decimal official personId; a digit-only slug input may be one. */
export const PERSON_ID = whole(PERSON_ID_FORMAT);

/** Canonical positive parliament-session token. */
export function normalizeSession(value: Exclude<SessionInput, undefined>): string;
export function normalizeSession(value: SessionInput): string | undefined;
export function normalizeSession(value: SessionInput): string | undefined {
  if (value === undefined) return undefined;
  const parts =
    typeof value !== 'string'
      ? [value.parliament, value.session]
      : SESSION.test(value.trim())
        ? value.trim().split('-').map(Number)
        : undefined;
  if (!parts?.every((part) => Number.isSafeInteger(part) && part > 0))
    throw validationError(SESSION_FORMAT.expectation);
  return parts.join('-');
}
const CHAMBERS = ['House', 'House of Commons', 'Senate'] as const;
/** Certain chamber alias, preserving the canonical official spelling. */
export function normalizeChamber(value: string): 'House' | 'Senate' {
  const key = comparableKey(value, CHAMBERS);
  if (key === 'house' || key === 'house of commons') return 'House';
  if (key === 'senate') return 'Senate';
  throw expectedOneOf(CHAMBERS);
}
/** Canonical code of a value in {@link BILL_CODE_FORMAT}, such as C-15A. */
export function normalizeBillCode(value: string): string {
  const match = BILL_CODE.exec(value.trim());
  if (!match) throw validationError(BILL_CODE_FORMAT.expectation);
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
  const invalid = () => validationError(DATE_FORMAT.expectation);
  if (!DATE.test(date) || Number(date.slice(0, 4)) < 1) throw invalid();
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

/**
 * Every combining mark. Marks are removed before normalizing as well as after; the result is
 * identical, since no mark decomposes to a non-mark and reordering moves only marks.
 */
const MARKS = /\p{M}/gu;
/**
 * Canonical decomposition with every combining mark removed, for accent-insensitive comparison only.
 * Bases that decompose without a mark, such as Hangul syllables, stay decomposed. Runs in time
 * linear in the value's length.
 */
export function stripAccents(value: string): string {
  return value.replace(MARKS, '').normalize('NFD').replace(MARKS, '');
}
/**
 * Comparison text for local substring filters: lowercased as {@link normalizeText} lowercases, with
 * every mark still in place, then accents stripped, `œ` as `oe`, every dash {@link normalizeBillCode}
 * accepts as `-`, curly quotes straight, and whitespace runs as one space. Canonical decomposition
 * only: compatibility forms such as `²` and `ﬁ` stay distinct. Runs in time linear in the value's
 * length.
 */
function foldText(value: string): string {
  return stripAccents(value.toLocaleLowerCase(COMPARISON_LOCALE))
    .replace(/œ/g, 'oe')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/gu, ' ');
}
/**
 * Literal case-insensitive substring match that ignores accents and the dash, quote, and whitespace
 * variants {@link foldText} merges. Every pair a Unicode-normalized case-insensitive match accepts
 * still matches; returned text and filter echoes are never folded.
 */
export function includesText(value: string | null, query: string): boolean {
  return value !== null && foldText(value).includes(foldText(query));
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
