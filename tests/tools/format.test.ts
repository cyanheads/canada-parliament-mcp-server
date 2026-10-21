/**
 * @fileoverview CommonMark parser assertions for recursive lossless result rendering.
 * @module tests/tools/format.test
 */
import { execFileSync } from 'node:child_process';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { type JsonRecord, JsonRecordSchema, JsonValueSchema } from '@/domain/schemas.js';
import {
  encodeText,
  formatResult,
  measuredTrailer,
  RESPONSE_BUDGET,
  renderUrl,
  renderValue,
  responseBytes,
} from '@/mcp-server/tools/definitions/_format.js';
import {
  decodeBun,
  decodeCommonMark,
  expectExact,
  standaloneBun,
  standaloneCommonMark,
  warmBun,
} from '../fixtures/markdown-decode.js';

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
const text = (value: JsonRecord) => formatResult(value)[0]?.text ?? '';
/** Both parsers rebuild the rendered record exactly; returns the Bun decode for link checks. */
function roundTrip(value: JsonRecord, markdown = text(value)) {
  const bun = decodeBun(markdown);
  const reference = decodeCommonMark(markdown);
  expectExact(bun.value, value);
  expectExact(reference.value, value);
  expect(reference.links).toEqual(bun.links);
  expect(reference.images).toEqual(bun.images);
  return bun;
}

/**
 * Every construct that could open a block, start an inline, or lose whitespace. Each is also used
 * mid-line and glued to text below, and as a key, a value, and a standalone string.
 */
const adversarial = [
  ...['', ' plain text ', '\tleading\ttrailing\t', 'one\rtwo', 'one\ntwo', 'one\r\ntwo'],
  ...['\r\n\n\r', '# heading', '## h', '#hashtag', '> quote', '>quote', '- item', '-item'],
  ...['+ item', '* item', '*item*', '1. item', '1) item', '1.', '123456789. x', '1234567890. x'],
  ...['=', '===', '---', '***', '___', '- - -', '| a | b |', '|---|---|', '```js', '~~~', '````'],
  ...['`code`', 'a `b` c', 'a ``b`` c', '*em*', '**strong**', '_em_', '__strong__'],
  ...[
    'snake_case_name',
    'a*b*c',
    '~~strike~~',
    '~one~',
    'a~b~c',
    '[x](y)',
    '[x](https://evil.test)',
  ],
  ...['![img](https://evil.test/a.png)', '![i](y)', '[x]: https://evil.test', '[x]: y', '[x]'],
  ...['[^1]', '[ ] task', '- [x] done', 'a ] b', 'a [ b', '<tag>', '<script>alert(1)</script>'],
  ...['<https://evil.test>', '<a@b.c>', 'a < b > c', '<!-- c -->', '<div>', 'x <b>y</b>'],
  ...['&amp;', '&#32;', '&#x41;', '&copy;', 'R&D', 'AT&T;', '&', '&#;', 'trailing\\', '\\'],
  ...[
    'a\\b',
    '\\*not em\\*',
    'a\\\nb',
    '  two leading',
    'two trailing  ',
    'internal    run   of spaces',
  ],
  ...['tab\tinside', '\u{a0}nbsp lead', 'nbsp trail\u{a0}', 'in\u{a0}side', '\u000bvt', 'vt\u000b'],
  ...['\u000cff', 'ff\u000c', 'in\u000bside\u000cx', 'é e\u{301} 😀 \u{2028} \u{2029} \u{3000}'],
  ...[
    'www.example.com and https://example.com',
    'mail a@b.ca',
    '$x$',
    '[[Wiki]]',
    '    indented code',
  ],
  ...[
    '\tindented tab',
    'Mr. Speaker, I think the answer is “yes”—and it’s 100% clear (see s. 3(1)(a)).',
  ],
  ...['!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', '"double" and \'single\' &amp; &#10; &#x0A;'],
  ...[
    '```json\n{"x": 1}\n```',
    '# heading\n> forged quote\n\n![fake](https://evil.test) <script>x</script>',
  ],
  ...[
    '200',
    '-1.5e+3',
    '007',
    'true',
    'false',
    'null',
    '[]',
    '{}',
    '[array]',
    '[object]',
    '"quoted"',
  ],
  ...['a: b', 'a:', ':', ': lead', 'key:\u{a0}x', '"', 'https:// not a link'],
];
const forms = adversarial.flatMap((value) => [value, `x ${value} y`, `x${value}y`]);
const asKey = (value: string): JsonRecord => ({ [value]: 'x' });
const asValue = (value: string): JsonRecord => ({ k: value });
warmBun(forms.flatMap((value) => [encodeText(value), text(asKey(value)), text(asValue(value))]));

