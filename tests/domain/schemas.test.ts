/**
 * @fileoverview Source-independent input and lossless value schema tests.
 * @module tests/domain/schemas.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  normalizeBillCode,
  normalizeDate,
  normalizeSession,
  PERSON_ID,
} from '@/domain/normalization.js';
import {
  BilingualTextSchema,
  COUNT_CEILING,
  JsonRecordSchema,
  JsonValueSchema,
  LIST_CAP,
  LimitSchema,
  OffsetSchema,
  OptionalStringSchema,
  PaginationSchema,
  SessionInputSchema,
  SourceNameSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import { getBillTool } from '@/mcp-server/tools/definitions/get-bill.tool.js';
import { getMemberTool } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { getVoteTool } from '@/mcp-server/tools/definitions/get-vote.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchBillsTool } from '@/mcp-server/tools/definitions/search-bills.tool.js';
import { searchSpeechesTool } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { searchVotesTool } from '@/mcp-server/tools/definitions/search-votes.tool.js';
import { cpu } from '../fixtures/cpu-timing.js';

describe('shared schemas', () => {
  it.each([undefined, '', ' \t\r\n '])('treats blank optional input %j as absent', (input) => {
    expect(OptionalStringSchema.parse(input)).toBeUndefined();
    expect(SessionInputSchema.parse(input)).toBeUndefined();
  });
  it('trims optional text without changing its content', () => {
    expect(OptionalStringSchema.parse('  é [literal]  ')).toBe('é [literal]');
    expect(OptionalStringSchema.safeParse(null).success).toBe(false);
  });
  it('accepts both session forms and strict nested numbers', () => {
    expect(SessionInputSchema.parse(' 045-01 ')).toBe('045-01');
    expect(SessionInputSchema.parse({ parliament: 45, session: 1 })).toEqual({
      parliament: 45,
      session: 1,
    });
    for (const input of [
      { parliament: 45, session: 1, unknown: true },
      { parliament: 0, session: 1 },
      { parliament: '45', session: 1 },
      { parliament: 45, session: 1.5 },
    ]) {
      expect(SessionInputSchema.safeParse(input).success).toBe(false);
    }
  });
  it('enforces list defaults and inclusive boundaries', () => {
    expect(LimitSchema.parse(undefined)).toBe(25);
    expect(OffsetSchema.parse(undefined)).toBe(0);
    for (const value of [1, 100, 101, 10_000]) expect(LimitSchema.parse(value)).toBe(value);
    for (const value of [0, 10_001, 1.5, '25', null])
      expect(LimitSchema.safeParse(value).success).toBe(false);
    for (const value of [-1, 0.5, '0', null])
      expect(OffsetSchema.safeParse(value).success).toBe(false);
    expect(OffsetSchema.parse(999)).toBe(999);
  });
  it('advertises the shared count ceiling above the list cap', () => {
    expect([LIST_CAP, COUNT_CEILING]).toEqual([100, 10_000]);
    expect(z.toJSONSchema(LimitSchema)).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: COUNT_CEILING,
      default: 25,
      description: `Maximum returned rows, 1–${LIST_CAP} per call; larger values up to ${COUNT_CEILING} return ${LIST_CAP} rows with a notice.`,
    });
  });
  it('retains nested unknown fields, arrays, nulls, and untranslated text', () => {
    const record = {
      unknown: { records: [{ count: 0, flag: false, nil: null, text: '\r\n' }, []] },
      empty: {},
      'odd[key]': 'é',
    };
    expect(JsonRecordSchema.parse(record)).toEqual(record);
    expect(JsonValueSchema.parse([record, null])).toEqual([record, null]);
    expect(BilingualTextSchema.parse({ en: null, fr: 'texte' })).toEqual({ en: null, fr: 'texte' });
    expect(BilingualTextSchema.safeParse({ fr: 'texte' }).success).toBe(false);
    expect(BilingualTextSchema.safeParse({ en: null, fr: null, extra: '' }).success).toBe(false);
    for (const input of [undefined, Number.NaN, Infinity, 1n, { field: undefined }])
      expect(JsonValueSchema.safeParse(input).success).toBe(false);
  });
  it('validates source identity and HTTPS provenance without dropping fields', () => {
    for (const source of ['legisinfo', 'ourcommons', 'openparliament'])
      expect(SourceNameSchema.parse(source)).toBe(source);
    const provenance = {
      source: 'legisinfo',
      url: 'https://www.parl.ca/legisinfo/en/bills/json',
      retrievedAt: '2026-10-20T12:00:00Z',
      cached: true,
    };
    expect(SourceSchema.parse(provenance)).toEqual(provenance);
    for (const change of [
      { source: 'guessed' },
      { url: 'http://example.test' },
      { cached: 'true' },
      { extra: 1 },
    ])
      expect(SourceSchema.safeParse({ ...provenance, ...change }).success).toBe(false);
    const page = { offset: 100, limit: 25, nextOffset: null, hasMore: false };
    expect(PaginationSchema.parse(page)).toEqual(page);
    expect(PaginationSchema.safeParse({ ...page, nextOffset: -1 }).success).toBe(false);
    expect(PaginationSchema.safeParse({ ...page, extra: true }).success).toBe(false);
  });
});

/** A tool input field: its tool and the property path to it. */
type Field = readonly [tool: { name: string; input: z.ZodType }, path: readonly string[]];
interface SchemaNode {
  anyOf?: SchemaNode[];
  pattern?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  type?: string;
}
/** The node `tools/list` advertises for a field, as the input JSON Schema emits it. */
function advertised([tool, path]: Field): SchemaNode {
  let node = z.toJSONSchema(tool.input, { io: 'input' }) as SchemaNode;
  for (const key of path) node = node.properties?.[key] as SchemaNode;
  return node;
}
/** The pattern a field's string form advertises; a union field's string branch carries it. */
function patternOf(field: Field): string | undefined {
  const node = advertised(field);
  return (node.anyOf?.find((branch) => branch.type === 'string') ?? node).pattern;
}
/** The schema the server parses a field with. */
function parserOf([tool, path]: Field): z.ZodType {
  let schema = tool.input;
  for (const key of path) {
    const object = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
    schema = (object as z.ZodObject).shape[key] as z.ZodType;
  }
  return schema;
}

