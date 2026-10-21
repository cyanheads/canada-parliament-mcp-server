/**
 * @fileoverview Source HTML to plain text: paragraph separators, hard breaks, and link targets.
 * @module tests/domain/html-to-text.test
 */
import { describe, expect, it } from 'vitest';
import { htmlToText } from '@/domain/html-to-text.js';

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