describe('lossless CommonMark formatting', () => {
  it.each(forms)('round-trips %j as a standalone string, a key, and a value', (value) => {
    expect(standaloneBun(encodeText(value))).toBe(value);
    expect(standaloneCommonMark(encodeText(value))).toBe(value);
    const key = roundTrip(asKey(value));
    expect([...key.links, ...key.images]).toEqual([]);
    const field = roundTrip(asValue(value));
    expect(field.images).toEqual([]);
    expect(field.links.map((link) => link.text)).toEqual(
      value.startsWith('https://') ? [value] : [],
    );
  });
  it.each([
    [
      'Mr. Speaker, I think it’s 100% clear (see s. 3(1)(a)).',
      'Mr. Speaker, I think it’s 100% clear (see s. 3(1)(a)).',
    ],
    ['internal    run\tof spaces', 'internal    run\tof spaces'],
    ['# heading', '\\# heading'],
    ['1. item', '1\\. item'],
    ['12) item', '12\\) item'],
    [
      'snake_case * ~x~ `c` [l] <b> R&D \\',
      'snake\\_case \\* \\~x\\~ \\`c\\` \\[l\\] \\<b> R\\&D \\\\',
    ],
    [' edge\t', '&#32;edge&#9;'],
    ['a\r\nb', 'a&#13;&#10;b'],
    ['\u{a0}x\u000c', '&#160;x&#12;'],
    ['\u{3000}\u{2028}', '&#12288;&#8232;'],
  ])('escapes only what CommonMark would alter %j', (value, encoded) => {
    expect(encodeText(value)).toBe(encoded);
  });
  it('nests containers one blockquote level deeper with hard-break siblings', () => {
    const outer = { a: { b: 1 }, c: 2 };
    const inner = { a: { b: 1, c: 2 } };
    expect(text(outer)).toBe('> a: [object]\n>> b: 1\n>\n> c: 2');
    expect(text(inner)).toBe('> a: [object]\n>> b: 1\\\n>> c: 2');
    roundTrip(outer);
    roundTrip(inner);
  });
  it('recovers scalar types from JSON string literals', () => {
    const record = {
      numberText: '200',
      number: 200,
      exponentText: '1E5',
      exponent: 1e21,
      fraction: -0.25,
      nullText: 'null',
      null: null,
      trueText: 'true',
      true: true,
      falseText: 'false',
      false: false,
      emptyArrayText: '[]',
      emptyArray: [],
      emptyObjectText: '{}',
      emptyObject: {},
      arrayMarker: '[array]',
      objectMarker: '[object]',
      quoted: '"200" said',
      notNumbers: ['007', '+1', '1.', '.5', ' 200', '0x10', 'Infinity', 'NaN', '-'],
      'key: with separator': 'v',
      '"quoted key': 'v',
      'trailing colon:': '',
      '': 'empty key',
      decisions: [{ DecisionSittingNumber: '200', EventTypeId: 200 }],
    } as JsonRecord;
    Object.defineProperty(record, '__proto__', {
      value: 'own key',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    roundTrip(record);
    expect(text({ n: '200', m: 200, s: '"x' })).toBe('> n: "200"\\\n> m: 200\\\n> s: "\\\\"x"');
    expect(text({ 'a: b': 1, a: 'b: c' })).toBe('> \\"a: b": 1\\\n> a: b: c');
  });
  it('guards block starts on keys, which open lines, and not on values, which follow them', () => {
    expect(text({ '# k': '# not a heading', '1. k': '1. not a list', '-': '- x' })).toBe(
      '> \\# k: # not a heading\\\n> 1\\. k: 1. not a list\\\n> \\-: - x',
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
          emptyText: '',
        },
        ['deep', { 'last>key': ' last ', deeper: [[{ leaf: '\nleading break' }]] }],
      ],
      emptyArray: [],
      emptyObject: {},
      after: 'sibling after a nested close',
    };
    const structured = JsonRecordSchema.parse(record);
    const blocks = formatResult(structured);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    roundTrip(record, blocks[0]?.text);
    expect(structured).toEqual(record);
  });
  it('renders an empty result and a bare scalar field', () => {
    expect(text({})).toBe('');
    roundTrip({});
    expect(renderValue('', 'source')).toBe('> source:');
    expect(renderValue('a b', 'source')).toBe('> source: a b');
    expect(decodeBun(renderValue({ a: [1, 'x'] }, 'appliedFilters')).value).toStrictEqual({
      appliedFilters: { a: [1, 'x'] },
    });
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
  it('decodes link and image values between hard-break siblings', () => {
    const unusual = 'https://example.test/a b]c';
    const decoded = roundTrip({
      url: 'https://example.test/p?a=1&b=2',
      next: 'after link',
      nested: { photoUrl: 'https://images.example.test/p.png', profile: unusual, last: 1 },
    });
    expect(decoded.links).toEqual([
      { text: 'https://example.test/p?a=1&b=2', href: 'https://example.test/p?a=1&b=2' },
      { text: unusual, href: 'https://example.test/a%20b%5Dc' },
    ]);
    expect(decoded.images).toEqual([
      { text: 'imageUrl', src: 'https://images.example.test/p.png' },
    ]);
  });
  it.each(['\0', '\ud800', '\udfff'])('fails rather than replacing malformed text %j', (text) => {
    const error = expect.objectContaining({
      code: JsonRpcErrorCode.SerializationError,
      data: expect.objectContaining({ retryable: false }),
    });
    expect(() => encodeText(text)).toThrow(error);
    expect(() => formatResult({ outer: [{ [text]: 'nested' }] })).toThrow(error);
    expect(() => formatResult({ outer: [{ nested: text }] })).toThrow(error);
    expect(() => formatResult({ outer: [{ [`"${text}`]: 'quoted key' }] })).toThrow(error);
    expect(() => formatResult({ outer: [{ nested: `"${text}` }] })).toThrow(error);
    expect(() => renderUrl(`https://example.test/${text}`)).toThrow(error);
  });
});

describe('complete-response byte budget', () => {
  const enrichment = {
    appliedFilters: z
      .object({ session: z.string().describe('S.'), code: z.string().nullable().describe('C.') })
      .describe('Filters.'),
    shown: z.number().int().describe('Shown.'),
    truncated: z.boolean().describe('Truncated.'),
    ratio: z.number().nullable().optional().describe('Ratio.'),
    notice: z.string().optional().describe('Notice.'),
  };
  const output = z.object({
    items: z.array(JsonValueSchema).describe('Items.'),
    meta: JsonRecordSchema.describe('Meta.'),
    note: z.string().nullable().describe('Note.'),
  });
  type Case = { body: z.infer<typeof output>; enrichment: JsonRecord };
  const cases: Case[] = [
    {
      body: { items: [], meta: {}, note: null },
      enrichment: { appliedFilters: { session: '45-1', code: null }, shown: 0, truncated: false },
    },
    {
      body: {
        items: [{ a: { b: [1, '2', { c: null }] }, d: 'x' }, ['deep', []], 'tail'],
        meta: { 'odd: key': ' é\r\n中文 *[x]* ', url: 'https://example.test/a b', n: -1.5e3 },
        note: '# not a heading\n``` fence',
      },
      enrichment: {
        appliedFilters: { session: '45-1', code: 'C-15A' },
        shown: 3,
        truncated: true,
        ratio: 0.25,
        notice:
          'limit 401 exceeds the per-call maximum of 400; returned up to 400. A "quoted" & <b>.',
      },
    },
    {
      body: {
        items: Array.from({ length: 40 }, (_, n) => ({ n, text: 'é & '.repeat(n) })),
        meta: { flag: true },
        note: '',
      },
      enrichment: {
        appliedFilters: { session: '9-9', code: '' },
        shown: 40,
        truncated: false,
        ratio: null,
        notice: '',
      },
    },
  ];
  const probe = (trailer: boolean) =>
    tool('probe_measure', {
      description: 'Return a fixed body and enrichment for the response measure.',
      input: z.object({ index: z.number().int().describe('Case index.') }),
      output,
      enrichment,
      ...(trailer ? { enrichmentTrailer: measuredTrailer(enrichment) } : {}),
      handler(input, ctx) {
        const selected = cases[input.index] as Case;
        ctx.enrich(selected.enrichment);
        return selected.body;
      },
      format: (result) => formatResult(JsonRecordSchema.parse(result)),
    });
  const wire = (result: unknown) =>
    Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(256), result }), 'utf8');
  it('pins the shared budget at 24000 bytes', () => {
    expect(RESPONSE_BUDGET).toBe(24_000);
  });
  it.each(cases.map((_, index) => index))(
    'measures case %i exactly as the framework serializes it with every field trailer-rendered',
    async (index) => {
      const result = await runToolContract(probe(true), { index });
      expect(result.isError).not.toBe(true);
      const selected = cases[index] as Case;
      expect(responseBytes(selected.body, selected.enrichment)).toBe(wire(result));
    },
  );
  it('differs from the wire when the framework renders enrichment by its own kinds', async () => {
    const result = await runToolContract(probe(false), { index: 1 });
    const selected = cases[1] as Case;
    expect(responseBytes(selected.body, selected.enrichment)).not.toBe(wire(result));
  });
});

