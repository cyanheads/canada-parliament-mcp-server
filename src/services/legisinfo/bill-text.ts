/**
 * @fileoverview A bill version's official text: the DocumentViewer page's XML export link, and the
 * bill XML verified and converted to plain-text segments.
 * @module services/legisinfo/bill-text
 */
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { XMLParser } from 'fast-xml-parser';
import { decodeXmlEntities } from '@/domain/xml-entities.js';
import { invalidResponse } from './parsing.js';
import type {
  BillTextDocument,
  BillTextHeading,
  BillTextIntroduction,
  BillTextLanguage,
  BillTextSchedule,
  BillTextSection,
} from './types.js';

/** A `preserveOrder` node: one element name (or `#text`) keyed to its children, plus `:@`. */
type XmlNode = Record<string, unknown>;
/**
 * Default mode merges mixed content's text runs and loses their order around inline elements;
 * `preserveOrder` keeps document order. Entities stay raw for `decodeXmlEntities`.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  htmlEntities: false,
  preserveOrder: true,
});
/** Elements whose whole content is one line of inline text. */
const LINES = new Set([
  'BilingualItemEn',
  'BilingualItemFr',
  'Caption',
  'ExplanatoryText',
  'FormulaConnector',
  'FormulaText',
  'HistoricalNote',
  'LongTitle',
  'MarginalNote',
  'Note',
  'OriginatingRef',
  'ShortTitle',
  'Text',
  'TitleText',
  'title',
]);
/** Elements whose text opens the next line instead of standing alone. */
const PREFIXES = new Set(['Label', 'FormulaTerm']);
const INTRODUCTION: Record<string, keyof Omit<BillTextIntroduction, 'explanatoryNotes'> | null> = {
  Recommendation: 'recommendation',
  Summary: 'summary',
  Preamble: 'preamble',
  Enacts: 'enactingClause',
  // The table of provisions repeats the body's headings and labels.
  TableOfProvisions: null,
};

/** The verified identity a bill document must carry. */
export interface BillTextRequest {
  billCode: string;
  language: BillTextLanguage;
  session: string;
}

function nameOf(node: XmlNode): string {
  const name = Object.keys(node).find((key) => key !== ':@');
  if (name === undefined) return invalidResponse();
  return name;
}
function kids(node: XmlNode, name: string): XmlNode[] {
  const value = node[name];
  if (!Array.isArray(value)) return invalidResponse();
  return value as XmlNode[];
}
function raw(node: XmlNode): string {
  const value = node['#text'];
  if (typeof value !== 'string') return invalidResponse();
  return value;
}
function attribute(node: XmlNode, name: string): string | null {
  const attributes = node[':@'] as Record<string, unknown> | undefined;
  const value = attributes?.[`@_${name}`];
  if (value === undefined) return null;
  if (typeof value !== 'string') return invalidResponse();
  return decodeXmlEntities(value, invalidResponse);
}
function blank(text: string): boolean {
  return !/[^\t\n\r ]/.test(text);
}
/** XML whitespace runs as one space, trimmed; empty is null. */
function clean(text: string): string | null {
  return text.replace(/[\t\n\r ]+/g, ' ').trim() || null;
}
/** Decoded text of every descendant text node, in document order. */
function inline(nodes: XmlNode[]): string {
  const parts: string[] = [];
  const visit = (list: XmlNode[]) => {
    for (const node of list) {
      const name = nameOf(node);
      if (name === '#text') parts.push(decodeXmlEntities(raw(node), invalidResponse));
      else visit(kids(node, name));
    }
  };
  visit(nodes);
  return parts.join('');
}
function hasText(nodes: XmlNode[]): boolean {
  return nodes.some((node) => nameOf(node) === '#text' && !blank(raw(node)));
}
/** Element children by name; non-blank text at this structural level is invalid. */
function elements(nodes: XmlNode[]): [string, XmlNode][] {
  return nodes.flatMap((node): [string, XmlNode][] => {
    const name = nameOf(node);
    if (name !== '#text') return [[name, node]];
    if (!blank(raw(node))) invalidResponse();
    return [];
  });
}
function only(children: [string, XmlNode][], name: string): XmlNode | undefined {
  const matches = children.filter(([key]) => key === name);
  if (matches.length > 1) invalidResponse();
  return matches[0]?.[1];
}
function lineOf(node: XmlNode | undefined, name: string): string | null {
  return node ? clean(inline(kids(node, name))) : null;
}

