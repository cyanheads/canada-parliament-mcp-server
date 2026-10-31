/**
 * @fileoverview Source HTML to plain text: paragraph separators, hard breaks, and link targets.
 * @module tests/domain/html-to-text.test
 */
import { describe, expect, it } from 'vitest';
import { htmlToText } from '@/domain/html-to-text.js';
import { cpu } from '../fixtures/cpu-timing.js';

describe('htmlToText', () => {
  it.each([
    [
      'an anchor inside a block',
      '<div>See the <a href="https://sencanada.ca/en/committees/nffn/45-1">committee</a>.</div>',
      'See the committee.',
      'See the committee (https://sencanada.ca/en/committees/nffn/45-1).',
    ],
    [
      'an escaped query string and a new-tab target',
      '<p><a target="_blank" href="http://www.parl.gc.ca/S.aspx?parl=41&amp;ses=2">Finance</a></p>',
      'Finance',
      'Finance (http://www.parl.gc.ca/S.aspx?parl=41&ses=2)',
    ],
    [
      'formatting inside and around the anchor',
      '<b><a href="/en/x">Bold <sup>1</sup></a></b>',
      'Bold 1',
      'Bold 1 (/en/x)',
    ],
    ['an anchor without a target', '<a name="top">Top</a><br>next', 'Top\nnext', 'Top\nnext'],
    ['a blank target', '<a href=" ">Blank</a>', 'Blank', 'Blank'],
    [
      'anchors two blocks deep beside empty separator paragraphs',
      '<div>One<p></p>Two<p><a href="https://a.test/">a</a></p></div>',
      'One\n\nTwo\n\na\n\n',
      'One\n\nTwo\n\na (https://a.test/)\n\n',
    ],
    [
      'adjacent anchors and a trailing break block',
      '<div>1.\tthe <a href="https://x.test/a">A</a>be <a href=" https://x.test/b ">B</a></div><div><br/></div>',
      '1.\tthe Abe B\n\n\n',
      '1.\tthe A (https://x.test/a)be B (https://x.test/b)\n\n\n',
    ],
    [
      'an anchor followed by an opening block',
      '<a href="https://x.test/">Link</a><p>Next</p>',
      'Link\n\nNext',
      'Link (https://x.test/)\n\nNext',
    ],
  ])('converts %s, keeping link targets only when asked', (_case, html, plain, linked) => {
    expect(htmlToText(html)).toBe(plain);
    expect(htmlToText(html, { linkTargets: true })).toBe(linked);
  });

  it.each([
    ['inline text before an opening paragraph', 'motion:<p>That</p>', 'motion:\n\nThat'],
    ['text ending in a space before a block', '2021 : <p>Que</p>', '2021 : \n\nQue'],
    ['an inline element before a block', '<b>Bold</b><div>Next</div>', 'Bold\n\nNext'],
    ['a block led by whitespace', 'One<p> Two</p>', 'One \n\nTwo'],
    ['a block whose first child is a block', 'Intro<div><p>Deep</p></div>', 'Intro\n\nDeep\n\n'],
    ['a block nested in inline markup', 'See:<span><p>Item</p></span>', 'See:\n\nItem\n\n'],
    ['list items after a label', 'Items:<ul><li>a</li><li>b</li></ul>', 'Items:\n\na\n\nb\n\n'],
    [
      'the 44-1 C-2 English notes opening',
      '<div>On December 14, 2021, the Senate adopted the following motion:<p>That, notwithstanding any provisions of the Rules, previous order or usual practice:\r\n\r\n</p><p>1.the Senate resolve itself into a Committee of the Whole</p></div>',
      'On December 14, 2021, the Senate adopted the following motion:\n\nThat, notwithstanding any provisions of the Rules, previous order or usual practice:\r\n\r\n\n\n1.the Senate resolve itself into a Committee of the Whole\n\n',
    ],
    [
      'the 44-1 C-2 French notes opening',
      '<div>Le Sénat a adopté la motion suivante le 14 décembre 2021 : <p>Que, nonobstant toute disposition du Règlement, tout ordre antérieur ou toute pratique habituelle :\r\n\r\n</p><p>1.le Sénat se forme en comité plénier</p></div>',
      'Le Sénat a adopté la motion suivante le 14 décembre 2021 : \n\nQue, nonobstant toute disposition du Règlement, tout ordre antérieur ou toute pratique habituelle :\r\n\r\n\n\n1.le Sénat se forme en comité plénier\n\n',
    ],
  ])('starts a block on a new paragraph after %s', (_case, html, text) => {
    expect(htmlToText(html)).toBe(text);
    expect(htmlToText(html, { linkTargets: true })).toBe(text);
  });

  it.each([
    ['a leading block', '<p>First</p>Tail', 'First\n\nTail'],
    ['whitespace before a leading block', '  <p>First</p>', 'First'],
    ['text ending in a hard break', 'Line<br><p>Next</p>', 'Line\nNext'],
    ['text ending in a newline', 'Line\n<p>Next</p>', 'Line\nNext'],
    ['text ending in a carriage return', 'Line\r<p>Next</p>', 'Line\rNext'],
    ['a newline then horizontal whitespace', 'Line\n  <p>Next</p>', 'Line\n  Next'],
    ['an empty block after text', 'One<p></p>Two', 'One\n\nTwo'],
    ['a whitespace-only block after text', 'One<p> </p>Two', 'One \n\nTwo'],
    ['a block led by a hard break', 'One<p><br>Two</p>', 'One\nTwo'],
    ['a block led by a newline', 'One<p>\nTwo</p>', 'One\nTwo'],
    ['closed blocks in sequence', '<p>A</p>\n<p>B</p>', 'A\n\nB'],
  ])('adds no separator for %s', (_case, html, text) => {
    expect(htmlToText(html)).toBe(text);
  });
});

