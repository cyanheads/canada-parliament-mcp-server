/**
 * @fileoverview Recursive lossless CommonMark rendering for results and enrichment: nested
 * blockquotes carry structure, minimal escaping carries text, JSON literals carry scalar types.
 * Also the shared complete-response byte budget and its measure.
 * @module mcp-server/tools/definitions/_format
 */
import { assertRepresentableText } from '@/domain/normalization.js';
import {
  type JsonRecord,
  JsonRecordSchema,
  type JsonValue,
  JsonValueSchema,
} from '@/domain/schemas.js';

/** Inline-significant everywhere: escapes, code spans, emphasis, strikethrough, links, HTML/autolinks, entities. */
const INLINE_SIGNIFICANT = /[\\`*_~[\]<&]/g;
const LINE_BREAK = /[\r\n]/g;
const WHITESPACE = /\s/;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
/** Value texts the renderer emits for non-string scalars and containers. */
const RESERVED_VALUES = new Set(['true', 'false', 'null', '[]', '{}', '[array]', '[object]']);

const reference = (char: string) => `&#${char.codePointAt(0)};`;
const references = (text: string) => [...text].map(reference).join('');
/**
 * Escape what CommonMark would alter. Line breaks and edge whitespace become numeric references,
 * which parse as text after block structure is fixed, so no line can open a heading, fence, list,
 * table, or HTML block; internal spaces cannot open a block and stay literal. Text that opens a
 * line also escapes a leading ASCII punctuation character and an ordered-list delimiter.
 */
function escapeMarkdown(value: string, opensLine: boolean): string {
  let start = 0;
  let end = value.length;
  while (start < end && WHITESPACE.test(value[start] as string)) start++;
  while (end > start && WHITESPACE.test(value[end - 1] as string)) end--;
  let core = value
    .slice(start, end)
    .replace(INLINE_SIGNIFICANT, '\\$&')
    .replace(LINE_BREAK, reference);
  if (opensLine && start === 0) {
    let digits = 0;
    while (digits < core.length && core.charCodeAt(digits) >= 48 && core.charCodeAt(digits) <= 57)
      digits++;
    if (digits > 0 && (core[digits] === '.' || core[digits] === ')'))
      core = `${core.slice(0, digits)}\\${core.slice(digits)}`;
    else if (core[0] !== '\\' && ASCII_PUNCTUATION.test(core.slice(0, 1))) core = `\\${core}`;
  }
  return `${references(value.slice(0, start))}${core}${references(value.slice(end))}`;
}
/** Encode text that opens a line; parsed CommonMark text directly contains the original characters. */
export function encodeText(value: string): string {
  assertRepresentableText(value);
  return escapeMarkdown(value, true);
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
/** A key opening with `"` or holding the `: ` separator renders as a JSON string literal. */
function renderKey(key: string): string {
  assertRepresentableText(key);
  return escapeMarkdown(
    key.startsWith('"') || key.includes(': ') ? JSON.stringify(key) : key,
    true,
  );
}
/** Scalar text after `key: `; a string that would read as another type renders as a JSON string literal. */
function renderScalar(value: Exclude<JsonValue, object>, key: string): string {
  if (typeof value !== 'string') return String(value);
  if (value.startsWith('https://')) return renderUrl(value, /image|photo|portrait/i.test(key));
  assertRepresentableText(value);
  const typed = value.startsWith('"') || RESERVED_VALUES.has(value) || JSON_NUMBER.test(value);
  return escapeMarkdown(typed ? JSON.stringify(value) : value, false);
}

interface Line {
  depth: number;
  text: string;
}
/** One `key: value` line per field; a container's fields follow one blockquote level deeper. */
function collect(value: JsonValue, key: string, depth: number, lines: Line[]): void {
  let head: string;
  let children: [string, JsonValue][] = [];
  if (Array.isArray(value)) {
    head = value.length ? '[array]' : '[]';
    children = value.map((item, index) => [String(index), item]);
  } else if (value !== null && typeof value === 'object') {
    children = Object.entries(value);
    head = children.length ? '[object]' : '{}';
  } else head = renderScalar(value, key);
  lines.push({ depth, text: head === '' ? `${renderKey(key)}:` : `${renderKey(key)}: ${head}` });
  for (const [name, item] of children) collect(item, name, depth + 1, lines);
}
/**
 * Siblings share a paragraph through backslash hard breaks; a deeper line opens a nested
 * blockquote; a bare quote line at the shallower depth closes the deeper levels.
 */
function join(lines: Line[]): string {
  return lines
    .map(({ depth, text }, index) => {
      const quote = '>'.repeat(depth);
      const previous = lines[index - 1];
      const separator = !previous
        ? ''
        : depth === previous.depth
          ? '\\\n'
          : depth > previous.depth
            ? '\n'
            : `\n${quote}\n`;
      return `${separator}${quote} ${text}`;
    })
    .join('');
}
/** Render one labeled value and everything beneath it. */
export function renderValue(value: JsonValue, key = 'value'): string {
  const lines: Line[] = [];
  collect(value, key, 1, lines);
  return join(lines);
}
/** Tool format callback preserving every output leaf; root fields open at the first quote level. */
export function formatResult(result: JsonRecord): { type: 'text'; text: string }[] {
  const lines: Line[] = [];
  for (const [key, value] of Object.entries(result)) collect(value, key, 1, lines);
  return [{ type: 'text', text: join(lines) }];
}

/** Complete-response byte budget shared by every tool that pages large records. */
export const RESPONSE_BUDGET = 24_000;
/**
 * Enrichment trailer config rendering every declared field through {@link renderValue}, the
 * rendering {@link responseBytes} measures. The framework's own field kinds render differently.
 */
export function measuredTrailer<K extends string>(
  enrichment: Record<K, unknown>,
): Record<K, { render(value: unknown): string }> {
  return Object.fromEntries(
    Object.keys(enrichment).map((key) => [
      key,
      { render: (value: unknown) => renderValue(JsonValueSchema.parse(value), key) },
    ]),
  ) as Record<K, { render(value: unknown): string }>;
}
/**
 * UTF-8 bytes of the complete JSON-RPC response: a 256-byte request id, `structuredContent` with
 * the enrichment merged, and `content[]` with its enrichment trailer. Exact when `body` keys follow
 * the output schema's order and every enrichment field renders through {@link measuredTrailer}.
 */
export function responseBytes(body: unknown, enrichment: JsonRecord): number {
  const record = JsonRecordSchema.parse(body);
  const trailer = Object.entries(enrichment)
    .map(([key, value]) => renderValue(value, key))
    .join('\n\n');
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'x'.repeat(256),
      result: {
        structuredContent: { ...record, ...enrichment },
        content: [...formatResult(record), { type: 'text', text: `\n\n${trailer}` }],
      },
    }),
    'utf8',
  );
}

/**
 * Choose the largest whole-record prefix whose final body and enrichment fit the response budget.
 * `build` includes continuation and the supplied notice in the measured response. Empty pages
 * retain their source continuation; an indivisible oversized first record is returned whole.
 */
export function fitResponsePage<T, E extends JsonRecord>(
  available: number,
  toolName: string,
  build: (count: number, notice?: string) => { result: T; enriched: E },
): { result: T; enriched: E } {
  const full = build(available);
  if (available === 0 || responseBytes(full.result, full.enriched) <= RESPONSE_BUDGET) return full;
  for (let count = available - 1; count >= 1; count--) {
    const page = build(
      count,
      `The ${RESPONSE_BUDGET}-byte response budget ended this page after ${count} ${count === 1 ? 'record' : 'records'}; call ${toolName} with nextOffset and identical filters to continue.`,
    );
    if (responseBytes(page.result, page.enriched) <= RESPONSE_BUDGET) return page;
  }
  return build(
    1,
    `One complete record exceeds the ${RESPONSE_BUDGET}-byte response budget and is returned whole; follow nextOffset with identical filters when present.`,
  );
}
