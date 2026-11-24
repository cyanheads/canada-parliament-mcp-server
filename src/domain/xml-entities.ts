/**
 * @fileoverview XML character-reference decoding for parsers that keep `fast-xml-parser`'s entity
 * processing off, so no document-declared entity is ever expanded.
 * @module domain/xml-entities
 */
import { assertRepresentableText } from './normalization.js';

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Decode the five predefined XML entities and numeric character references in raw source text.
 * Any other `&`, a reference to a code point outside Unicode or in the surrogate range, and text
 * that cannot be represented losslessly are malformed: `malformed` throws the calling source's own
 * error.
 */
export function decodeXmlEntities(value: string, malformed: () => never): string {
  if (/&(?!(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);)/.test(value)) return malformed();
  const text = value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (entity, token: string) => {
      if (token.startsWith('#')) {
        const point =
          token[1]?.toLowerCase() === 'x'
            ? Number.parseInt(token.slice(2), 16)
            : Number(token.slice(1));
        if (point < 1 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
          return malformed();
        return String.fromCodePoint(point);
      }
      return PREDEFINED[token] ?? entity;
    },
  );
  assertRepresentableText(text);
  return text;
}