/** Text from code points, so spaces and dashes read unambiguously in source. */
const cp = (...points: number[]) => String.fromCodePoint(...points);
const optional = (core: string) => `^\\s*(?:${core}\\s*)?$`;
const required = (core: string) => `^\\s*${core}\\s*$`;
const DATE = '[0-9]{4}-[0-9]{2}-[0-9]{2}';
const SESSION = '[0-9]+-[0-9]+';
const BILL =
  '(?:[Bb][Ii][Ll][Ll]\\s+)?[CcSs][-\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000\\u2010-\\u2015\\u2212]?[1-9][0-9]*[A-Za-z]?';
const SECTIONS = [
  'sponsor',
  'stages.house',
  'stages.senate',
  'stages.royalAssent',
  'divisions',
  'senateVoteDetails',
  'publications',
  'statute',
  'summary.en',
  'summary.fr',
  'notes.en',
  'notes.fr',
  'milestones',
  'webReferences',
];
const SECTION =
  '(?:sponsor|stages\\.house|stages\\.senate|stages\\.royalAssent|divisions|senateVoteDetails|publications|statute|summary\\.en|summary\\.fr|notes\\.en|notes\\.fr|milestones|webReferences)';

/** Whether `normalize` returns for `value` rather than throwing. */
const settles = (normalize: (value: string) => unknown) => (value: string) => {
  try {
    normalize(value);
    return true;
  } catch {
    return false;
  }
};
/** An optional field's handler pipeline: trimmed, a blank is unset, anything else meets `test`. */
const blankOr = (test: (trimmed: string) => boolean) => (value: string) => {
  const trimmed = value.trim();
  return trimmed === '' || test(trimmed);
};
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** A date shape naming no Gregorian day: year 0000, month outside 1–12, or day past its month. */
function impossibleDay(value: string): boolean {
  const [year, month, day] = value.trim().split('-').map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : (DAYS[month - 1] ?? 0);
  return year < 1 || day < 1 || day > days;
}
/** A session shape with a part that is zero or past the safe-integer range. */
const impossibleSession = (value: string) =>
  value
    .trim()
    .split('-')
    .map(Number)
    .some((part) => !Number.isSafeInteger(part) || part < 1);

