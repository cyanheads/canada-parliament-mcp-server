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

/**
 * Convert source HTML to complete decoded prose, retaining paragraph and hard breaks. Each block
 * ends its paragraph, and a block's first visible character starts a new one unless a line break
 * already precedes it. With `linkTargets`, each anchor with a nonblank `href` keeps its target as
 * `text (href)`.
 */
export function htmlToText(html: string, options: { linkTargets?: boolean } = {}): string {
  const { document } = parseHTML('<html><body></body></html>');
  const container = document.createElement('div');
  container.innerHTML = html;
  const parts: string[] = [];
  /** Visible text has been written with no line break after it. */
  let open = false;
  /** A block opened after the last visible character was written. */
  let blockOpened = false;
  function write(text: string): void {
    const visible = blockOpened ? text.search(/\S/) : -1;
    if (visible >= 0) {
      blockOpened = false;
      const lead = text.slice(0, visible);
      if (open && !/[\n\r]/.test(lead)) parts.push(lead, '\n\n', text.slice(visible));
      else parts.push(text);
    } else parts.push(text);
    const tail = text.slice(text.trimEnd().length);
    if (/[\n\r]/.test(tail)) open = false;
    else if (tail.length < text.length) open = true;
  }
  function visit(node: HtmlNode): void {
    const name = node.nodeName.toLowerCase();
    if (node.nodeType === 3 || name === 'br') {
      write(name === 'br' ? '\n' : (node.textContent ?? ''));
      return;
    }
    const block = node !== container && BLOCKS.has(name);
    if (block) blockOpened = true;
    const children = Array.from(node.childNodes);
    for (const [index, child] of children.entries()) {
      const adjacentBlock = [children[index - 1], children[index + 1]].some(
        (sibling) => sibling && BLOCKS.has(sibling.nodeName.toLowerCase()),
      );
      if (child.nodeType === 3 && /^\s*$/.test(child.textContent ?? '') && adjacentBlock) continue;
      visit(child);
    }
    const target = options.linkTargets && name === 'a' ? node.getAttribute?.('href')?.trim() : '';
    if (target) write(` (${target})`);
    else if (block) write('\n\n');
  }
  visit(container);
  const rendered = parts.join('');
  const last = Array.from((container as HtmlNode).childNodes).findLast(
    (node) => node.nodeType !== 3 || !/^\s*$/.test(node.textContent ?? ''),
  );
  const result =
    last && BLOCKS.has(last.nodeName.toLowerCase()) ? rendered.replace(/\n\n$/, '') : rendered;
  assertRepresentableText(result);
  return result;
}
