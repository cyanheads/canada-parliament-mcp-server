/**
 * @fileoverview XML character-reference decoding shared by the House and bill-text XML parsers.
 * @module tests/domain/xml-entities.test
 */
import { JsonRpcErrorCode, serializationError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { decodeXmlEntities } from '@/domain/xml-entities.js';
import { expectLinearCpu } from '../fixtures/cpu-timing.js';

const malformed = (): never => {
  throw serializationError('synthetic source malformed', { reason: 'synthetic_malformed' });
};
const decode = (value: string) => decodeXmlEntities(value, malformed);

describe('decodeXmlEntities', () => {
  it.each([
    ['plain text', 'Indian Act', 'Indian Act'],
    ['the five predefined entities', '&amp; &lt; &gt; &quot; &apos;', '& < > " \''],
    ['a reference left encoded after one decode', 'SR&amp;amp;ED', 'SR&amp;ED'],
    ['decimal and hexadecimal references', '&#65;&#x42;&#x1F331;', 'AB🌱'],
    ['an empty value', '', ''],
  ])('decodes %s exactly once', (_case, value, expected) => expect(decode(value)).toBe(expected));

  it.each([
    ['a bare ampersand', 'SR & ED'],
    ['an undeclared named entity', '&nbsp;'],
    ['a reference without its semicolon', '&amp'],
    ['an uppercase hexadecimal marker, which XML does not define', '&#X43;'],
    ['the NUL reference', '&#0;'],
    ['a surrogate reference', '&#xD800;'],
    ['a reference past Unicode', '&#x110000;'],
  ])("rejects %s with the caller's own error", (_case, value) =>
    expect(() => decode(value)).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'synthetic_malformed' }) }),
    ),
  );

  it('keeps each source its own malformed-response error', () => {
    const other = (): never => {
      throw new Error('other source');
    };
    expect(() => decodeXmlEntities('&bad;', other)).toThrow('other source');
    expect(() => decodeXmlEntities('&bad;', malformed)).toThrow('synthetic source malformed');
  });

  it('rejects text that cannot be represented losslessly, whatever the caller', () =>
    expect(() => decode('lone \uD800 surrogate')).toThrow(
      expect.objectContaining({ code: JsonRpcErrorCode.SerializationError }),
    ));
});

const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000] as const;
const attempt = (value: string) => {
  try {
    decode(value);
  } catch {
    // Malformed shapes reject; their scan is what is timed.
  }
};

describe('decodeXmlEntities stays linear', { timeout: 0 }, () => {
  it.each([
    ['an unterminated hexadecimal reference', (n: number) => `&#x${'a'.repeat(n)}`],
    ['an unterminated decimal reference', (n: number) => `&#${'1'.repeat(n)}`],
    ['a terminated reference past Unicode', (n: number) => `&#x${'1'.repeat(n)};`],
    ['repeated predefined entities', (n: number) => '&amp;'.repeat(n / 5)],
    ['repeated numeric references', (n: number) => '&#x1F331;'.repeat(n / 9)],
    ['repeated bare ampersands', (n: number) => '&'.repeat(n)],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
  ])('on %s', (_shape, build) => expectLinearCpu(attempt, build, SIZES));
});