/** Lines of plain text, explanatory notes kept apart, and the labels waiting for their line. */
interface Writer {
  lines: string[];
  notes: string[];
  prefix: string;
  /** Counts changes to `prefix`, so a container can tell whether its content touched it. */
  version: number;
}
const writer = (): Writer => ({ lines: [], notes: [], prefix: '', version: 0 });
function emit(out: Writer, text: string | null): void {
  if (text === null) return;
  out.lines.push(out.prefix ? `${out.prefix} ${text}` : text);
  if (out.prefix) {
    out.prefix = '';
    out.version++;
  }
}
/** A label nothing followed stands on its own line. */
function flush(out: Writer): void {
  if (!out.prefix) return;
  out.lines.push(out.prefix);
  out.prefix = '';
  out.version++;
}
/** Write `nodes` as lines: one per block, labels opening their line, table rows as ` | ` cells. */
function write(nodes: XmlNode[], out: Writer): void {
  for (const node of nodes) {
    const name = nameOf(node);
    if (name === '#text') {
      emit(out, clean(decodeXmlEntities(raw(node), invalidResponse)));
      continue;
    }
    const children = kids(node, name);
    if (name === 'ExplanatoryNote') {
      const note = writer();
      write(children, note);
      flush(note);
      out.notes.push(...note.lines, ...note.notes);
    } else if (PREFIXES.has(name)) {
      const label = clean(inline(children));
      if (label) {
        out.prefix = out.prefix ? `${out.prefix} ${label}` : label;
        out.version++;
      }
    } else if (name === 'row') {
      const cells = elements(children).map(([, cell]) => {
        const content = writer();
        write([cell], content);
        flush(content);
        out.notes.push(...content.notes);
        return content.lines.join(' ');
      });
      emit(out, cells.some(Boolean) ? cells.join(' | ') : null);
    } else if (LINES.has(name) || hasText(children)) emit(out, clean(inline(children)));
    else {
      // A label this element set, or an inherited one it extended, ends with the element; one it
      // left untouched still opens the parent's next line.
      const version = out.version;
      write(children, out);
      if (out.version !== version) flush(out);
    }
  }
}
/** `{ text, explanatoryNotes }` for `nodes`, each null when empty. */
function render(nodes: XmlNode[]): { text: string | null; explanatoryNotes: string | null } {
  const out = writer();
  write(nodes, out);
  flush(out);
  return { text: out.lines.join('\n') || null, explanatoryNotes: out.notes.join('\n') || null };
}

/**
 * Throw unless `xml` is a whole document: a body that ends before `</Bill>` is transient, a read cut
 * short that the parser would otherwise accept as a partial tree. A document declaring a DTD or
 * entities is a deterministic `upstream_response_invalid`.
 */
