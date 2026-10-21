/**
 * @fileoverview Recursive lossless CommonMark rendering for results and enrichment.
 * @module mcp-server/tools/definitions/_format
 */
import { assertRepresentableText } from '@/domain/normalization.js';
import type { JsonValue } from '@/domain/schemas.js';

/** Encode once: parsed CommonMark text directly contains the original characters. */
export function encodeText(value: string): string {
  assertRepresentableText(value);
  return value
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&')
    .replace(/[ \t\r\n]/g, (char) => `&#${char.charCodeAt(0)};`);
}
/** Render an HTTPS link/image and preserve unusual original URL spelling alongside it. */
export function renderUrl(value: string, image = false): string {
  assertRepresentableText(value);
  const destination = [...value]
    .map((char) => {
      if (char === '&') return '\\&';
      return /[\\<>\s]/u.test(char) || char.charCodeAt(0) < 32 ? encodeURIComponent(char) : char;
    })
    .join('');
  const rendered = `${image ? '!' : ''}[${encodeText(image ? 'imageUrl' : value)}](<${destination}>)`;
  return destination.replace(/\\&/g, '&') === value ? rendered : `${rendered} ${encodeText(value)}`;
}
/** Render every value and key recursively; labels never interpolate raw source text. */
export function renderValue(value: JsonValue, key = 'value'): string {
  const label = encodeText(key);
  if (Array.isArray(value))
    return `> ${label}: ${value.length === 0 ? '[]' : '[array]'}\n\n${value.map((item, index) => renderValue(item, String(index))).join('\n\n')}`;
  if (value !== null && typeof value === 'object')
    return `> ${label}: ${Object.keys(value).length === 0 ? '{}' : '[object]'}\n\n${Object.entries(
      value,
    )
      .map(([name, item]) => renderValue(item, name))
      .join('\n\n')}`;
  const text =
    typeof value === 'string'
      ? /^https:\/\//.test(value)
        ? renderUrl(value, /image|photo|portrait/i.test(key))
        : encodeText(value)
      : String(value);
  return `> ${label}: ${text}`;
}
/** Tool format callback preserving every output leaf. */
export function formatResult(result: JsonValue): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: renderValue(result) }];
}
