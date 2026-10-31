/**
 * @fileoverview Exact parliamentary identifier and vocabulary normalization tests.
 * @module tests/domain/normalization.test
 */
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  assertRepresentableText,
  clampCount,
  filterFailure,
  includesText,
  normalizeBillCode,
  normalizeChamber,
  normalizeDate,
  normalizeFilter,
  normalizeProvince,
  normalizeSession,
  normalizeSlug,
  normalizeText,
  normalizeVocabulary,
  PROVINCES,
  paginate,
  rejectFilter,
  stripAccents,
  validateDateRange,
  vocabularyKey,
} from '@/domain/normalization.js';
import {
  BALLOTS,
  BILL_STATUSES,
  BILL_TYPES,
  extendVocabulary,
  OFFICIAL_BALLOT_ALIASES,
  OFFICIAL_PARTY_ALIASES,
  PARTIES,
  VOTE_DOCUMENT_TYPES,
  VOTE_RESULT_ALIASES,
  VOTE_RESULTS,
} from '@/domain/reference-catalog.js';
import { expectLinearCpu } from '../fixtures/cpu-timing.js';

/** The McpError a synchronous call throws; fails the test when nothing is thrown. */
function rejection(run: () => unknown): McpError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    return error as McpError;
  }
  throw new Error('Expected a rejection.');
}
const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(', ');
/** Text from code points, so combining marks read unambiguously in source. */
const cp = (...points: number[]) => String.fromCodePoint(...points);
const BILL_SHAPE =
  'Expected a House or Senate bill code such as C-15, C-15A, or S-1001: C or S, an optional single dash or space, a number without leading zeros, then an optional suffix letter.';
const SLUG_SHAPE =
  "Expected an OpenParliament politician slug of lowercase letters, digits, and single hyphens, its /politicians/ path, or its OpenParliament profile URL: member.slug from canparl_get_member, a slug from an includeFormer canparl_search_members row, or a current MP's official personId.";

describe('identifier normalization', () => {
  it.each(['45-1', ' 045-01 ', { parliament: 45, session: 1 }])(
    'canonicalizes session %j without inferring a current session',
    (input) => expect(normalizeSession(input)).toBe('45-1'),
  );
  it('leaves omitted sessions unresolved', () => {
    expect(normalizeSession(undefined)).toBeUndefined();
  });
  it.each(['0-1', '45-0', '-1-1', '45-1-2', '4e1-1', '9007199254740992-1'])(
    'rejects invalid session %s',
    (input) => expect(() => normalizeSession(input)).toThrow(),
  );
  it.each([
    ['bill s321', 'S-321'],
    [' c1 ', 'C-1'],
    ['S-99', 'S-99'],
  ])('normalizes bill %s', (input, expected) => expect(normalizeBillCode(input)).toBe(expected));
  it.each(['C-0', 'C-01', 'C--1', 'C-1 extra', 'X-1', 'C-1\nC-2'])(
    'rejects invalid bill %s',
    (input) => expect(() => normalizeBillCode(input)).toThrow(),
  );
  it.each([
    'C 15',
    'c 15',
    'C–15',
    'C‑15',
    'C‐15',
    'C—15',
    'C―15',
    'C−15',
    'C 15',
    'C 15',
    'Bill C 15',
    'bill c–15',
    ' BILL   C-15 ',
  ])('accepts one whitespace or dash separator in %j', (input) =>
    expect(normalizeBillCode(input)).toBe('C-15'),
  );
  it.each(['C - 15', 'C -15', 'C- 15', '15', 'C-015', 'C\n15', 'C\r\n15', 'C––15', 'C_15'])(
    'rejects %j, naming the expected shape without the value',
    (input) => {
      const error = rejection(() => normalizeBillCode(input));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(BILL_SHAPE);
      expect(error.data ?? {}).toEqual({});
    },
  );
  it.each([
    ['C-15A', 'C-15A'],
    ['c-15a', 'C-15A'],
    ['c15a', 'C-15A'],
    ['C 15A', 'C-15A'],
    ['Bill C–15B', 'C-15B'],
    [' bill c 333a ', 'C-333A'],
    ['C-10B', 'C-10B'],
    ['S-1001', 'S-1001'],
  ])('accepts split-bill suffix letter in %j', (input, expected) =>
    expect(normalizeBillCode(input)).toBe(expected),
  );
  it.each(['C-15AB', 'C-15A1', 'C-15 A', 'C-15-A', 'C-A', 'C-15Á', 'C-15K', 'ſ-15'])(
    'rejects split-bill near-miss %j, stating the optional suffix letter',
    (input) => {
      const error = rejection(() => normalizeBillCode(input));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(BILL_SHAPE);
    },
  );
  it('accepts exactly the bill codes whose separator is a Unicode space separator or a dash', () => {
    // The grammar stated with the Unicode property: any Zs space, the hyphen-minus, U+2010–U+2015, or U+2212.
    const grammar = /^(?:[Bb][Ii][Ll][Ll]\s+)?[CcSs][\p{Zs}\-‐-―−]?[1-9]\d*[A-Za-z]?$/u;
    const misses: string[] = [];
    for (let point = 0; point <= 0xffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const c = String.fromCharCode(point);
      for (const value of [`C${c}15`, `bill${c}C-15`, `S${c}1001A`, `${c}C-15${c}`]) {
        let accepted = true;
        try {
          normalizeBillCode(value);
        } catch {
          accepted = false;
        }
        if (accepted !== grammar.test(value.trim())) misses.push(JSON.stringify(value));
      }
    }
    expect(misses).toEqual([]);
  });
  it.each([
    'alex-example',
    '/politicians/alex-example/',
    'https://openparliament.ca/politicians/alex-example/',
    'https://api.openparliament.ca/politicians/alex-example/',
  ])('accepts exact politician reference %s', (input) =>
    expect(normalizeSlug(input)).toBe('alex-example'),
  );
  it.each(['5724', ' 5724 ', '/politicians/5724/', 'https://openparliament.ca/politicians/5724/'])(
    'accepts a numeric OpenParliament politician reference %j',
    (input) => expect(normalizeSlug(input)).toBe('5724'),
  );
  it.each([
    'Alex Example',
    'Alex-Example',
    'https://openparliament.ca.evil.test/politicians/alex-example/',
    'http://openparliament.ca/politicians/alex-example/',
    'https://user@openparliament.ca/politicians/alex-example/',
    'https://openparliament.ca/politicians/alex-example/?x=1',
    '/politicians/alex-example/extra/',
  ])('rejects noncanonical politician reference %s', (input) =>
    expect(() => normalizeSlug(input)).toThrow(),
  );
  it.each(['https://', 'https://[bad]/politicians/alex-example/', 'http:alex'])(
    'rejects an unparseable politician URL %j as a validation failure',
    (input) =>
      expect(rejection(() => normalizeSlug(input)).code).toBe(JsonRpcErrorCode.ValidationError),
  );
});