function assertComplete(xml: string): void {
  if (/^\s*<(?:!doctype\s+html|html\b)/i.test(xml))
    throw serviceUnavailable('LEGISinfo returned HTML instead of the bill XML.');
  if (!xml.trimEnd().endsWith('</Bill>'))
    throw serviceUnavailable('The bill XML ended before its closing Bill element.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) invalidResponse();
}
function positive(node: XmlNode | undefined, name: string): number {
  const value = lineOf(node, name);
  if (value === null || !/^[1-9]\d{0,5}$/.test(value)) return invalidResponse();
  return Number(value);
}
/** `YYYY-MM-DD` from a `Date` element's `YYYY`, `MM`, and `DD`, verified as a calendar date. */
function stageDate(date: XmlNode | undefined): string | null {
  if (!date) return null;
  const parts = elements(kids(date, 'Date'));
  const [year, month, day] = ['YYYY', 'MM', 'DD'].map((name) => {
    const value = lineOf(only(parts, name), name);
    if (value === null || !/^\d{1,4}$/.test(value)) return invalidResponse();
    return Number(value);
  }) as [number, number, number];
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1000 ||
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  )
    return invalidResponse();
  return instant.toISOString().slice(0, 10);
}
function identification(node: XmlNode, expected: BillTextRequest) {
  const children = elements(kids(node, 'Identification'));
  const billNumber = lineOf(only(children, 'BillNumber'), 'BillNumber');
  const parliament = only(children, 'Parliament');
  if (!parliament) return invalidResponse();
  const numbers = elements(kids(parliament, 'Parliament'));
  const session = `${positive(only(numbers, 'Number'), 'Number')}-${positive(only(numbers, 'Session'), 'Session')}`;
  if (billNumber !== expected.billCode || session !== expected.session) invalidResponse();
  const history = only(children, 'BillHistory');
  const stages = history
    ? elements(kids(history, 'BillHistory')).filter(([name]) => name === 'Stages')
    : [];
  const stage = stages.at(-1)?.[1];
  return {
    longTitle: lineOf(only(children, 'LongTitle'), 'LongTitle'),
    shortTitle: lineOf(only(children, 'ShortTitle'), 'ShortTitle'),
    sponsor: lineOf(only(children, 'BillSponsor'), 'BillSponsor'),
    stage: stage ? attribute(stage, 'stage') : null,
    stageDate: stage ? stageDate(only(elements(kids(stage, 'Stages')), 'Date')) : null,
  };
}
function introduction(node: XmlNode | undefined): BillTextIntroduction {
  const parts: Record<keyof BillTextIntroduction, string[]> = {
    recommendation: [],
    summary: [],
    preamble: [],
    enactingClause: [],
    explanatoryNotes: [],
  };
  for (const [name, child] of node ? elements(kids(node, 'Introduction')) : []) {
    if (!Object.hasOwn(INTRODUCTION, name)) invalidResponse();
    const field = INTRODUCTION[name];
    if (!field) continue;
    const { text, explanatoryNotes } = render(kids(child, name));
    if (text) parts[field].push(text);
    if (explanatoryNotes) parts.explanatoryNotes.push(explanatoryNotes);
  }
  const join = (lines: string[]) => lines.join('\n') || null;
  return {
    recommendation: join(parts.recommendation),
    summary: join(parts.summary),
    preamble: join(parts.preamble),
    enactingClause: join(parts.enactingClause),
    explanatoryNotes: join(parts.explanatoryNotes),
  };
}
interface OpenHeading {
  heading: BillTextHeading;
  path: string | null;
}
/** Body sections with their heading paths, and the headings with the section runs they span. */
function body(node: XmlNode): { body: BillTextSection[]; headings: BillTextHeading[] } {
  const sections: BillTextSection[] = [];
  const headings: BillTextHeading[] = [];
  /** Headings still open: each level strictly deeper than the one before it. */
  const open: OpenHeading[] = [];
  const close = (heading: BillTextHeading) => {
    heading.count = sections.length - heading.offset;
    heading.firstLabel = sections[heading.offset]?.label ?? null;
    heading.lastLabel = heading.count ? (sections.at(-1)?.label ?? null) : null;
  };
  const textLength: number[] = [0];
  for (const [name, child] of elements(kids(node, 'Body'))) {
    const children = kids(child, name);
    if (name === 'Heading') {
      const parts = elements(children);
      if (parts.some(([part]) => !['Label', 'TitleText', 'MarginalNote'].includes(part)))
        invalidResponse();
      const level = attribute(child, 'level');
      if (level === null || !/^[1-9]\d{0,2}$/.test(level)) return invalidResponse();
      const heading: BillTextHeading = {
        index: headings.length,
        level: Number(level),
        label: lineOf(only(parts, 'Label'), 'Label'),
        title: lineOf(only(parts, 'TitleText'), 'TitleText'),
        citation: lineOf(only(parts, 'MarginalNote'), 'MarginalNote'),
        offset: sections.length,
        count: 0,
        firstLabel: null,
        lastLabel: null,
        characters: 0,
      };
      while ((open.at(-1)?.heading.level ?? 0) >= heading.level)
        close((open.pop() as OpenHeading).heading);
      const path = [heading.label, heading.title].filter(Boolean).join(' ') || null;
      open.push({ heading, path });
      headings.push(heading);
    } else if (name === 'Section') {
      const label = children.find((part) => nameOf(part) === 'Label');
      const marginalNote = children.find((part) => nameOf(part) === 'MarginalNote');
      const { text, explanatoryNotes } = render(
        children.filter((part) => part !== label && part !== marginalNote),
      );
      sections.push({
        label: lineOf(label, 'Label'),
        marginalNote: lineOf(marginalNote, 'MarginalNote'),
        headings: open.flatMap(({ path }) => (path === null ? [] : [path])),
        text,
        explanatoryNotes,
      });
      textLength.push((textLength.at(-1) as number) + (text?.length ?? 0));
    } else invalidResponse();
  }
  for (const { heading } of open) close(heading);
  for (const heading of headings)
    heading.characters =
      (textLength[heading.offset + heading.count] as number) -
      (textLength[heading.offset] as number);
  return { body: sections, headings };
}
function schedule(node: XmlNode): BillTextSchedule {
  const children = kids(node, 'Schedule');
  const heading = children.find((part) => nameOf(part) === 'ScheduleFormHeading');
  const headingParts = heading ? kids(heading, 'ScheduleFormHeading') : [];
  const label = headingParts.find((part) => nameOf(part) === 'Label');
  const originatingRef = headingParts.find((part) => nameOf(part) === 'OriginatingRef');
  const { text, explanatoryNotes } = render([
    ...headingParts.filter((part) => part !== label && part !== originatingRef),
    ...children.filter((part) => part !== heading),
  ]);
  return {
    label: lineOf(label, 'Label'),
    originatingRef: lineOf(originatingRef, 'OriginatingRef'),
    text,
    explanatoryNotes,
  };
}

