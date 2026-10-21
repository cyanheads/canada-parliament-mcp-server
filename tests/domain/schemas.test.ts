/**
 * @fileoverview Source-independent input and lossless value schema tests.
 * @module tests/domain/schemas.test
 */
import { describe, expect, it } from 'vitest';
import {
  BilingualTextSchema,
  JsonRecordSchema,
  JsonValueSchema,
  LimitSchema,
  OffsetSchema,
  OptionalStringSchema,
  PaginationSchema,
  SessionInputSchema,
  SourceNameSchema,
  SourceSchema,
} from '@/domain/schemas.js';

describe('shared schemas', () => {
  it.each([undefined, '', ' \t\r\n '])('treats blank optional input %j as absent', (input) => {
    expect(OptionalStringSchema.parse(input)).toBeUndefined();
    expect(SessionInputSchema.parse(input)).toBeUndefined();
  });
  it('trims optional text without changing its content', () => {
    expect(OptionalStringSchema.parse('  é [literal]  ')).toBe('é [literal]');
    expect(OptionalStringSchema.safeParse(null).success).toBe(false);
  });
  it('accepts both session forms and strict nested numbers', () => {
    expect(SessionInputSchema.parse(' 045-01 ')).toBe('045-01');
    expect(SessionInputSchema.parse({ parliament: 45, session: 1 })).toEqual({
      parliament: 45,
      session: 1,
    });
    for (const input of [
      { parliament: 45, session: 1, unknown: true },
      { parliament: 0, session: 1 },
      { parliament: '45', session: 1 },
      { parliament: 45, session: 1.5 },
    ]) {
      expect(SessionInputSchema.safeParse(input).success).toBe(false);
    }
  });
  it('enforces list defaults and inclusive boundaries', () => {
    expect(LimitSchema.parse(undefined)).toBe(25);
    expect(OffsetSchema.parse(undefined)).toBe(0);
    for (const value of [1, 100]) expect(LimitSchema.parse(value)).toBe(value);
    for (const value of [0, 101, 1.5, '25', null])
      expect(LimitSchema.safeParse(value).success).toBe(false);
    for (const value of [-1, 0.5, '0', null])
      expect(OffsetSchema.safeParse(value).success).toBe(false);
    expect(OffsetSchema.parse(999)).toBe(999);
  });
  it('retains nested unknown fields, arrays, nulls, and untranslated text', () => {
    const record = {
      unknown: { records: [{ count: 0, flag: false, nil: null, text: '\r\n' }, []] },
      empty: {},
      'odd[key]': 'é',
    };
    expect(JsonRecordSchema.parse(record)).toEqual(record);
    expect(JsonValueSchema.parse([record, null])).toEqual([record, null]);
    expect(BilingualTextSchema.parse({ en: null, fr: 'texte' })).toEqual({ en: null, fr: 'texte' });
    expect(BilingualTextSchema.safeParse({ fr: 'texte' }).success).toBe(false);
    expect(BilingualTextSchema.safeParse({ en: null, fr: null, extra: '' }).success).toBe(false);
    for (const input of [undefined, Number.NaN, Infinity, 1n, { field: undefined }])
      expect(JsonValueSchema.safeParse(input).success).toBe(false);
  });
  it('validates source identity and HTTPS provenance without dropping fields', () => {
    for (const source of ['legisinfo', 'ourcommons', 'openparliament'])
      expect(SourceNameSchema.parse(source)).toBe(source);
    const provenance = {
      source: 'legisinfo',
      url: 'https://www.parl.ca/legisinfo/en/bills/json',
      retrievedAt: '2026-10-20T12:00:00Z',
      cached: true,
    };
    expect(SourceSchema.parse(provenance)).toEqual(provenance);
    for (const change of [
      { source: 'guessed' },
      { url: 'http://example.test' },
      { cached: 'true' },
      { extra: 1 },
    ])
      expect(SourceSchema.safeParse({ ...provenance, ...change }).success).toBe(false);
    const page = { offset: 100, limit: 25, nextOffset: null, hasMore: false };
    expect(PaginationSchema.parse(page)).toEqual(page);
    expect(PaginationSchema.safeParse({ ...page, nextOffset: -1 }).success).toBe(false);
    expect(PaginationSchema.safeParse({ ...page, extra: true }).success).toBe(false);
  });
});
