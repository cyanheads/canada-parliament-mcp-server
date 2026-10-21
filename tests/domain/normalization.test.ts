/**
 * @fileoverview Exact parliamentary identifier and vocabulary normalization tests.
 * @module tests/domain/normalization.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  assertRepresentableText,
  includesText,
  normalizeBillCode,
  normalizeChamber,
  normalizeDate,
  normalizeProvince,
  normalizeSession,
  normalizeSlug,
  normalizeVocabulary,
  PROVINCES,
  paginate,
  validateDateRange,
} from '@/domain/normalization.js';
import {
  BILL_STATUSES,
  BILL_TYPES,
  extendVocabulary,
  OFFICIAL_PARTY_ALIASES,
  PARTIES,
  VOTE_RESULTS,
} from '@/domain/reference-catalog.js';

describe('identifier normalization', () => {
  it.each(['45-1', ' 045-01 ', { parliament: 45, session: 1 }])(
    'canonicalizes session %j without inferring a current session',
    (input) => expect(normalizeSession(input)).toBe('45-1'),
  );
  it('leaves omitted sessions unresolved', () => {
    expect(normalizeSession(undefined)).toBeUndefined();
  });
  it.each(['0-1', '45-0', '-1-1', '45-1-2', '4e1-1', '9007199254740992-1'])(
    'rejects invalid session %s',
    (input) => expect(() => normalizeSession(input)).toThrow(),
  );
  it.each([
    ['bill s321', 'S-321'],
    [' c1 ', 'C-1'],
    ['S-99', 'S-99'],
  ])('normalizes bill %s', (input, expected) => expect(normalizeBillCode(input)).toBe(expected));
  it.each(['C-0', 'C-01', 'C--1', 'C-1 extra', 'X-1', 'C-1\nC-2'])(
    'rejects invalid bill %s',
    (input) => expect(() => normalizeBillCode(input)).toThrow(),
  );
  it.each([
    'alex-example',
    '/politicians/alex-example/',
    'https://openparliament.ca/politicians/alex-example/',
    'https://api.openparliament.ca/politicians/alex-example/',
  ])('accepts exact politician reference %s', (input) =>
    expect(normalizeSlug(input)).toBe('alex-example'),
  );
  it.each([
    'Alex Example',
    'Alex-Example',
    'https://openparliament.ca.evil.test/politicians/alex-example/',
    'http://openparliament.ca/politicians/alex-example/',
    'https://user@openparliament.ca/politicians/alex-example/',
    'https://openparliament.ca/politicians/alex-example/?x=1',
    '/politicians/alex-example/extra/',
  ])('rejects noncanonical politician reference %s', (input) =>
    expect(() => normalizeSlug(input)).toThrow(),
  );
});

describe('source vocabulary and literal matching', () => {
  it.each(Object.entries(PROVINCES))('accepts postal code %s and its full name', (code, name) => {
    expect(normalizeProvince(` ${code.toLowerCase()} `)).toBe(name);
    expect(normalizeProvince(name.toUpperCase())).toBe(name);
  });
  it.each(['PQ', 'B.C.', 'Newfoundland', 'Ontari'])('rejects geographic guess %s', (input) => {
    expect(() => normalizeProvince(input)).toThrow();
  });
  it('matches composition, apostrophes, case, and repeated whitespace only', () => {
    expect(normalizeVocabulary(" private  MEMBER'S bill ", BILL_TYPES)).toBe(
      'Private Member’s Bill',
    );
    expect(normalizeVocabulary('BLOC QUE\u0301BE\u0301COIS', PARTIES)).toBe('Bloc Québécois');
    expect(normalizeChamber(' HOUSE OF COMMONS ')).toBe('House');
    expect(normalizeChamber(' senate ')).toBe('Senate');
    expect(() => normalizeChamber('Commons')).toThrow();
    expect(() => normalizeVocabulary('Royal assent', BILL_STATUSES)).toThrow();
  });
  it('extends observed vocabulary without rewriting canonical or raw source labels', () => {
    const catalog = ['Private Member’s Bill', 'Agreed To'];
    expect(
      extendVocabulary(catalog, [
        null,
        '',
        '  ',
        "PRIVATE MEMBER'S BILL",
        '  New status  ',
        'new STATUS',
      ]),
    ).toEqual([...catalog, 'New status']);
    expect(catalog).toEqual(['Private Member’s Bill', 'Agreed To']);
    expect(VOTE_RESULTS).toEqual(['Agreed To', 'Negatived', 'Tie']);
    expect(OFFICIAL_PARTY_ALIASES).toEqual({ Bloc: 'Bloc Québécois', Green: 'Green Party' });
  });
  it('uses literal Unicode substrings rather than query syntax or fuzzy matches', () => {
    expect(includesText('Que\u0301bec [a.*]', 'QUÉBEC')).toBe(true);
    expect(includesText('Quebec abc', 'a.*')).toBe(false);
    expect(includesText(null, '')).toBe(false);
  });
});

describe('civil dates and exact pagination', () => {
  it.each(['2024-02-29', '2000-02-29', ' 2026-10-20 ', '0001-01-01'])(
    'accepts Gregorian date %s',
    (input) => {
      expect(normalizeDate(input)).toBe(input.trim());
    },
  );
  it.each([
    '2025-02-29',
    '1900-02-29',
    '2026-04-31',
    '0000-01-01',
    '2026-1-01',
    '2026-01-01T00:00:00Z',
  ])('rejects invalid date %s', (input) => {
    expect(() => normalizeDate(input)).toThrow();
  });
  it('allows independent bounds and rejects reversed bounds', () => {
    expect(() => validateDateRange('2026-01-01')).not.toThrow();
    expect(() => validateDateRange(undefined, '2026-01-01')).not.toThrow();
    expect(() => validateDateRange('2026-01-01', '2026-01-01')).not.toThrow();
    expect(() => validateDateRange('2026-01-02', '2026-01-01')).toThrow();
  });
  it.each([
    { rows: [], offset: 0, limit: 2, items: [], nextOffset: null, hasMore: false },
    { rows: [1], offset: 0, limit: 2, items: [1], nextOffset: null, hasMore: false },
    { rows: [1, 2], offset: 0, limit: 2, items: [1, 2], nextOffset: null, hasMore: false },
    { rows: [1, 2, 3], offset: 0, limit: 2, items: [1, 2], nextOffset: 2, hasMore: true },
    { rows: [1, 2, 3], offset: 2, limit: 2, items: [3], nextOffset: null, hasMore: false },
    { rows: [1, 2, 3], offset: 99, limit: 2, items: [], nextOffset: null, hasMore: false },
  ])(
    'preserves exact total and continuation for $rows at $offset',
    ({ rows, offset, limit, items, nextOffset, hasMore }) => {
      expect(paginate(rows, offset, limit)).toEqual({
        items,
        total: rows.length,
        pagination: { offset, limit, nextOffset, hasMore },
      });
    },
  );
  it.each(['\0', '\ud800', '\udfff', 'prefix\ud800suffix'])(
    'rejects unrepresentable text %j',
    (input) => {
      expect(() => assertRepresentableText(input)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.SerializationError,
          data: expect.objectContaining({ retryable: false }),
        }),
      );
    },
  );
});