describe('field-named filter rejection', () => {
  it('passes absent and accepted values through unchanged', () => {
    expect(normalizeFilter('billCode', undefined, normalizeBillCode)).toBeUndefined();
    expect(normalizeFilter('billCode', 'c 15', normalizeBillCode)).toBe('C-15');
    expect(
      normalizeFilter('party', ' bloc ', (v) =>
        normalizeVocabulary(v, PARTIES, OFFICIAL_PARTY_ALIASES),
      ),
    ).toBe('Bloc Québécois');
    expect(
      normalizeFilter('result', 'FAILED', (v) =>
        normalizeVocabulary(v, VOTE_RESULTS, VOTE_RESULT_ALIASES),
      ),
    ).toBe('Negatived');
  });
  it.each([
    ['status', (v: string) => normalizeVocabulary(v, BILL_STATUSES), [...BILL_STATUSES]],
    [
      'party',
      (v: string) => normalizeVocabulary(v, PARTIES, OFFICIAL_PARTY_ALIASES),
      [...PARTIES, 'Bloc', 'Green'],
    ],
    [
      'result',
      (v: string) => normalizeVocabulary(v, VOTE_RESULTS, VOTE_RESULT_ALIASES),
      ['Agreed To', 'Negatived', 'Tie', 'Passed', 'Failed'],
    ],
    ['province', normalizeProvince, [...Object.values(PROVINCES), ...Object.keys(PROVINCES)]],
    ['originatingChamber', normalizeChamber, ['House', 'House of Commons', 'Senate']],
  ] as const)('names %s and every accepted value', (field, normalize, allowed) => {
    const error = rejection(() => normalizeFilter(field, 'zz-rejected-zz', normalize));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(`${field}: Expected one of ${quoted(allowed)}.`);
    expect(error.data).toEqual({ field, allowed });
    expect(error.cause).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { allowed },
    });
    expect(
      JSON.stringify([error.message, error.data, (error.cause as McpError).data]),
    ).not.toContain('zz-rejected');
  });
  it.each([
    ['billCode', 'Q-77777', normalizeBillCode, BILL_SHAPE],
    ['sponsor', 'Zz Rejected', normalizeSlug, SLUG_SHAPE],
    ['sponsor', 'https://zz.rejected.test/x', normalizeSlug, SLUG_SHAPE],
    ['dateFrom', '2026-02-30', normalizeDate, 'Expected a real calendar date written YYYY-MM-DD.'],
    [
      'billDebated.session',
      '45-0',
      normalizeSession,
      'Expected a parliament-session token such as 45-1, with positive parliament and session numbers.',
    ],
  ] as const)('names %s and its expected shape for %j', (field, rejected, normalize, shape) => {
    const error = rejection(() => normalizeFilter(field, rejected, normalize));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(`${field}: ${shape}`);
    expect(error.data).toEqual({ field });
    expect(JSON.stringify([error.message, (error.cause as McpError).data ?? null])).not.toContain(
      rejected,
    );
  });
  it('points a rejected slug at sources that return one, including a current personId', () => {
    const error = rejection(() => normalizeFilter('sponsor', 'Zz Rejected', normalizeSlug));
    expect(error.message).toBe(
      "sponsor: Expected an OpenParliament politician slug of lowercase letters, digits, and single hyphens, its /politicians/ path, or its OpenParliament profile URL: member.slug from canparl_get_member, a slug from an includeFormer canparl_search_members row, or a current MP's official personId.",
    );
  });
  it('names the lower bound when date bounds are reversed', () => {
    const error = rejection(() =>
      normalizeFilter('dateFrom', '2026-10-20', (from) => validateDateRange(from, '2026-10-19')),
    );
    expect(error.message).toBe('dateFrom: Expected a date no later than dateTo.');
    expect(error.data).toEqual({ field: 'dateFrom' });
  });
  it('builds a rejection for a rule no normalizer owns, keeping extra data', () => {
    const error = rejectFilter('slug|personId', 'Expected exactly one of slug or personId.', {
      reason: 'invalid_member_identifier',
    });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'slug|personId: Expected exactly one of slug or personId.',
      data: { reason: 'invalid_member_identifier', field: 'slug|personId' },
    });
  });
  it('never prefixes a field-named rejection twice', () => {
    const inner = rejectFilter('billDebated.code', 'Expected a bill code.');
    expect(
      rejection(() =>
        normalizeFilter('billDebated', 'x', () => {
          throw inner;
        }),
      ),
    ).toBe(inner);
  });
  it('lets failures other than validation pass unchanged', () => {
    const outage = serviceUnavailable('Upstream unavailable.');
    expect(
      rejection(() =>
        normalizeFilter('status', 'x', () => {
          throw outage;
        }),
      ),
    ).toBe(outage);
  });
  it('converts only field-named rejections into typed failure arguments', () => {
    const named = rejection(() =>
      normalizeFilter('status', 'x', (v) => normalizeVocabulary(v, ['Listed'])),
    );
    expect(filterFailure(named)).toEqual([
      'status: Expected one of "Listed".',
      { field: 'status', allowed: ['Listed'] },
      { cause: named },
    ]);
    const shape = rejectFilter('personId', 'Expected digits.', { reason: 'service_reason' });
    expect(filterFailure(shape)).toEqual([shape.message, { field: 'personId' }, { cause: shape }]);
    for (const other of [validationError('Expected nothing.'), new TypeError('boom'), 'text']) {
      let thrown: unknown;
      try {
        filterFailure(other);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(other);
    }
  });
});