/** One advertised input format and every field that takes it. */
interface Format {
  /** Accepted, padded, and near-miss values. */
  examples: readonly string[];
  /** Message a value outside the pattern fails with; never the value. */
  expectation: string;
  fields: readonly Field[];
  /** Whether the field's handler pipeline, without the pattern, accepts a raw value. */
  handles: (value: string) => boolean;
  /** Values of an accepted shape that name nothing: the pattern admits them, the handler refuses. */
  impossible: readonly string[];
  pattern: string;
  /** One character as a lone value, as padding, and as each separator of an accepted value. */
  placements: (character: string) => string[];
  /** Whether a pattern-admitted value is one the handler refuses for its meaning, not its shape. */
  semantic: (value: string) => boolean;
  /** Multi-character pieces the fuzzer joins and splices. */
  tokens: readonly string[];
}
const pad = (value: string) => (c: string) => [c, c + c, c + value, value + c, c + value + c];
const FORMATS: Record<string, Format> = {
  date: {
    pattern: optional(DATE),
    expectation: 'Expected a real calendar date written YYYY-MM-DD.',
    fields: [
      [searchVotesTool, ['dateFrom']],
      [searchVotesTool, ['dateTo']],
      [searchSpeechesTool, ['dateFrom']],
      [searchSpeechesTool, ['dateTo']],
    ],
    handles: blankOr(settles(normalizeDate)),
    semantic: impossibleDay,
    placements: (c) => [...pad('2025-06-19')(c), `2025${c}06-19`, `2025-06${c}19`],
    examples: [' 2024-02-29 ', `${cp(0xa0)}2025-06-19${cp(0x3000)}`, '2025-6-19', '20250619'],
    impossible: ['2025-02-30', '0000-01-01', '2025-13-01', '2025-06-00'],
    tokens: ['2025', '06', '19', '-', '0000', '02-30', '2025-06-19'],
  },
  personId: {
    pattern: optional('[0-9]+'),
    expectation:
      'Expected a decimal official person ID, as in a canparl_search_members detailLookup or a canparl_get_vote ballot row.',
    fields: [
      [getMemberTool, ['personId']],
      [getVoteTool, ['personId']],
    ],
    handles: blankOr((trimmed) => PERSON_ID.test(trimmed)),
    semantic: () => false,
    placements: (c) => [...pad('58733')(c), `58${c}733`],
    examples: [' 58733 ', '007', '0', '58 733', '-41', '28.97'],
    impossible: [],
    tokens: ['58733', '0', '9', '-'],
  },
  session: {
    pattern: optional(SESSION),
    expectation:
      'Expected a parliament-session token such as 45-1, with positive parliament and session numbers.',
    fields: [
      [searchBillsTool, ['session']],
      [getBillTool, ['session']],
      [searchVotesTool, ['session']],
      [getVoteTool, ['session']],
      [listReferenceTool, ['session']],
      [getMemberTool, ['votesSession']],
    ],
    handles: blankOr(settles(normalizeSession)),
    semantic: impossibleSession,
    placements: (c) => [...pad('45-1')(c), `45${c}1`],
    examples: [' 045-01 ', '45/1', '45-1-2', '-1-1'],
    impossible: ['45-0', '0-1', '9007199254740992-1'],
    tokens: ['45', '1', '0', '-', '45-1'],
  },
  scopeSession: {
    pattern: required(SESSION),
    expectation:
      'Expected a parliament-session token such as 45-1, with positive parliament and session numbers.',
    fields: [
      [searchSpeechesTool, ['billDebated', 'session']],
      [searchSpeechesTool, ['mentionedBill', 'session']],
    ],
    handles: settles(normalizeSession),
    semantic: impossibleSession,
    placements: (c) => [...pad('45-1')(c), `45${c}1`],
    examples: [' 45-1 ', '', '   ', '45/1'],
    impossible: ['45-0', '0-1', '9007199254740992-1'],
    tokens: ['45', '1', '0', '-', '45-1'],
  },
  billCode: {
    pattern: optional(BILL),
    expectation:
      'Expected a House or Senate bill code such as C-15, C-15A, or S-1001: C or S, an optional single dash or space, a number without leading zeros, then an optional suffix letter.',
    fields: [
      [searchBillsTool, ['billCode']],
      [searchVotesTool, ['billCode']],
      [getMemberTool, ['votesBillCode']],
    ],
    handles: blankOr(settles(normalizeBillCode)),
    semantic: () => false,
    placements: (c) => [
      ...pad('C-15A')(c),
      `bill C-15${c}`,
      `C${c}15A`,
      `bill${c}C-15`,
      `C-1${c}5`,
      `S${c}1001`,
    ],
    examples: [
      ` bill c${cp(0x2013)}15a `,
      'Bill\nC-15',
      `C${cp(0x3000)}15`,
      'C-015',
      'K-15',
      `${cp(0x212a)}-15`,
    ],
    impossible: [],
    tokens: ['bill', 'BILL', 'C', 's', '15', '15a', '1001', '-', cp(0x2013), ' '],
  },
  requiredBillCode: {
    pattern: required(BILL),
    expectation:
      'Expected a House or Senate bill code such as C-15, C-15A, or S-1001: C or S, an optional single dash or space, a number without leading zeros, then an optional suffix letter.',
    fields: [
      [getBillTool, ['billCode']],
      [searchSpeechesTool, ['billDebated', 'code']],
      [searchSpeechesTool, ['mentionedBill', 'code']],
    ],
    handles: settles(normalizeBillCode),
    semantic: () => false,
    placements: (c) => [
      ...pad('C-15A')(c),
      `bill C-15${c}`,
      `C${c}15A`,
      `bill${c}C-15`,
      `C-1${c}5`,
      `S${c}1001`,
    ],
    examples: [` bill c${cp(0x2013)}15a `, 'Bill\nC-15', '', '   ', 'C-0', 'C-15AB'],
    impossible: [],
    tokens: ['bill', 'BILL', 'C', 's', '15', '15a', '1001', '-', cp(0x2013), ' '],
  },
  section: {
    pattern: optional(SECTION),
    expectation: `Unknown section. Available sections: ${SECTIONS.join(', ')}.`,
    fields: [[getBillTool, ['section']]],
    handles: blankOr((trimmed) => SECTIONS.includes(trimmed)),
    semantic: () => false,
    placements: (c) => [
      ...pad('stages.house')(c),
      `sponsor${c}`,
      `stages${c}house`,
      `summary${c}en`,
    ],
    examples: [' sponsor ', '', 'Sponsor', 'summary', 'notes.de', 'stages.house.', 'stagesxhouse'],
    impossible: [],
    tokens: [...SECTIONS, 'stages', 'summary', 'notes', '.', 'en'],
  },
};
/** Every code point `String.prototype.trim` removes; JavaScript `\s` matches exactly these. */
const TRIMMED = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
/** Code points next to the formats: other spaces, dashes, look-alike letters, and other digits. */
const NEAR = [
  0x180e, 0x200b, 0x1c, 0x85, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe63,
  0xff0d, 0x212a, 0x17f, 0x662, 0xff15, 0xe9,
];
const ALPHABET = [
  ...[...TRIMMED, ...NEAR].map((point) => cp(point)),
  ...'-._0123456789BbIiLlCcSsAaZzx',
];
/** Every BMP code point except the surrogates, which no JSON string carries alone. */
function* codePoints(): Generator<string> {
  for (let point = 0; point <= 0xffff; point++)
    if (point < 0xd800 || point > 0xdfff) yield String.fromCharCode(point);
}
/** Seeded strings: spliced examples and token runs over {@link ALPHABET}. */
function* fuzz(format: Format, count: number): Generator<string> {
  let state = 0x2326;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  const sources = [...format.examples, ...format.tokens];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      let value = pick(sources);
      for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--) {
        const at = Math.floor(random() * (value.length + 1));
        const choice = random();
        const piece = random() < 0.8 ? pick(ALPHABET) : pick(format.tokens);
        value =
          choice < 0.4
            ? value.slice(0, at) + piece + value.slice(at)
            : choice < 0.8
              ? value.slice(0, at) + piece + value.slice(at + 1)
              : value.slice(0, at) + value.slice(at + 1);
      }
      yield value;
    } else {
      let value = '';
      for (let pieces = 1 + Math.floor(random() * 6); pieces > 0; pieces--)
        value += random() < 0.5 ? pick(ALPHABET) : pick(format.tokens);
      yield value;
    }
  }
}