describe('htmlToText table rows', () => {
  const rows = 'Year | Amount\n\n2025 | 100\n\n';
  it.each([
    [
      'a minified table',
      '<table><tr><th>Year</th><th>Amount</th></tr><tr><td>2025</td><td>100</td></tr></table>',
    ],
    [
      'header and body sections',
      '<table><thead><tr><th>Year</th><th>Amount</th></tr></thead><tbody><tr><td>2025</td><td>100</td></tr></tbody></table>',
    ],
    [
      'a pretty-printed table',
      '<table>\n  <tr>\n    <th>Year</th>\n    <th>Amount</th>\n  </tr>\n  <tr>\n    <td>2025</td>\n    <td>100</td>\n  </tr>\n</table>',
    ],
    [
      'tab and CRLF indentation around a footer section',
      '<table>\r\n\t<thead>\r\n\t\t<tr>\r\n\t\t\t<th>Year</th>\r\n\t\t\t<th>Amount</th>\r\n\t\t</tr>\r\n\t</thead>\r\n\t<tfoot>\r\n\t\t<tr>\r\n\t\t\t<td>2025</td>\r\n\t\t\t<td>100</td>\r\n\t\t</tr>\r\n\t</tfoot>\r\n</table>',
    ],
  ])('joins header and data cells with " | ", one row per paragraph, in %s', (_case, html) => {
    expect(htmlToText(html)).toBe(rows);
    expect(htmlToText(html, { linkTargets: true })).toBe(rows);
  });

  it.each([
    [
      'an empty middle cell',
      '<table><tr><td>2025</td><td></td><td>100</td></tr></table>',
      '2025 |  | 100\n\n',
    ],
    ['an empty leading cell', '<table><tr><td></td><td>100</td></tr></table>', ' | 100\n\n'],
    [
      'inline text before the table',
      'Totals:<table><tr><td>2025</td><td>100</td></tr></table>',
      'Totals:\n\n2025 | 100\n\n',
    ],
    ['text after the table', '<table><tr><td>a</td><td>b</td></tr></table>Next', 'a | b\n\nNext'],
    ['cells outside a row', '<table><td>a</td><td>b</td></table>', 'a | b'],
  ])('keeps cell positions and paragraph breaks with %s', (_case, html, text) => {
    expect(htmlToText(html)).toBe(text);
  });

  it.each([
    ['a break ending each cell', '<table><tr><td>2025<br></td><td>100<br></td></tr></table>'],
    ['a paragraph in each cell', '<table><tr><td><p>2025</p></td><td><p>100</p></td></tr></table>'],
    [
      'whitespace and breaks around each cell',
      '<table><tr><td> 2025<br> </td><td>\r\n&nbsp;100 <br>\n</td></tr></table>',
    ],
  ])('keeps the row one paragraph with %s', (_case, html) => {
    expect(htmlToText(html)).toBe('2025 | 100\n\n');
    expect(htmlToText(html, { linkTargets: true })).toBe('2025 | 100\n\n');
  });

  it.each([
    [
      'breaks',
      '<table><tr><td>Nova<br>Scotia</td><td>1 <br><br> 2</td></tr></table>',
      'Nova Scotia | 1 2',
    ],
    [
      'blocks',
      '<table><tr><td><p>a</p><p>b</p>c</td><td>d<div>e</div></td></tr></table>',
      'a b c | d e',
    ],
    [
      'a source line break',
      '<table><tr><td>Prince Edward\r\nIsland</td></tr></table>',
      'Prince Edward Island',
    ],
    [
      'a nested table',
      '<table><tr><td>a<table><tr><td>b<br></td><td>c</td></tr></table>d</td></tr></table>',
      'a b | c d',
    ],
  ])('reads %s inside a cell as single spaces', (_case, html, row) => {
    expect(htmlToText(html)).toBe(`${row}\n\n`);
  });

  it.each([
    ['spaces without a line break', '<table><tr><td>a \t b</td></tr></table>', 'a \t b\n\n'],
    [
      'inline text before a cell with leading whitespace',
      'Totals:<table><tr><td> 2025<br></td><td>100</td></tr></table>',
      'Totals:\n\n2025 | 100\n\n',
    ],
    [
      'a block after a cell ending in a break',
      '<table><td>a<br></td></table><p>Next</p>',
      'a\n\nNext',
    ],
  ])('keeps %s', (_case, html, text) => {
    expect(htmlToText(html)).toBe(text);
  });

  it('keeps a link target written after a cell break', () => {
    const html = '<table><tr><td><a href="https://x.test/r">Report<br></a></td></tr></table>';
    expect(htmlToText(html)).toBe('Report\n\n');
    expect(htmlToText(html, { linkTargets: true })).toBe('Report (https://x.test/r)\n\n');
  });

  it('keeps every position of the captured 2010-12-07 Bev Oda table of empty cells', () => {
    expect(htmlToText(`<table>${'<tr><td></td><td></td></tr>'.repeat(6)}</table>`)).toBe(
      ' | \n\n'.repeat(6),
    );
  });

  it('keeps inline markup inside a cell and its link target only when asked', () => {
    const html =
      '<table><tr><td><b>1</b> 000</td><td><a href="https://x.test/r">Report</a></td></tr></table>';
    expect(htmlToText(html)).toBe('1 000 | Report\n\n');
    expect(htmlToText(html, { linkTargets: true })).toBe('1 000 | Report (https://x.test/r)\n\n');
  });
});