describe('source vocabulary and literal matching', () => {
  it.each(Object.entries(PROVINCES))('accepts postal code %s and its full name', (code, name) => {
    expect(normalizeProvince(` ${code.toLowerCase()} `)).toBe(name);
    expect(normalizeProvince(name.toUpperCase())).toBe(name);
  });
  it.each(['PQ', 'B.C.', 'Newfoundland', 'Ontari'])('rejects geographic guess %s', (input) => {
    expect(() => normalizeProvince(input)).toThrow();
  });
  it('matches composition, apostrophes, case, and repeated whitespace only', () => {
    expect(normalizeVocabulary(" private  MEMBER'S bill ", BILL_TYPES)).toBe(
      'Private Member’s Bill',
    );
    expect(normalizeVocabulary('BLOC QUE\u0301BE\u0301COIS', PARTIES)).toBe('Bloc Québécois');
    expect(normalizeChamber(' HOUSE OF COMMONS ')).toBe('House');
    expect(normalizeChamber(' senate ')).toBe('Senate');
    expect(() => normalizeChamber('Commons')).toThrow();
    expect(() => normalizeVocabulary('Royal assent', BILL_STATUSES)).toThrow();
  });
  it('extends observed vocabulary without rewriting canonical or raw source labels', () => {
    const catalog = ['Private Member’s Bill', 'Agreed To'];
    expect(
      extendVocabulary(catalog, [
        null,
        '',
        '  ',
        "PRIVATE MEMBER'S BILL",
        '  New status  ',
        'new STATUS',
      ]),
    ).toEqual([...catalog, 'New status']);
    expect(catalog).toEqual(['Private Member’s Bill', 'Agreed To']);
    expect(VOTE_RESULTS).toEqual(['Agreed To', 'Negatived', 'Tie']);
    expect(OFFICIAL_PARTY_ALIASES).toEqual({ Bloc: 'Bloc Québécois', Green: 'Green Party' });
  });
  it('uses literal Unicode substrings rather than query syntax or fuzzy matches', () => {
    expect(includesText('Que\u0301bec [a.*]', 'QUÉBEC')).toBe(true);
    expect(includesText('Quebec abc', 'a.*')).toBe(false);
    expect(includesText(null, '')).toBe(false);
  });
});

