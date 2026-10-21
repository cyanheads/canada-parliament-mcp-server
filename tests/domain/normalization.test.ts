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
  normalizeVocabulary,
  PROVINCES,
  paginate,
  rejectFilter,
  validateDateRange,
} from '@/domain/normalization.js';
import {
  BILL_STATUSES,
  BILL_TYPES,
  extendVocabulary,
  OFFICIAL_PARTY_ALIASES,
  PARTIES,
  VOTE_RESULT_ALIASES,
  VOTE_RESULTS,
} from '@/domain/reference-catalog.js';

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

/**
 * Cases run synchronously, so a wall-clock timeout cannot stop one early; it only fails a loaded
 * host after the thread-CPU assertions passed. Timeout 0 leaves those assertions as the only bound.
 */
describe('bill-code grammar timing', { timeout: 0 }, () => {
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
    ['repeated bill prefix without a code', (n: number) => 'bill '.repeat(n / 5)],
    ['prefix then separators without a number', (n: number) => `bill c${' '.repeat(n)}x`],
    ['chamber then dashes', (n: number) => `C${'-'.repeat(n)}15`],
    ['digit run near-miss', (n: number) => `C-${'1'.repeat(n)}!`],
    ['nested chamber openers', (n: number) => `${'c '.repeat(n / 2)}1`],
    ['suffix-letter run', (n: number) => `C-1${'a'.repeat(n)}`],
    ['alternating digit and suffix letter', (n: number) => `C-${'1a'.repeat(n / 2)}`],
  ])('stays linear on %s', (_shape, build) => {
    const run = (input: string) => () => {
      try {
        normalizeBillCode(input);
      } catch {
        // Rejection is the expected outcome; only its cost is measured.
      }
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