/**
 * Verify and convert one official bill XML document. Throws transient `ServiceUnavailable` for a
 * body cut short or an HTML page, and `upstream_response_invalid` for a malformed document, an
 * unexpected structure, or an `xml:lang`, `BillNumber`, or parliament and session other than
 * `expected`.
 */
export function parseBillText(xml: string, expected: BillTextRequest): BillTextDocument {
  assertComplete(xml);
  let document: XmlNode[];
  try {
    // `true` validates well-formedness first; parsing alone accepts mismatched and unclosed tags.
    document = parser.parse(xml, true) as XmlNode[];
  } catch {
    return invalidResponse();
  }
  const roots = elements(document.filter((node) => nameOf(node) !== '?xml'));
  const [root] = roots;
  if (roots.length !== 1 || root?.[0] !== 'Bill') return invalidResponse();
  const bill = root[1];
  if (attribute(bill, 'xml:lang') !== expected.language) invalidResponse();
  const children = elements(kids(bill, 'Bill'));
  const known = ['Identification', 'Introduction', 'Body', 'Schedule'];
  if (children.some(([name]) => !known.includes(name))) invalidResponse();
  const identity = only(children, 'Identification');
  const main = only(children, 'Body');
  if (!identity || !main) return invalidResponse();
  return {
    billCode: expected.billCode,
    session: expected.session,
    language: expected.language,
    ...identification(identity, expected),
    introduction: introduction(only(children, 'Introduction')),
    ...body(main),
    schedules: children.filter(([name]) => name === 'Schedule').map(([, node]) => schedule(node)),
  };
}

/**
 * Incremental scan of a DocumentViewer page for its XML export anchor
 * (`<a class="btn btn-export-xml" href="…">`). Each decoded chunk returns the anchor's raw `href`,
 * `null` once the publication content begins with no such anchor before it (the export options
 * always precede it), or `undefined` while undecided; a page that ends undecided is incomplete,
 * and the caller retries it. Each character is examined once; only a tag still open at a chunk
 * boundary is carried into the next chunk.
 */
export function exportLinkScanner(): (chunk: string) => string | null | undefined {
  /** Content of the tag being read, from after its `<`, or null between tags. */
  let tag: string | null = null;
  const inspect = (content: string): string | null | undefined => {
    if (/^a\s/i.test(content) && content.includes('btn-export-xml')) {
      const href = /\shref="([^"]*)"/.exec(content)?.[1];
      return href ?? invalidResponse();
    }
    return content.includes('publication-container') ? null : undefined;
  };
  return (chunk) => {
    let position = 0;
    for (;;) {
      if (tag === null) {
        const open = chunk.indexOf('<', position);
        if (open < 0) return;
        tag = '';
        position = open + 1;
      }
      const close = chunk.indexOf('>', position);
      if (close < 0) {
        tag += chunk.slice(position);
        return;
      }
      const result = inspect(tag + chunk.slice(position, close));
      if (result !== undefined) return result;
      tag = null;
      position = close + 1;
    }
  };
}