/**
 * Cases run synchronously, so a wall-clock timeout cannot stop one early; it only fails a loaded
 * host after the thread-CPU assertions passed. Timeout 0 leaves those assertions as the only bound.
 */
describe('encoder timing', { timeout: 0 }, () => {
  const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  /** Thread CPU microseconds per call, best of three, with equal total work at every size. */
  function cpu(run: () => void, reps: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (let trial = 0; trial < 3; trial++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) run();
      const used = process.threadCpuUsage(start);
      best = Math.min(best, (used.user + used.system) / reps);
    }
    return best;
  }
  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['leading digit run without a marker', (n: number) => '1'.repeat(n)],
    ['number near-miss', (n: number) => `1.${'1'.repeat(n)}e+`],
    [
      'edge whitespace around one character',
      (n: number) => `${' '.repeat(n / 2)}x${' '.repeat(n / 2)}`,
    ],
    ['escapes throughout', (n: number) => '*_[<&\\'.repeat(n / 6)],
  ])('stays linear on %s', (_shape, build) => {
    const run = (input: string) => () => {
      encodeText(input);
      formatResult({ [input]: input });
    };
    cpu(run(build(sizes[0] as number)), 20);
    const perCall: number[] = [];
    for (const size of sizes) {
      const input = build(size);
      const single = cpu(run(input), 1);
      expect(single, `${size} characters`).toBeLessThan(250_000);
      perCall.push(cpu(run(input), Math.max(1, (sizes.at(-1) as number) / size)));
    }
    expect((perCall.at(-1) as number) / (perCall[0] as number)).toBeLessThan(256);
  });
});