describe('advertised input formats', () => {
  it.each(Object.entries(FORMATS))(
    'advertises the %s format on every field that takes it',
    (_, format) => {
      for (const field of format.fields)
        expect(patternOf(field), `${field[0].name} ${field[1].join('.')}`).toBe(format.pattern);
    },
  );
  it.each(Object.entries(FORMATS))(
    'refuses a %s value outside its pattern with the expectation alone',
    (_, format) => {
      const value = 'not-a-value #';
      for (const field of format.fields) {
        const result = parserOf(field).safeParse(value);
        expect(result.success).toBe(false);
        expect(result.error?.issues.map((issue) => issue.message)).toEqual([format.expectation]);
      }
    },
  );
  it('requires both parts of each bill scope and keeps the numbers form', () => {
    for (const scope of ['billDebated', 'mentionedBill']) {
      const node = advertised([searchSpeechesTool, [scope]]);
      expect(node.required).toEqual(['session', 'code']);
      expect(node.properties?.session?.anyOf?.find((branch) => branch.type === 'object')).toEqual(
        expect.objectContaining({ required: ['parliament', 'session'] }),
      );
      expect(
        parserOf([searchSpeechesTool, [scope, 'session']]).safeParse({ parliament: 45, session: 1 })
          .success,
      ).toBe(true);
    }
  });
  it.each<Field>([
    [searchBillsTool, ['sponsor']],
    [getMemberTool, ['slug']],
    [searchSpeechesTool, ['politician']],
  ])('leaves %s slug input unpatterned', (...field) => {
    expect(advertised(field)).toMatchObject({ type: 'string' });
    expect(patternOf(field)).toBeUndefined();
  });
});

