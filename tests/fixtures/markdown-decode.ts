/**
 * @fileoverview Structural decoder for nested-blockquote `content[]` rendering over Bun's CommonMark
 * engine and the CommonMark reference implementation: blockquote depth, hard-break lines, keys,
 * scalar types, and link/image values rebuild the rendered JSON value, and a link's text and every
 * link or image destination must spell that same value. Every Bun decode must match the reference
 * decode, since Bun's HTML cannot show a soft line break apart from an encoded newline.
 * @module tests/fixtures/markdown-decode
 */
import { execFileSync } from 'node:child_process';
import { type Node as CommonMarkNode, Parser } from 'commonmark';
import { parseHTML } from 'linkedom';
import { expect } from 'vitest';
import type { JsonRecord, JsonValue } from '@/domain/schemas.js';

type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'image'; text: string; src: string };
interface Line {
  depth: number;
  inlines: Inline[];
}
export interface DecodedContent {
  images: { text: string; src: string }[];
  links: { text: string; href: string }[];
  value: JsonRecord;
}
interface DomNode {
  childNodes: ArrayLike<DomNode>;
  getAttribute(name: string): string | null;
  nodeType: number;
  tagName: string;
  textContent: string | null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const OBJECT = Symbol('object');
const ARRAY = Symbol('array');

const plain = (inlines: Inline[]) =>
  inlines.map((inline) => (inline.kind === 'text' ? inline.text : '')).join('');
const utf8 = new TextEncoder();
/**
 * Percent-encode every octet outside the unreserved set and uppercase existing escapes, so the
 * spellings a parser may re-encode (`]` as `%5D`, a space as `%20`) compare equal while any other
 * destination does not.
 */
const canonicalUrl = (url: string) =>
  url.replace(/%[0-9A-Fa-f]{2}|[^A-Za-z0-9\-._~]/gu, (part) =>
    part.length === 3 && part.startsWith('%')
      ? part.toUpperCase()
      : [...utf8.encode(part)]
          .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
          .join(''),
  );
/** An own data property, so even a `__proto__` key lands as a field. */
const define = (target: JsonRecord, key: string, value: JsonValue) =>
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });

const rendered = new Map<string, string>();
/**
 * Render documents to HTML with the `bun` binary's CommonMark engine, so both test lanes parse
 * with it; one subprocess serves a whole batch and later decodes of those documents reuse it.
 */