/**
 * Cases run synchronously, so a wall-clock timeout cannot stop one early; it only fails a loaded
 * host after the thread-CPU assertions passed. Timeout 0 leaves those assertions as the only bound.
 * Nesting stays in bounded-depth groups: linkedom's own parser overflows the call stack near depth
 * 2,000 on Node, before this converter runs.
 */
describe('htmlToText timing', { timeout: 0 }, () => {
  const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const nested = `${'<table><tr><td>'.repeat(64)}x${'</table>'.repeat(64)}`;
  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['unclosed cell openers in one row', (n: number) => `<table><tr>${'<td>'.repeat(n / 4)}`],
    [
      'nested table and cell openers',
      (n: number) => nested.repeat(Math.max(1, Math.round(n / nested.length))),
    ],
    [
      'one whitespace run between table tags',
      (n: number) => `<table>${' \r\n\t'.repeat(n / 4)}<tr><td>a</td><td>b</td></tr></table>`,
    ],
    [
      'whitespace and breaks between every cell',
      (n: number) => `<table><tr>${'<td>a</td> \r\n'.repeat(n / 13)}</tr></table>`,
    ],
  ])('stays linear on %s', (_shape, build) => {
    htmlToText(build(sizes[0] as number));
    const perCall: number[] = [];
    for (const size of sizes) {
      const input = build(size);
      const used = cpu(() => htmlToText(input), Math.max(1, 20_000 / size), 2);
      expect(used, `${size} characters`).toBeLessThan(500_000);
      perCall.push(used);
    }
    expect((perCall.at(-1) as number) / (perCall[0] as number)).toBeLessThan(256);
  });
});
