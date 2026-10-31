/**
 * @fileoverview Source HTML to complete decoded plain text, shared by speech and dossier parsers.
 * @module domain/html-to-text
 */
import { parseHTML } from 'linkedom';
import { assertRepresentableText } from './normalization.js';

interface HtmlNode {
  childNodes: ArrayLike<HtmlNode>;
  getAttribute?(name: string): string | null;
  nodeName: string;
  nodeType: number;
  textContent: string | null;
}
const BLOCKS = new Set(['p', 'div', 'blockquote', 'li', 'section', 'h1', 'h2', 'h3', 'tr']);
/** Table structure whose whitespace-only text is source indentation, never cell content. */
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr']);
const CELLS = new Set(['td', 'th']);

/** Writes text in order, starting each block's first visible character on a new paragraph. */
interface ParagraphWriter {
  /** The next visible character starts a new paragraph unless a line break precedes it. */
  openBlock(): void;
  write(text: string): void;
}
function paragraphWriter(sink: (text: string) => void): ParagraphWriter {
  /** Visible text has been written with no line break after it. */
  let open = false;
  /** A block opened after the last visible character was written. */
  let blockOpened = false;
  return {
    openBlock() {
      blockOpened = true;
    },
    write(text) {
      const visible = blockOpened ? text.search(/\S/) : -1;
      if (visible >= 0) {
        blockOpened = false;
        const lead = text.slice(0, visible);
        sink(open && !/[\n\r]/.test(lead) ? `${lead}\n\n${text.slice(visible)}` : text);
      } else sink(text);
      const tail = text.slice(text.trimEnd().length);
      if (/[\n\r]/.test(tail)) open = false;
      else if (tail.length < text.length) open = true;
    },
  };
}
/** `text` with each whitespace run that holds a line break as one space. */
function spaceBreaks(text: string): string {
  if (!/[\n\r]/.test(text)) return text;
  return text.replace(/\s+/g, (run) => (/[\n\r]/.test(run) ? ' ' : run));
}
/**
 * Writer for a table cell and the cells nested in it: their text reaches `row` without the cell's
 * leading and trailing whitespace, and with each whitespace run that holds a line break or block
 * boundary as one space.
 */
function cellWriter(row: ParagraphWriter): ParagraphWriter {
  /** Visible text has been written in the cell. */
  let written = false;
  /** Whitespace after the cell's last visible text, written only when visible text follows it. */
  let held = '';
  return paragraphWriter((text) => {
    const start = written ? 0 : text.search(/\S/);
    if (start < 0) return;
    const end = text.trimEnd().length;
    if (end <= start) {
      held += text;
      return;
    }
    row.write(spaceBreaks(`${held}${text.slice(start, end)}`));
    held = text.slice(end);
    written = true;
  });
}

/**
 * Convert source HTML to complete decoded prose, retaining paragraph and hard breaks. Each block
 * ends its paragraph, and a block's first visible character starts a new one unless a line break
 * already precedes it. A table row is one block whose header and data cells are joined by ` | `,
 * an empty cell keeping its position; a cell's own line breaks and blocks read as single spaces,
 * and its leading and trailing whitespace is dropped. With `linkTargets`, each anchor with a
 * nonblank `href` keeps its target as `text (href)`.
 */
export function htmlToText(html: string, options: { linkTargets?: boolean } = {}): string {
  const { document } = parseHTML('<html><body></body></html>');
  const container = document.createElement('div');
  container.innerHTML = html;
  const parts: string[] = [];
  const prose = paragraphWriter((text) => parts.push(text));
  function visit(node: HtmlNode, writer: ParagraphWriter): void {
    const name = node.nodeName.toLowerCase();
    if (node.nodeType === 3 || name === 'br') {
      writer.write(name === 'br' ? '\n' : (node.textContent ?? ''));
      return;
    }
    const block = node !== container && BLOCKS.has(name);
    if (block) writer.openBlock();
    const children = Array.from(node.childNodes);
    const tablePart = TABLE_PARTS.has(name);
    let cells = 0;
    for (const [index, child] of children.entries()) {
      const adjacentBlock = [children[index - 1], children[index + 1]].some(
        (sibling) => sibling && BLOCKS.has(sibling.nodeName.toLowerCase()),
      );
      const blank = child.nodeType === 3 && /^\s*$/.test(child.textContent ?? '');
      if (blank && (tablePart || adjacentBlock)) continue;
      if (!CELLS.has(child.nodeName.toLowerCase())) visit(child, writer);
      else {
        if (cells++ > 0) writer.write(' | ');
        visit(child, writer === prose ? cellWriter(prose) : writer);
      }
    }
    const target = options.linkTargets && name === 'a' ? node.getAttribute?.('href')?.trim() : '';
    if (target) writer.write(` (${target})`);
    else if (block) writer.write('\n\n');
  }
  visit(container, prose);
  const rendered = parts.join('');
  const last = Array.from((container as HtmlNode).childNodes).findLast(
    (node) => node.nodeType !== 3 || !/^\s*$/.test(node.textContent ?? ''),
  );
  const result =
    last && BLOCKS.has(last.nodeName.toLowerCase()) ? rendered.replace(/\n\n$/, '') : rendered;
  assertRepresentableText(result);
  return result;
}
