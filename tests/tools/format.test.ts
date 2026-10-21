/**
 * @fileoverview CommonMark parser assertions for recursive lossless result rendering.
 * @module tests/tools/format.test
 */
import { execFileSync } from 'node:child_process';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { JsonRecordSchema } from '@/domain/schemas.js';
import {
  encodeText,
  formatResult,
  renderUrl,
  renderValue,
} from '@/mcp-server/tools/definitions/_format.js';

interface ParsedMarkdown {
  images: { text: string; src: string }[];
  links: { text: string; href: string }[];
  text: string;
}

/** Use Bun's actual CommonMark engine; callbacks receive already decoded nodes. */
function parseMarkdown(markdown: string): ParsedMarkdown {
  const script = `
const markdown = await Bun.stdin.text();
const result = { text: '', links: [], images: [] };
Bun.markdown.render(markdown, {
  text(value) { result.text += value; return value; }
});
const { parseHTML } = await import('linkedom');
const { document } = parseHTML(Bun.markdown.html(markdown));
result.links = [...document.querySelectorAll('a')].map(a => ({ text: a.textContent, href: a.getAttribute('href') }));
result.images = [...document.querySelectorAll('img')].map(img => ({ text: img.getAttribute('alt'), src: img.getAttribute('src') }));
console.log(JSON.stringify(result));
`;
  return JSON.parse(
    execFileSync('bun', ['-e', script], { input: markdown, encoding: 'utf8' }),
  ) as ParsedMarkdown;
}

describe('lossless CommonMark formatting', () => {
  it.each([
    '',
    ' plain text ',
    '\tleading\ttrailing\t',
    'one\rtwo',
    'one\ntwo',
    'one\r\ntwo',
    '\r\n\n\r',
    '"double" and \'single\' &amp; &#10; &#x0A;',
    '```json\n{"x": 1}\n```',
    '# heading\n> forged quote\n\n![fake](https://evil.test) <script>x</script>',
    'é e\u0301 😀 \u2028 \u2029',
    '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  ])('parsed text directly equals the original %j', (value) => {
    expect(parseMarkdown(encodeText(value))).toEqual({ text: value, links: [], images: [] });
    expect(parseMarkdown(renderValue(value, 'source')).text).toBe(
      value === '' ? 'source:' : `source: ${value}`,
    );
  });
  it('renders every nested key and scalar without losing unknown records or nulls', () => {
    const record = {
      'unknown\r\nkey': [
        {
          'fence``` &amp;': 'first\rsecond\nthird\r\nfourth',
          count: 0,
          flag: false,
          missing: null,
        },
        ['deep', { 'last>key': ' last ' }],
      ],
      emptyArray: [],
      emptyObject: {},
    };
    const structured = JsonRecordSchema.parse(record);
    const blocks = formatResult(structured);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const parsed = parseMarkdown(blocks[0]?.text ?? '');
    expect(parsed.text).toBe(
      'value: [object]unknown\r\nkey: [array]0: [object]fence``` &amp;: first\rsecond\nthird\r\nfourthcount: 0flag: falsemissing: null1: [array]0: deep1: [object]last>key:  last emptyArray: []emptyObject: {}',
    );
    expect(structured).toEqual(record);
  });
  it.each([
    'https://example.test/path?a=1&b=2',
    'https://example.test/a_(b)#fragment',
    'https://example.test/%22quote%22?literal=&amp;',
  ])('renders exact link and image destinations %s', (url) => {
    const link = parseMarkdown(renderUrl(url));
    expect(link.text).toBe(url);
    expect(link.links).toEqual([{ text: url, href: url }]);
    const image = parseMarkdown(renderValue(url, 'portraitUrl'));
    expect(image.images).toEqual([{ text: 'imageUrl', src: url }]);
    expect(image.text).toBe('portraitUrl: imageUrl');
  });
  it('keeps unusual URL spelling alongside a valid rendered destination', () => {
    const url = 'https://example.test/a b\\c<d>\t';
    const parsed = parseMarkdown(renderUrl(url));
    expect(parsed.links).toEqual([{ text: url, href: 'https://example.test/a%20b%5Cc%3Cd%3E%09' }]);
    expect(parsed.text).toBe(`${url} ${url}`);
    const image = parseMarkdown(renderUrl(url, true));
    expect(image.images).toEqual([
      { text: 'imageUrl', src: 'https://example.test/a%20b%5Cc%3Cd%3E%09' },
    ]);
    expect(image.text).toBe(`imageUrl ${url}`);
  });
  it.each(['\0', '\ud800', '\udfff'])('fails rather than replacing malformed text %j', (text) => {
    const error = expect.objectContaining({
      code: JsonRpcErrorCode.SerializationError,
      data: expect.objectContaining({ retryable: false }),
    });
    expect(() => encodeText(text)).toThrow(error);
    expect(() => formatResult({ outer: [{ [text]: 'nested' }] })).toThrow(error);
    expect(() => formatResult({ outer: [{ nested: text }] })).toThrow(error);
    expect(() => renderUrl(`https://example.test/${text}`)).toThrow(error);
  });
});
