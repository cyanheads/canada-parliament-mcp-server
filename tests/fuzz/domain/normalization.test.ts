/**
 * @fileoverview Exhaustive BMP sweeps of the normalization grammars: the bill-code and postal-code
 * separators, and the accent-, dash-, quote-, and whitespace-insensitive substring filter beside the
 * case-sensitive Greek sigma.
 * @module tests/fuzz/domain/normalization.test
 */
import { describe, expect, it } from 'vitest';
import {
  includesText,
  normalizeBillCode,
  normalizePostalCode,
  normalizeText,
} from '@/domain/normalization.js';

/** Every BMP code point that is not a lone surrogate. */
function* bmpCharacters(): Generator<string> {
  for (let point = 0; point <= 0xffff; point++)
    if (point < 0xd800 || point > 0xdfff) yield String.fromCharCode(point);
}

/** Values the normalizer accepts where the stated grammar refuses them, or the reverse. */
function grammarMisses(
  normalize: (value: string) => string,
  grammar: RegExp,
  shapes: (c: string) => string[],
): string[] {
  const misses: string[] = [];
  for (const c of bmpCharacters())
    for (const value of shapes(c)) {
      let accepted = true;
      try {
        normalize(value);
      } catch {
        accepted = false;
      }
      if (accepted !== grammar.test(value.trim())) misses.push(JSON.stringify(value));
    }
  return misses;
}

describe('identifier separators', () => {
  // Each grammar states the separator with the Unicode property: any Zs space, the hyphen-minus, U+2010–U+2015, or U+2212.
  it('accepts exactly the bill codes whose separator is a Unicode space separator or a dash', () => {
    const grammar = /^(?:[Bb][Ii][Ll][Ll]\s+)?[CcSs][\p{Zs}\-‐-―−]?[1-9]\d*[A-Za-z]?$/u;
    expect(
      grammarMisses(normalizeBillCode, grammar, (c) => [
        `C${c}15`,
        `bill${c}C-15`,
        `S${c}1001A`,
        `${c}C-15${c}`,
      ]),
    ).toEqual([]);
  });
  it('accepts exactly the postal codes whose separator is a Unicode space separator or a dash', () => {
    const grammar = /^[A-Za-z][0-9][A-Za-z][\p{Zs}\-‐-―−]?[0-9][A-Za-z][0-9]$/u;
    expect(
      grammarMisses(normalizePostalCode, grammar, (c) => [
        `K1A${c}0A6`,
        `${c}1A0A6`,
        `K${c}A0A6`,
        `${c}K1A0A6${c}`,
      ]),
    ).toEqual([]);
  });
});

describe('accent-, dash-, quote-, and whitespace-insensitive substring filters', () => {
  /** The comparison every local text filter made before the fold: NFC and en-CA lowercase. */
  const plainMatch = (value: string, query: string) =>
    normalizeText(value).includes(normalizeText(query));

  it('still matches every capital sigma pair the plain comparison matched beside any BMP character', () => {
    const misses: string[] = [];
    let accepted = 0;
    for (const c of bmpCharacters())
      for (const value of [`a${c}Σ`, `aΣ${c}b`, `a${c}Σ b`])
        for (const query of ['Σ', 'σ', 'ς']) {
          if (!plainMatch(value, query)) continue;
          accepted++;
          if (!includesText(value, query)) misses.push(JSON.stringify([value, query]));
        }
    expect(misses).toEqual([]);
    expect(accepted).toBeGreaterThan(300_000);
  });
});