/**
 * Every BMP code point as a lone value, as padding, and as each separator of an accepted value, plus
 * seeded fuzz, through the client pattern (with and without the `u` flag), the server's parse, and
 * the handler pipeline the pattern fronts.
 */
describe('advertised input format coverage', { timeout: 0 }, () => {
  it.each(Object.entries(FORMATS))(
    'admits every %s value its handler accepts, refusing others only for their meaning',
    (_, format) => {
      const field = format.fields[0] as Field;
      const pattern = patternOf(field) ?? '(?!)';
      const client = new RegExp(pattern);
      const unicode = new RegExp(pattern, 'u');
      const parser = parserOf(field);
      const narrowed: string[] = [];
      const disagreements: string[] = [];
      const unsemantic: string[] = [];
      const check = (value: string) => {
        const admitted = client.test(value);
        if (unicode.test(value) !== admitted || parser.safeParse(value).success !== admitted)
          disagreements.push(value);
        const handled = format.handles(value);
        if (handled && !admitted) narrowed.push(value);
        if (admitted && !handled && !format.semantic(value)) unsemantic.push(value);
      };
      const stackTraceLimit = Error.stackTraceLimit;
      // Refusals throw; their stacks are never read here.
      Error.stackTraceLimit = 0;
      try {
        for (const value of [...format.examples, ...format.impossible]) check(value);
        for (const c of codePoints()) for (const value of format.placements(c)) check(value);
        for (const value of fuzz(format, 20_000)) check(value);
      } finally {
        Error.stackTraceLimit = stackTraceLimit;
      }
      const sample = (values: string[]) =>
        values.slice(0, 10).map((value) => JSON.stringify(value));
      expect({
        narrowed: sample(narrowed),
        disagreements: sample(disagreements),
        unsemantic: sample(unsemantic),
      }).toEqual({ narrowed: [], disagreements: [], unsemantic: [] });
      // Impossible values pass the pattern, so the handler's own reason still reports them.
      for (const value of format.impossible) {
        expect(client.test(value), value).toBe(true);
        expect(format.handles(value), value).toBe(false);
      }
    },
  );
});