describe('vocabulary matching on combining-mark runs', () => {
  const CHAMBER_VALUES = ['House', 'House of Commons', 'Senate'];
  /** Reference outcome: every value keyed in full with {@link vocabularyKey}. */
  function plainVocabulary(
    value: string,
    vocabulary: readonly string[],
    aliases: Readonly<Record<string, string>>,
  ): string {
    const key = vocabularyKey(value);
    const target = Object.entries(aliases).find(([alias]) => vocabularyKey(alias) === key)?.[1];
    const targetKey = target === undefined ? key : vocabularyKey(target);
    const match = vocabulary.find((entry) => vocabularyKey(entry) === targetKey);
    const allowed = [...vocabulary, ...Object.keys(aliases)];
    if (!match) throw validationError(`Expected one of ${quoted(allowed)}.`, { allowed });
    return match;
  }
  function plainChamber(value: string): string {
    const key = vocabularyKey(value);
    if (key === 'house' || key === 'house of commons') return 'House';
    if (key === 'senate') return 'Senate';
    throw validationError(`Expected one of ${quoted(CHAMBER_VALUES)}.`, {
      allowed: CHAMBER_VALUES,
    });
  }
  /** The resolved value, or the rejection's code, message, and data, serialized for comparison. */
  const outcome = (resolve: () => string): string => {
    try {
      return JSON.stringify({ match: resolve() });
    } catch (error) {
      const { code, message, data } = error as McpError;
      return JSON.stringify({ code, message, data });
    }
  };
  /** Every filter vocabulary, plus upstream-shaped labels whose keys keep combining-mark runs. */
  const CATALOGS: [readonly string[], Readonly<Record<string, string>>][] = [
    [PARTIES, OFFICIAL_PARTY_ALIASES],
    [Object.values(PROVINCES), PROVINCES],
    [BILL_TYPES, {}],
    [BILL_STATUSES, {}],
    [VOTE_RESULTS, VOTE_RESULT_ALIASES],
    [VOTE_DOCUMENT_TYPES, {}],
    [BALLOTS, OFFICIAL_BALLOT_ALIASES],
    [
      extendVocabulary(PARTIES, [
        `Parti x${cp(0x0323, 0x0302, 0x0304, 0x0306)}`,
        `Stack ${cp(0x0f73).repeat(6)}`,
        `Κόμμα ${cp(0x1f82)}`,
      ]),
      {},
    ],
  ];
  const POOLS = [
    cp(0x0301),
    cp(0x0327, 0x0301),
    cp(0x0f73),
    cp(0x0f71, 0x0f72),
    cp(0x0bbe),
    cp(0x064b, 0x0323, 0x0591, 0x0302, 0x0304, 0x0306, 0x0342, 0x0483, 0x0345, 0x0903, 0x20dd),
  ];
  let seed = 7;
  const random = (bound: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed % bound;
  };
  const marks = (length: number, pool: string) => {
    const units = [...pool];
    return Array.from({ length }, (_, index) => units[(index + random(2)) % units.length]).join('');
  };
  const variants = (value: string) => [
    value,
    value.normalize('NFD'),
    value.toUpperCase(),
    value.toUpperCase().normalize('NFD'),
    ` ${value.replaceAll(' ', ' \t ')}\n`,
    value.replace(/['’]/g, (quote) => (quote === "'" ? '’' : "'")),
  ];
  /** Each variant as written and with a mark run of each length and pool inserted at a random point. */
  const candidates = (values: readonly string[], lengths: readonly number[]) =>
    values.flatMap((value) =>
      variants(value).flatMap((variant) => {
        const units = [...variant];
        return [
          variant,
          ...lengths.flatMap((length) =>
            POOLS.map((pool) => {
              const at = random(units.length + 1);
              return [...units.slice(0, at), marks(length, pool), ...units.slice(at)].join('');
            }),
          ),
        ];
      }),
    );
  /** Run lengths either side of eight marks, of the twelve-mark entry run, and of its bound. */
  const LENGTHS = [1, 3, 8, 9, 12, 13, 56, 57];

  it('resolves every catalog value, variant, and mark-run insertion as a full keying does', () => {
    let compared = 0;
    let matched = 0;
    const differences: string[] = [];
    const compare = (value: string, plain: () => string, resolve: () => string) => {
      const expected = outcome(plain);
      if (outcome(resolve) !== expected) differences.push(JSON.stringify(value));
      compared++;
      if (expected.startsWith('{"match"')) matched++;
    };
    for (const [vocabulary, aliases] of CATALOGS)
      for (const value of candidates([...vocabulary, ...Object.keys(aliases)], LENGTHS))
        compare(
          value,
          () => plainVocabulary(value, vocabulary, aliases),
          () => normalizeVocabulary(value, vocabulary, aliases),
        );
    for (const value of candidates(CHAMBER_VALUES, LENGTHS))
      compare(
        value,
        () => plainChamber(value),
        () => normalizeChamber(value),
      );
    expect(differences).toEqual([]);
    expect(compared).toBeGreaterThan(20_000);
    expect(matched).toBeGreaterThan(450);
  });

  it('matches a value whose combining-mark run is as long as the run its entry keeps', () => {
    const entry = `Stack ${cp(0x0f73).repeat(6)}`;
    // Twelve marks in one run: more than eight, within the bound the entry's twelve-mark key sets.
    expect(normalizeVocabulary(`STACK ${cp(0x0f71, 0x0f72).repeat(6)}`, ['Liberal', entry])).toBe(
      entry,
    );
    expect(normalizeVocabulary(`stack ${cp(0x0f73).repeat(6)}`, ['Liberal', entry])).toBe(entry);
  });

  it.each([
    [
      'party',
      `Liberal${cp(0x0327, 0x0301).repeat(5_000)}`,
      (value: string) => normalizeVocabulary(value, PARTIES, OFFICIAL_PARTY_ALIASES),
      [...PARTIES, 'Bloc', 'Green'],
    ],
    ['originatingChamber', `Senate${cp(0x0f73).repeat(5_000)}`, normalizeChamber, CHAMBER_VALUES],
  ] as const)(
    'rejects %s holding a long combining-mark run with its field and accepted values',
    (field, value, normalize, allowed) => {
      const error = rejection(() => normalizeFilter(field, value, normalize));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(`${field}: Expected one of ${quoted(allowed)}.`);
      expect(error.data).toEqual({ field, allowed });
    },
  );
});

describe('accent-, dash-, quote-, and whitespace-insensitive substring filters', () => {
  /** The comparison every local text filter made before the fold: NFC and en-CA lowercase. */
  const plainMatch = (value: string, query: string) =>
    normalizeText(value).includes(normalizeText(query));
  /**
   * Values as published by the House roster, the 44-1 and 45-1 LEGISinfo list feeds, the 45-1 House
   * divisions feed, and OpenParliament Hansard text (captured 2026-10-31).
   */
  const REAL = [
    'Mélanie Joly',
    'Dominic LeBlanc',
    'Yves-François Blanchet',
    'Élisabeth Brière',
    'Beauséjour',
    'Regina—Lewvan',
    'Saint-Maurice—Champlain',
    'Scarborough—Guildwood—Rouge Park',
    "Loi sur l'unité de l'économie canadienne",
    'Loi modifiant la Loi sur l’efficacité énergétique',
    'Loi sur le cadre national sur les troubles du spectre de l’alcoolisation fœtale',
    'Federal Law–Civil Law Harmonization Act, No. 4',
    'Loi modifiant le Code criminel (méfait — biens religieux)',
    '2nd reading of Bill C-264, An Act to repeal certain restrictions on shipping',
    'one motion in amendment standing on the Notice Paper for the report stage of Bill C‑8. The Chair has received a request from the member for Beauharnois—Salaberry—Soulanges—',
    'he meets with people who have been freed after overseas ordeals. “I always try to defer to meeting with more people rather than fewer people.... ',
    'the Final Self-Government Agreement for the Tlegohli Got’ine and to make consequential amendments',
  ];

  it.each([
    ['an unaccented name', 'Mélanie Joly', 'Melanie Joly'],
    ['an unaccented riding', 'Beauséjour', 'Beausejour'],
    ['a hyphen for an em dash', 'Regina—Lewvan', 'Regina-Lewvan'],
    ['an unaccented title word', "Loi sur l'unité de l'économie canadienne", 'economie'],
    ['a curly apostrophe for a straight one', "Loi sur l'unité", 'Loi sur l’unité'],
    ['a straight apostrophe for a curly one', 'Canada’s', "Canada's"],
    ['oe for the œ ligature', 'l’œuvre', 'oeuvre'],
    ['OE for the uppercase ligature', 'ŒUVRE', 'oeuvre'],
    ['a doubled space', 'Loi sur', 'Loi  sur'],
    ['a tab, no-break space, and line break', 'Loi sur les Indiens', 'Loi\tsur les\r\nIndiens'],
    ['a hyphen for a non-breaking hyphen', 'Bill C‑4, An Act', 'Bill C-4, An Act'],
    ['a non-breaking hyphen for a hyphen', 'Bill C-4, An Act', 'Bill C‑4, An Act'],
    ['a hyphen for an en dash and a minus sign', 'Law–Civil −1', 'Law-Civil -1'],
    ['straight double quotes for curly ones', '“I always try”', '"I always try"'],
    ['stacked combining marks', 'ȩ́té', 'ETE'],
    ['a dotted capital I', 'İstanbul', 'istanbul'],
  ])('matches %s that the plain comparison missed', (_case, value, query) => {
    expect(plainMatch(value, query)).toBe(false);
    expect(includesText(value, query)).toBe(true);
  });

  it.each([
    ['guillemets for straight quotes', '«flotte»', '"flotte"'],
    ['ae for æ', 'æ', 'ae'],
    ['ss for ß', 'ß', 'ss'],
    ['fi for the ﬁ compatibility ligature', 'ﬁscal', 'fiscal'],
    ['2 for a superscript two', 'x²', 'x2'],
    ['an apostrophe for a prime or a modifier letter', 'Canada′s Canadaʼs', "Canada's"],
    ['a hyphen for an underscore, tilde, or period', 'C_4 C~4 C.4', 'C-4'],
    ['a different base letter', 'Beauséjour', 'Beausijour'],
  ])('keeps %s distinct', (_case, value, query) => {
    expect(includesText(value, query)).toBe(false);
  });

  it('strips combining marks after canonical decomposition, leaving bases decomposed', () => {
    expect(stripAccents('Élisabeth Brière')).toBe('Elisabeth Briere');
    expect(stripAccents(`e${'̧́'.repeat(3)}`)).toBe('e');
    expect(stripAccents('한')).toBe('한');
  });

  it('keeps vocabulary filters accent-sensitive', () => {
    expect(() => normalizeVocabulary('Bloc Quebecois', PARTIES)).toThrow();
    expect(normalizeVocabulary('bloc québécois', PARTIES)).toBe('Bloc Québécois');
  });

  /** Queries drawn from `sources`, as written, uppercased, and decomposed, at the given lengths. */
  function supersetMisses(
    sources: readonly string[],
    values: readonly string[],
    lengths: number[],
  ) {
    const plainValues = values.map(normalizeText);
    const misses: string[] = [];
    let accepted = 0;
    for (const source of sources)
      for (const variant of [source, source.toUpperCase(), source.normalize('NFD')])
        for (let start = 0; start < variant.length; start++)
          for (const length of lengths) {
            if (start + length > variant.length) break;
            const query = variant.slice(start, start + length);
            const plainQuery = normalizeText(query);
            for (const [index, value] of values.entries()) {
              if (!plainValues[index]?.includes(plainQuery)) continue;
              accepted++;
              if (!includesText(value, query)) misses.push(`${JSON.stringify(query)} in ${value}`);
            }
          }
    return { accepted, misses };
  }

  it.each([
    ['accented and decomposed letters', 'Élisabeth Brière Çóte ȩ́te İstanbul'],
    ['ligatures', 'l’Œuvre de l’œuvre, oeuvre'],
    ['dashes', 'Regina—Lewvan C‑4 a‐b‒c–d―e−f-g'],
    ['single quotes', "Canada’s ‘own’ Canada's"],
    ['double quotes', '“shadow fleet” "shadow fleet"'],
    ['whitespace', 'Loi \t sur\r\nles Indiens et  　 la'],
  ])('still matches every %s substring the plain comparison matched', (_class, sample) => {
    const lengths = Array.from({ length: sample.length }, (_, index) => index + 1);
    const { accepted, misses } = supersetMisses([sample], [sample], lengths);
    expect(misses).toEqual([]);
    expect(accepted).toBeGreaterThan(sample.length * 10);
  });

  it('still matches every real-value substring the plain comparison matched', () => {
    const { accepted, misses } = supersetMisses(REAL, REAL, [1, 3, 8, 21]);
    expect(misses).toEqual([]);
    expect(accepted).toBeGreaterThan(10_000);
  });

  it.each([
    [`u${cp(0x0903)}Σ`, 'Σ'],
    [`uΣ${cp(0x0903)}a`, 'ς'],
  ])('still matches %j for %j, as the plain comparison did', (value, query) => {
    expect(plainMatch(value, query)).toBe(true);
    expect(includesText(value, query)).toBe(true);
  });

  it('still matches every capital sigma pair the plain comparison matched beside any BMP character', () => {
    const misses: string[] = [];
    let accepted = 0;
    for (let point = 0; point <= 0xffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const c = String.fromCharCode(point);
      for (const value of [`a${c}Σ`, `aΣ${c}b`, `a${c}Σ b`])
        for (const query of ['Σ', 'σ', 'ς']) {
          if (!plainMatch(value, query)) continue;
          accepted++;
          if (!includesText(value, query)) misses.push(JSON.stringify([value, query]));
        }
    }
    expect(misses).toEqual([]);
    expect(accepted).toBeGreaterThan(300_000);
  });
});

describe('civil dates and exact pagination', () => {
  it.each(['2024-02-29', '2000-02-29', ' 2026-10-20 ', '0001-01-01'])(
    'accepts Gregorian date %s',
    (input) => {
      expect(normalizeDate(input)).toBe(input.trim());
    },
  );
  it.each([
    '2025-02-29',
    '1900-02-29',
    '2026-04-31',
    '0000-01-01',
    '2026-1-01',
    '2026-01-01T00:00:00Z',
  ])('rejects invalid date %s', (input) => {
    expect(() => normalizeDate(input)).toThrow();
  });
  it('allows independent bounds and rejects reversed bounds', () => {
    expect(() => validateDateRange('2026-01-01')).not.toThrow();
    expect(() => validateDateRange(undefined, '2026-01-01')).not.toThrow();
    expect(() => validateDateRange('2026-01-01', '2026-01-01')).not.toThrow();
    expect(() => validateDateRange('2026-01-02', '2026-01-01')).toThrow();
  });
  it.each([
    { rows: [], offset: 0, limit: 2, items: [], nextOffset: null, hasMore: false },
    { rows: [1], offset: 0, limit: 2, items: [1], nextOffset: null, hasMore: false },
    { rows: [1, 2], offset: 0, limit: 2, items: [1, 2], nextOffset: null, hasMore: false },
    { rows: [1, 2, 3], offset: 0, limit: 2, items: [1, 2], nextOffset: 2, hasMore: true },
    { rows: [1, 2, 3], offset: 2, limit: 2, items: [3], nextOffset: null, hasMore: false },
    { rows: [1, 2, 3], offset: 99, limit: 2, items: [], nextOffset: null, hasMore: false },
  ])(
    'preserves exact total and continuation for $rows at $offset',
    ({ rows, offset, limit, items, nextOffset, hasMore }) => {
      expect(paginate(rows, offset, limit)).toEqual({
        items,
        total: rows.length,
        pagination: { offset, limit, nextOffset, hasMore },
      });
    },
  );
  it.each([
    { field: 'limit', requested: 1, cap: 100, value: 1 },
    { field: 'limit', requested: 99, cap: 100, value: 99 },
    { field: 'limit', requested: 100, cap: 100, value: 100 },
    { field: 'recentVotes', requested: 0, cap: 10, value: 0 },
    { field: 'sponsoredBills', requested: 5, cap: 5, value: 5 },
  ])(
    'keeps $field $requested at or below cap $cap without a notice',
    ({ field, requested, cap, value }) => {
      expect(clampCount(field, requested, cap)).toStrictEqual({ value });
    },
  );
  it.each([
    {
      field: 'limit',
      requested: 101,
      cap: 100,
      notice: 'limit 101 exceeds the per-call maximum of 100; returned up to 100.',
    },
    {
      field: 'limit',
      requested: 401,
      cap: 400,
      notice: 'limit 401 exceeds the per-call maximum of 400; returned up to 400.',
    },
    {
      field: 'limit',
      requested: 11,
      cap: 10,
      notice: 'limit 11 exceeds the per-call maximum of 10; returned up to 10.',
    },
    {
      field: 'sponsoredBills',
      requested: 10_000,
      cap: 5,
      notice: 'sponsoredBills 10000 exceeds the per-call maximum of 5; returned up to 5.',
    },
    {
      field: 'recentVotes',
      requested: 10_000,
      cap: 10,
      notice: 'recentVotes 10000 exceeds the per-call maximum of 10; returned up to 10.',
    },
  ])(
    'clamps $field $requested to cap $cap and names both values',
    ({ field, requested, cap, notice }) => {
      expect(clampCount(field, requested, cap)).toStrictEqual({ value: cap, notice });
    },
  );
  it.each(['\0', '\ud800', '\udfff', 'prefix\ud800suffix'])(
    'rejects unrepresentable text %j',
    (input) => {
      expect(() => assertRepresentableText(input)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.SerializationError,
          data: expect.objectContaining({ retryable: false }),
        }),
      );
    },
  );
});