export function warmBun(markdowns: readonly string[]): void {
  const pending = [...new Set(markdowns)].filter((markdown) => !rendered.has(markdown));
  if (!pending.length) return;
  const html = JSON.parse(
    execFileSync(
      'bun',
      [
        '-e',
        'const docs = JSON.parse(await Bun.stdin.text()); process.stdout.write(JSON.stringify(docs.map((doc) => Bun.markdown.html(doc))));',
      ],
      { input: JSON.stringify(pending), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    ),
  ) as string[];
  for (const [index, markdown] of pending.entries()) rendered.set(markdown, html[index] as string);
}
function fragment(markdown: string): DomNode {
  warmBun([markdown]);
  const { document } = parseHTML(`<div id="root">${rendered.get(markdown)}</div>`);
  return document.getElementById('root') as unknown as DomNode;
}
function tag(node: DomNode): string {
  return node.nodeType === ELEMENT_NODE ? node.tagName.toLowerCase() : `#${node.nodeType}`;
}
/** Only blockquotes and paragraphs; block separators are bare newlines. */
function htmlBlocks(nodes: ArrayLike<DomNode>, depth: number, lines: Line[]): void {
  for (const node of Array.from(nodes)) {
    if (node.nodeType === TEXT_NODE && /^\n*$/.test(node.textContent ?? '')) continue;
    const name = tag(node);
    if (name === 'blockquote') htmlBlocks(node.childNodes, depth + 1, lines);
    else if (name === 'p') htmlParagraph(node, depth, lines);
    else throw new Error(`Unexpected block node ${name}`);
  }
}
/** Split a paragraph at `<br />`; Bun serializes exactly one newline after each break. */
function htmlParagraph(paragraph: DomNode, depth: number, lines: Line[]): void {
  let inlines: Inline[] = [];
  let afterBreak = false;
  for (const node of Array.from(paragraph.childNodes)) {
    const name = tag(node);
    if (node.nodeType === TEXT_NODE) {
      let text = node.textContent ?? '';
      if (afterBreak) {
        if (!text.startsWith('\n')) throw new Error('Hard break without its serialized newline');
        text = text.slice(1);
      }
      if (text) inlines.push({ kind: 'text', text });
    } else if (name === 'br') {
      if (afterBreak) throw new Error('Consecutive hard breaks');
      lines.push({ depth, inlines });
      inlines = [];
    } else if (name === 'a') {
      inlines.push({
        kind: 'link',
        text: elementText(node),
        href: node.getAttribute('href') ?? '',
      });
    } else if (name === 'img') {
      inlines.push({
        kind: 'image',
        text: node.getAttribute('alt') ?? '',
        src: node.getAttribute('src') ?? '',
      });
    } else throw new Error(`Unexpected inline node ${name}`);
    afterBreak = name === 'br';
  }
  if (afterBreak) throw new Error('Paragraph ends in a hard break');
  lines.push({ depth, inlines });
}
function elementText(element: DomNode): string {
  for (const child of Array.from(element.childNodes))
    if (child.nodeType !== TEXT_NODE) throw new Error(`Unexpected node ${tag(child)} in a link`);
  return element.textContent ?? '';
}

/** CommonMark reference AST: only block_quote, paragraph, text, linebreak, link, and image. */
function referenceBlock(node: CommonMarkNode, depth: number, lines: Line[]): void {
  if (node.type === 'block_quote')
    for (let child = node.firstChild; child; child = child.next)
      referenceBlock(child, depth + 1, lines);
  else if (node.type === 'paragraph') referenceParagraph(node, depth, lines);
  else throw new Error(`Unexpected block node ${node.type}`);
}
function referenceLiteral(parent: CommonMarkNode): string {
  let text = '';
  for (let node = parent.firstChild; node; node = node.next) {
    if (node.type !== 'text') throw new Error(`Unexpected node ${node.type} in ${parent.type}`);
    text += node.literal ?? '';
  }
  return text;
}
/** A soft line break is no inline the renderer emits, so it fails here as an unexpected node. */
function referenceParagraph(parent: CommonMarkNode, depth: number, lines: Line[]): void {
  let inlines: Inline[] = [];
  for (let node = parent.firstChild; node; node = node.next) {
    if (node.type === 'text') inlines.push({ kind: 'text', text: node.literal ?? '' });
    else if (node.type === 'linebreak') {
      lines.push({ depth, inlines });
      inlines = [];
    } else if (node.type === 'link')
      inlines.push({ kind: 'link', text: referenceLiteral(node), href: node.destination ?? '' });
    else if (node.type === 'image')
      inlines.push({ kind: 'image', text: referenceLiteral(node), src: node.destination ?? '' });
    else throw new Error(`Unexpected inline node ${node.type}`);
  }
  lines.push({ depth, inlines });
}
function topLevel(markdown: string): CommonMarkNode[] {
  const nodes: CommonMarkNode[] = [];
  for (let node = new Parser().parse(markdown).firstChild; node; node = node.next) nodes.push(node);
  return nodes;
}
function commonMarkLines(markdown: string): Line[] {
  const lines: Line[] = [];
  for (const node of topLevel(markdown)) referenceBlock(node, 0, lines);
  return lines;
}

/** Split `key: value` at a leading JSON string literal, else at the first `": "`, else a final `:`. */
function splitKey(text: string): [key: string, rest: string] {
  if (text.startsWith('"')) {
    let end = 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) throw new Error(`Unterminated quoted key in ${JSON.stringify(text)}`);
    const rest = text.slice(end + 1);
    if (!rest.startsWith(':'))
      throw new Error(`Quoted key without a colon in ${JSON.stringify(text)}`);
    return [JSON.parse(text.slice(0, end + 1)) as string, rest.slice(1)];
  }
  const colon = text.indexOf(': ');
  if (colon !== -1) return [text.slice(0, colon), text.slice(colon + 1)];
  if (text.endsWith(':')) return [text.slice(0, -1), ''];
  throw new Error(`Line has no key separator: ${JSON.stringify(text)}`);
}
function scalar(rest: string): JsonValue | typeof OBJECT | typeof ARRAY {
  if (rest === '') return '';
  if (!rest.startsWith(' ') || rest === ' ')
    throw new Error(`Malformed value ${JSON.stringify(rest)}`);
  const text = rest.slice(1);
  switch (text) {
    case '[object]':
      return OBJECT;
    case '[array]':
      return ARRAY;
    case '{}':
      return {};
    case '[]':
      return [];
    case 'true':
      return true;
    case 'false':
      return false;
    case 'null':
      return null;
  }
  if (JSON_NUMBER.test(text)) return Number(text);
  if (!text.startsWith('"')) return text;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'string') throw new Error(`Quoted value is not a string: ${text}`);
  return parsed;
}

