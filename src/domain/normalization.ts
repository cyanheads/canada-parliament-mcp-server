/**
 * @fileoverview Exact identifier, geographic, date, and local-filter normalization.
 * @module domain/normalization
 */
import { serializationError, validationError } from '@cyanheads/mcp-ts-core/errors';
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
/** Resolve a known vocabulary spelling without fuzzy matching. */
export function normalizeVocabulary(value: string, vocabulary: readonly string[]): string {
  const key = vocabularyKey(value);
  const match = vocabulary.find((entry) => vocabularyKey(entry) === key);
  if (!match)
    throw validationError('Unknown filter vocabulary.', { value, allowed: [...vocabulary] });
  return match;
}
/** Normalize a province code or full English name. */
export function normalizeProvince(value: string): string {
  const code = value.trim().toUpperCase();
  if (Object.hasOwn(PROVINCES, code)) return PROVINCES[code as keyof typeof PROVINCES];
  return normalizeVocabulary(value, Object.values(PROVINCES));
}
/** Canonical positive parliament-session token. */
export function normalizeSession(value: SessionInput): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && !/^\d+-\d+$/.test(value.trim()))
    throw validationError('Invalid parliamentary session.');
  const parts =
    typeof value === 'string'
      ? value.trim().split('-').map(Number)
      : [value.parliament, value.session];
  if (parts.length !== 2 || parts.some((part) => !Number.isSafeInteger(part) || part <= 0))
    throw validationError('Invalid parliamentary session.');
  return parts.join('-');
}
/** Certain chamber alias, preserving the canonical official spelling. */
export function normalizeChamber(value: string): 'House' | 'Senate' {
  const key = vocabularyKey(value);
  if (key === 'house' || key === 'house of commons') return 'House';
  if (key === 'senate') return 'Senate';
  throw validationError('Invalid originating chamber.', { value });
}
/** Canonical House or Senate bill code. */
export function normalizeBillCode(value: string): string {
  const match = /^(?:bill\s+)?([cs])-?([1-9]\d*)$/i.exec(value.trim());
  if (!match) throw validationError('Invalid bill code.', { value });
  return `${match[1]?.toUpperCase()}-${match[2]}`;
}
/** Accept an exact OpenParliament politician reference, never a name-derived slug. */
export function normalizeSlug(value: string): string {
  let path = value.trim();
  if (/^https?:/i.test(path)) {
    const url = new URL(path);
    if (
      !['https://openparliament.ca', 'https://api.openparliament.ca'].includes(url.origin) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw validationError('Invalid OpenParliament politician URL.');
    path = url.pathname;
  }
  const slug = /^\/politicians\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(path)?.[1] ?? path;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw validationError('Invalid OpenParliament politician slug.');
  return slug;
}
/** Validate a real Gregorian civil date without timezone conversion. */
export function normalizeDate(value: string): string {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(date.slice(0, 4)) < 1)
    throw validationError('Invalid Gregorian date.', { value });
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw validationError('Invalid Gregorian date.', { value });
  return date;
}
/** Validate independently optional civil date bounds. */
export function validateDateRange(from?: string, to?: string): void {
  if (from) normalizeDate(from);
  if (to) normalizeDate(to);
  if (from && to && from > to) throw validationError('Date bounds are reversed.');
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