/** Input sizes for the timing suites, which set `timeout: 0` (see `cpu-timing.ts`). */
const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];

describe('bill-code grammar timing', { timeout: 0 }, () => {
  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['repeated bill prefix without a code', (n: number) => 'bill '.repeat(n / 5)],
    ['prefix then separators without a number', (n: number) => `bill c${' '.repeat(n)}x`],
    ['chamber then dashes', (n: number) => `C${'-'.repeat(n)}15`],
    ['digit run near-miss', (n: number) => `C-${'1'.repeat(n)}!`],
    ['nested chamber openers', (n: number) => `${'c '.repeat(n / 2)}1`],
    ['suffix-letter run', (n: number) => `C-1${'a'.repeat(n)}`],
    ['alternating digit and suffix letter', (n: number) => `C-${'1a'.repeat(n / 2)}`],
  ])('stays linear on %s', (_shape, build) => {
    expectLinearCpu(
      (input) => {
        try {
          normalizeBillCode(input);
        } catch {
          // Rejection is the expected outcome; only its cost is measured.
        }
      },
      build,
      sizes,
    );
  });
});

/** The substring fold runs in time linear in the value's length on every shape below. */
describe('substring fold timing', { timeout: 0 }, () => {
  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['one combining mark repeated', (n: number) => `e${'́'.repeat(n - 1)}`],
    [
      'combining marks in descending class order',
      (n: number) => `e${'́'.repeat(n / 2)}${'̧'.repeat(n / 2)}`,
    ],
    ['alternating combining-mark classes', (n: number) => `e${'̧́'.repeat(n / 2)}`],
    ['a mixed whitespace run', (n: number) => `a${' \t '.repeat(n / 3)}b`],
    ['a dash run', (n: number) => '—-‑−'.repeat(n / 4)],
    ['decomposing letters', (n: number) => 'ǖÉœ'.repeat(n / 3)],
  ])('stays linear on %s', (_shape, build) => {
    expectLinearCpu((input) => includesText(input, 'x'), build, sizes);
  });
});