/** Rebuild the value: a container line owns the following lines one depth deeper. */
function decodeLines(lines: Line[]): DecodedContent {
  const links: DecodedContent['links'] = [];
  const images: DecodedContent['images'] = [];
  const entry = ({
    inlines,
  }: Line): { key: string; value: JsonValue | typeof OBJECT | typeof ARRAY } => {
    const element = inlines.findIndex((inline) => inline.kind !== 'text');
    const [key, rest] = splitKey(plain(element === -1 ? inlines : inlines.slice(0, element)));
    if (element === -1) return { key, value: scalar(rest) };
    const target = inlines[element] as Exclude<Inline, { kind: 'text' }>;
    const tail = inlines.slice(element + 1);
    if (rest !== ' ' || tail.some((inline) => inline.kind !== 'text'))
      throw new Error(`Link or image must be a whole value after ${JSON.stringify(key)}`);
    const original = plain(tail);
    if (original !== '' && !original.startsWith(' '))
      throw new Error(`Unseparated text after link or image ${JSON.stringify(original)}`);
    const destination = target.kind === 'link' ? target.href : target.src;
    const shown = target.kind === 'image' ? target.src : target.text;
    const value = original === '' ? shown : original.slice(1);
    if (target.kind === 'link' && target.text !== value)
      throw new Error(`Link text ${JSON.stringify(target.text)} is not its value`);
    if (canonicalUrl(destination) !== canonicalUrl(value))
      throw new Error(`Destination ${JSON.stringify(destination)} is not ${JSON.stringify(value)}`);
    if (target.kind === 'link') links.push({ text: target.text, href: target.href });
    else images.push({ text: target.text, src: target.src });
    return { key, value };
  };
  let index = 0;
  const read = (depth: number, array: boolean): JsonValue[] | JsonRecord => {
    const out: JsonValue[] | JsonRecord = array ? [] : {};
    while (index < lines.length && (lines[index] as Line).depth >= depth) {
      const line = lines[index++] as Line;
      if (line.depth !== depth)
        throw new Error(`Line ${index} opens depth ${line.depth} without a container`);
      const { key, value } = entry(line);
      let resolved: JsonValue;
      if (value === OBJECT || value === ARRAY) {
        const children = read(depth + 1, value === ARRAY);
        if (Object.keys(children).length === 0)
          throw new Error(`Container ${JSON.stringify(key)} renders a marker without children`);
        resolved = children;
      } else resolved = value;
      if (Array.isArray(out)) {
        if (key !== String(out.length)) throw new Error(`Array index ${key} out of order`);
        out.push(resolved);
      } else {
        if (Object.hasOwn(out, key)) throw new Error(`Duplicate key ${JSON.stringify(key)}`);
        define(out, key, resolved);
      }
    }
    return out;
  };
  const value = read(1, false) as JsonRecord;
  if (index !== lines.length) throw new Error('Text outside the rendered blockquotes');
  return { value, links, images };
}