/** Sizes from 3,125 to 200,000 characters, doubling: a 64× span. */
const sizes = [3_125, 6_250, 12_500, 25_000, 50_000, 100_000, 200_000];
/**
 * Each format decides input in time linear in its length on the client pattern (with and without
 * the `u` flag) and the server's parse: both line-break shapes the timing suites share, then near
 * misses of the format's own accepted value.
 */
describe('advertised input format timing', { timeout: 0 }, () => {
  const accepted: Record<string, string> = {
    date: '2025-06-19',
    personId: '58733',
    session: '45-1',
    scopeSession: '45-1',
    billCode: 'bill C-15A',
    requiredBillCode: 'bill C-15A',
    section: 'stages.house',
  };
  it.each(Object.entries(FORMATS))(
    'decides %s input of every size in time linear in its length',
    (name, format) => {
      const value = accepted[name] as string;
      const builds: ((n: number) => string)[] = [
        (n) => `${'§1 x'.repeat(n / 4)}\ny`,
        (n) => '  \r\n'.repeat(n / 4),
        (n) => `${' '.repeat(n)}x`,
        (n) => `${value}${' '.repeat(n)}x`,
        (n) => `${' '.repeat(n / 2)}${value}${' '.repeat(n / 2)}x`,
        (n) => `${value.slice(0, -1)}${'1'.repeat(n)}!`,
      ];
      const pattern = patternOf(format.fields[0] as Field) ?? '';
      const client = new RegExp(pattern);
      const unicode = new RegExp(pattern, 'u');
      const parser = parserOf(format.fields[0] as Field);
      const surfaces: ((input: string) => boolean)[] = [
        (input) => client.test(input),
        (input) => unicode.test(input),
        (input) => parser.safeParse(input).success,
      ];
      for (const [shape, build] of builds.entries())
        for (const [surface, admits] of surfaces.entries()) {
          const run = (input: string) => () => {
            admits(input);
          };
          cpu(run(build(sizes[0] as number)), 20);
          const perCall: number[] = [];
          for (const size of sizes) {
            const input = build(size);
            const label = `shape ${shape}, surface ${surface}, ${size} characters`;
            // Only a blank reaches an optional field's handler; every other input here is refused.
            expect(admits(input), label).toBe(format.pattern.endsWith('?$') && !input.trim());
            expect(cpu(run(input), 1), label).toBeLessThan(250_000);
            perCall.push(cpu(run(input), Math.max(1, (sizes.at(-1) as number) / size)));
          }
          expect(
            (perCall.at(-1) as number) / (perCall[0] as number),
            `shape ${shape}, surface ${surface}`,
          ).toBeLessThan(256);
        }
    },
  );
});