/** Vocabulary matching runs in time linear in the caller value's length on every shape below. */
describe('vocabulary matching timing', { timeout: 0 }, () => {
  function expectLinear(resolve: (value: string) => unknown, build: (size: number) => string) {
    expectLinearCpu(
      (input) => {
        try {
          resolve(input);
        } catch {
          // Rejection is the expected outcome for most shapes; only its cost is measured.
        }
      },
      build,
      sizes,
    );
  }
  const alternating = (n: number) => `e${cp(0x0327, 0x0301).repeat(n / 2)}`;
  const eightMarkRuns = (n: number) => `${cp(0x0f40)}${cp(0x0f73).repeat(8)}`.repeat(n / 9);
  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['one combining mark repeated', (n: number) => `e${cp(0x0301).repeat(n - 1)}`],
    [
      'combining marks in descending class order',
      (n: number) => `e${cp(0x0301).repeat(n / 2)}${cp(0x0327).repeat(n / 2)}`,
    ],
    ['alternating combining-mark classes', alternating],
    [
      'a decomposing combining mark repeated',
      (n: number) => `${cp(0x0f40)}${cp(0x0f73).repeat(n - 1)}`,
    ],
    ['eight-mark runs between letters', eightMarkRuns],
    ['a mixed whitespace run', (n: number) => `a${' \t '.repeat(n / 3)}b`],
  ])('keeps party matching linear on %s', (_shape, build) => {
    expectLinear((value) => normalizeVocabulary(value, PARTIES, OFFICIAL_PARTY_ALIASES), build);
  });
  it.each([
    ['alternating combining-mark classes', alternating],
    ['eight-mark runs between letters', eightMarkRuns],
  ])('keeps chamber matching linear on %s', (_shape, build) => {
    expectLinear(normalizeChamber, build);
  });
});