function bunLines(markdown: string): Line[] {
  const lines: Line[] = [];
  htmlBlocks(fragment(markdown).childNodes, 0, lines);
  return lines;
}
/** An encoded standalone string parses to at most one top-level paragraph of plain text. */
function standalone(lines: Line[]): string {
  const [line, ...extra] = lines;
  if (!line) return '';
  if (extra.length || line.depth !== 0 || line.inlines.some((inline) => inline.kind !== 'text'))
    throw new Error('Encoded text produced structure beyond one plain paragraph');
  return plain(line.inlines);
}

/**
 * Bun's HTML serializes a soft line break exactly like an encoded newline, so a Bun decode counts
 * only when the reference AST, which keeps soft breaks distinct, decodes the same value.
 */
function agree(bun: JsonValue, reference: JsonValue): void {
  if (JSON.stringify(bun) !== JSON.stringify(reference))
    throw new Error('Bun and the CommonMark reference decode different values');
}

/** Decode one rendered document with Bun's CommonMark engine, confirmed by the reference. */
export function decodeBun(markdown: string): DecodedContent {
  const decoded = decodeLines(bunLines(markdown));
  agree(decoded.value, decodeLines(commonMarkLines(markdown)).value);
  return decoded;
}
/** Decode one rendered document with the CommonMark reference implementation. */
export function decodeCommonMark(markdown: string): DecodedContent {
  return decodeLines(commonMarkLines(markdown));
}
/** Text of one encoded standalone string under Bun's CommonMark engine, confirmed by the reference. */
export function standaloneBun(markdown: string): string {
  const text = standalone(bunLines(markdown));
  agree(text, standalone(commonMarkLines(markdown)));
  return text;
}
/** Text of one encoded standalone string under the CommonMark reference implementation. */
export function standaloneCommonMark(markdown: string): string {
  return standalone(commonMarkLines(markdown));
}
/**
 * Decode every top-level blockquote that is a rendered field, skipping the framework's own trailer
 * lines (`**N total**`, raw notice quotes) that neither parser reads as one; a blockquote that
 * either parser reads as a field must decode to the same value under both.
 */
export function decodeBunFields(markdown: string): JsonRecord {
  const quotes = Array.from(fragment(markdown).childNodes).filter(
    (node) => tag(node) === 'blockquote',
  );
  const references = topLevel(markdown).filter((node) => node.type === 'block_quote');
  if (quotes.length !== references.length)
    throw new Error('Bun and the CommonMark reference find different top-level blockquotes');
  const field = (read: (lines: Line[]) => void): JsonRecord | null => {
    try {
      const lines: Line[] = [];
      read(lines);
      return decodeLines(lines).value;
    } catch {
      return null;
    }
  };
  const fields: JsonRecord = {};
  for (const [index, quote] of quotes.entries()) {
    const bun = field((lines) => htmlBlocks([quote], 0, lines));
    const reference = field((lines) =>
      referenceBlock(references[index] as CommonMarkNode, 0, lines),
    );
    if (!bun && !reference) continue;
    agree(bun, reference);
    for (const [key, value] of Object.entries(bun as JsonRecord)) define(fields, key, value);
  }
  return fields;
}
/** Assert a decode reproduces the JSON wire form of `expected` exactly, key order and types included. */
export function expectExact(actual: unknown, expected: unknown): void {
  const wire: unknown = JSON.parse(JSON.stringify(expected));
  expect(actual).toStrictEqual(wire);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(wire));
}
