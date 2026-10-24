/** @fileoverview Current roster and sparse historical member contracts. @module tests/tools/search-members.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVINCES } from '@/domain/normalization.js';
import { PARTIES } from '@/domain/reference-catalog.js';
import { searchMembersTool } from '@/mcp-server/tools/definitions/search-members.tool.js';
import { assertMeasuredResponse } from '../fixtures/bill-tools/harness.js';
import { assertFilterRejection, type FilterRejection } from '../fixtures/filter-rejection.js';
import {
  collection,
  failure,
  page,
  parity,
  rawPerson,
  rosterUrl,
  settle,
  setup,
  teardown,
} from '../fixtures/member-tools/harness.js';

describe('canparl_search_members production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
  });
  afterEach(() => teardown(http));
  const call = (input: Record<string, unknown> = {}) =>
    settle(runToolContract(searchMembersTool, input));
  const roster = () =>
    http.route({
      match: rosterUrl,
      respond: new Response(
        collection('ArrayOfMemberOfParliament', 'MemberOfParliament', [
          rawPerson(3, { PersonOfficialFirstName: 'Zoe', PersonOfficialLastName: 'Zulu' }),
          rawPerson(2, {
            PersonOfficialFirstName: 'Élodie',
            PersonOfficialLastName: 'Alpha',
            CaucusShortName: 'Bloc Québécois',
            ConstituencyProvinceTerritoryName: 'Quebec',
          }),
          rawPerson(1, {
            PersonOfficialFirstName: 'Anne',
            PersonOfficialLastName: 'Alpha',
            CaucusShortName: 'Green Party',
          }),
        ]),
      ),
    });
  it.each([
    [false, 1500],
    [true, 1500],
    [false, 15000],
    [true, 15000],
  ] as const)(
    'fits current/historical mode %j with %i-character names and resumes every whole row',
    async (includeFormer, size) => {
      const name = 'é'.repeat(size);
      if (includeFormer) {
        for (let offset = 0; offset < 8; offset++)
          page(
            http,
            '/politicians/',
            { limit: 100, offset, include: 'all' },
            Array.from({ length: 8 - offset }, (_, i) => ({
              name,
              url: `/politicians/member-${offset + i + 1}/`,
            })),
          );
      } else
        http.route({
          match: rosterUrl,
          respond: new Response(
            collection(
              'ArrayOfMemberOfParliament',
              'MemberOfParliament',
              Array.from({ length: 8 }, (_, i) =>
                rawPerson(i + 1, {
                  PersonOfficialFirstName: name,
                  PersonOfficialLastName: 'Repeated',
                }),
              ),
            ),
          ),
        });
      const ids: string[] = [];
      let offset: number | null = 0;
      let pages = 0;
      do {
        const result = await call({ includeFormer, limit: 10_000, offset });
        const data = parity(result, searchMembersTool) as {
          members: { personId: string | null; slug: string | null; name: string }[];
          pagination: { nextOffset: number | null };
        };
        const bytes = assertMeasuredResponse(result, searchMembersTool, data.members);
        if (bytes > 24_000)
          expect(result.structuredContent).toMatchObject({
            shown: 1,
            notice: expect.stringContaining('exceeds'),
          });
        expect(data.members.length).toBeGreaterThan(0);
        expect(result.structuredContent).toMatchObject({
          total: includeFormer ? null : 8,
          cap: 100,
          notice: expect.stringContaining('maximum of 100'),
        });
        for (const row of data.members)
          expect(row.name).toBe(includeFormer ? name : `${name} Repeated`);
        ids.push(...data.members.map((row) => (includeFormer ? row.slug! : row.personId!)));
        offset = data.pagination.nextOffset;
        if (offset !== null) expect(offset).toBe(ids.length);
        expect(++pages).toBeLessThanOrEqual(8);
      } while (offset !== null);
      expect(pages).toBeGreaterThan(1);
      expect(ids).toEqual(
        Array.from({ length: 8 }, (_, i) => (includeFormer ? `member-${i + 1}` : String(i + 1))),
      );
    },
  );
  it.each([
    [{}, ['1', '2', '3']],
    [{ limit: 2 }, ['1', '2']],
    [{ limit: 3 }, ['1', '2', '3']],
    [{ offset: 3 }, []],
    [{ offset: 9 }, []],
    [{ name: 'absent' }, []],
    [{ name: '', riding: ' ', province: '', party: ' ' }, ['1', '2', '3']],
  ])('filters the complete roster before paging %j', async (input, ids) => {
    roster();
    const result = await call(input);
    const data = parity(result, searchMembersTool);
    expect((data.members as { personId: string }[]).map((row) => row.personId)).toEqual(ids);
    expect(data.total).toBe('name' in input && input.name === 'absent' ? 0 : 3);
    expect(data.totalCount).toBe(data.total);
    expect(
      result.content
        .slice(1)
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n'),
    ).toContain(`totalCount: ${data.totalCount}`);
    expect(http.calls).toHaveLength(1);
    expect(data).toMatchObject({
      cap: 'limit' in input ? input.limit : 25,
      shown: ids.length,
      appliedFilters: { includeFormer: false, nameMode: 'substring' },
    });
  });
  it('intersects Unicode literal name/riding with province and caucus aliases', async () => {
    roster();
    const data = parity(
      await call({ name: 'e\u0301LODIE', riding: '[riding]', province: ' qc ', party: ' Bloc ' }),
      searchMembersTool,
    );
    expect(data).toMatchObject({
      total: 1,
      members: [
        {
          personId: '2',
          slug: null,
          current: true,
          name: 'Élodie Alpha',
          detailLookup: { personId: '2' },
        },
      ],
      appliedFilters: { province: 'Quebec', party: 'Bloc Québécois' },
    });
  });
  it('accepts Green and a full English province while reporting canonical filters', async () => {
    roster();
    const data = parity(
      await call({ party: ' GREEN ', province: 'ontario', limit: 100 }),
      searchMembersTool,
    );
    expect(data).toMatchObject({
      total: 1,
      members: [{ personId: '1' }],
      appliedFilters: { party: 'Green Party', province: 'Ontario' },
      pagination: { limit: 100, hasMore: false },
      shown: 1,
      cap: 100,
      truncated: false,
    });
    expect(data).not.toHaveProperty('notice');
  });
  it.each([150, 10_000])('clamps current-roster limit %i to the 100-row cap', async (limit) => {
    http.route({
      match: rosterUrl,
      respond: new Response(
        collection(
          'ArrayOfMemberOfParliament',
          'MemberOfParliament',
          Array.from({ length: 150 }, (_, i) =>
            rawPerson(i + 1, { PersonOfficialLastName: `Surname${String(i).padStart(3, '0')}` }),
          ),
        ),
      ),
    });
    const notice = `limit ${limit} exceeds the per-call maximum of 100; returned up to 100.`;
    const ids: string[] = [];
    let offset: number | null = 0;
    do {
      const result = await call({ limit, offset });
      const data = parity(result, searchMembersTool) as {
        members: { personId: string }[];
        pagination: { nextOffset: number | null };
      };
      assertMeasuredResponse(result, searchMembersTool, data.members);
      expect(result.structuredContent).toMatchObject({
        total: 150,
        cap: 100,
        notice: expect.stringContaining(notice),
        pagination: { offset, limit: 100 },
      });
      expect(data.members.length).toBeGreaterThan(0);
      ids.push(...data.members.map((row) => row.personId));
      offset = data.pagination.nextOffset;
      if (offset !== null) expect(offset).toBe(ids.length);
      expect(ids.length).toBeLessThanOrEqual(150);
    } while (offset !== null);
    expect(ids).toEqual(Array.from({ length: 150 }, (_, i) => String(i + 1)));
  });
  it.each([150, 10_000])(
    'requests a historical page of 100 for limit %i and discloses the clamp',
    async (limit) => {
      const url = page(
        http,
        '/politicians/',
        { limit: 100, offset: 0, include: 'all', family_name: 'Example' },
        [{ name: 'River Example', url: '/politicians/river-example/' }],
        100,
      );
      const data = parity(
        await call({ includeFormer: true, name: 'Example', limit }),
        searchMembersTool,
      );
      expect(http.calls.map((c) => c.request.url)).toEqual([url]);
      expect(data).toMatchObject({
        total: null,
        shown: 1,
        cap: 100,
        truncated: true,
        pagination: { offset: 0, limit: 100, nextOffset: 100, hasMore: true },
        notice: `limit ${limit} exceeds the per-call maximum of 100; returned up to 100.`,
      });
    },
  );
  it('does not infer historical continuation from a full page', async () => {
    page(http, '/politicians/', { limit: 1, offset: 0, include: 'all' }, [
      { name: 'River Example', url: '/politicians/river-example/' },
    ]);
    const result = await call({ includeFormer: true, limit: 1 });
    const data = parity(result, searchMembersTool);
    expect(data).not.toHaveProperty('totalCount');
    expect(
      result.content
        .slice(1)
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n'),
    ).not.toContain(' total**');
    expect(data).toMatchObject({
      total: null,
      shown: 1,
      cap: 1,
      truncated: false,
      pagination: { nextOffset: null, hasMore: false },
    });
  });
  it('preserves an explicit source continuation on an empty historical page', async () => {
    page(http, '/politicians/', { limit: 25, offset: 7, include: 'all' }, [], 12);
    const data = parity(await call({ includeFormer: true, offset: 7 }), searchMembersTool);
    expect(data).toMatchObject({
      total: null,
      shown: 0,
      truncated: true,
      pagination: { offset: 7, nextOffset: 12, hasMore: true },
      notice: expect.stringContaining('offset 0'),
    });
  });
  it('resumes inside a shortened historical page before following its source gap', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      name: 'é'.repeat(1500),
      url: `/politicians/gap-${i + 7}/`,
    }));
    for (let offset = 7; offset < 11; offset++)
      page(
        http,
        '/politicians/',
        { limit: 100, offset, include: 'all' },
        rows.slice(offset - 7),
        12,
      );
    page(http, '/politicians/', { limit: 100, offset: 12, include: 'all' }, [
      { name: 'Final', url: '/politicians/gap-12/' },
    ]);
    const ids: string[] = [];
    const offsets: number[] = [];
    let offset: number | null = 7;
    do {
      offsets.push(offset);
      const result = await call({ includeFormer: true, limit: 100, offset });
      const data = parity(result, searchMembersTool) as {
        members: { slug: string }[];
        pagination: { nextOffset: number | null };
      };
      assertMeasuredResponse(result, searchMembersTool, data.members);
      ids.push(...data.members.map((row) => row.slug));
      offset = data.pagination.nextOffset;
      expect(offsets.length).toBeLessThanOrEqual(5);
    } while (offset !== null);
    expect(ids).toEqual(['gap-7', 'gap-8', 'gap-9', 'gap-10', 'gap-12']);
    expect(offsets).toEqual([7, 10, 12]);
  });
  const provinces = [...Object.values(PROVINCES), ...Object.keys(PROVINCES)];
  it.each<[Record<string, string>, FilterRejection]>([
    [{ province: 'PQ' }, { field: 'province', rejected: 'PQ', allowed: provinces }],
    [{ province: 'Atlantis' }, { field: 'province', rejected: 'Atlantis', allowed: provinces }],
    [
      { party: 'Imaginary' },
      { field: 'party', rejected: 'Imaginary', allowed: [...PARTIES, 'Bloc', 'Green'] },
    ],
  ])('returns declared current-filter recovery %j', async (input, expected) => {
    roster();
    const result = await call(input);
    failure(result, searchMembersTool.errors![1]!);
    assertFilterRejection(result, expected);
  });
  it.each(['riding', 'province', 'party'])('rejects historical %s before network', async (key) => {
    failure(await call({ includeFormer: true, [key]: 'Ontario' }), searchMembersTool.errors![0]!);
    expect(http.calls).toHaveLength(0);
  });
  it.each([
    ['Example', 'family_name', 'surname'],
    ['River Example', 'name', 'full_name'],
    ['', null, 'index'],
  ] as const)('uses sparse source name semantics for %s', async (name, key, nameMode) => {
    page(
      http,
      '/politicians/',
      { limit: 1, offset: 7, include: 'all', ...(key ? { [key]: name } : {}) },
      [{ name: 'River Example', url: '/politicians/river-example/' }],
      12,
    );
    const data = parity(
      await call({ includeFormer: true, name, limit: 1, offset: 7, riding: ' ', party: '' }),
      searchMembersTool,
    );
    expect(data).toMatchObject({
      total: null,
      members: [
        {
          name: 'River Example',
          slug: 'river-example',
          personId: null,
          current: null,
          party: null,
          riding: null,
          province: null,
          detailLookup: { slug: 'river-example' },
        },
      ],
      appliedFilters: { nameMode },
      pagination: { nextOffset: 12, hasMore: true },
      shown: 1,
      cap: 1,
      truncated: true,
    });
    expect(http.calls).toHaveLength(1);
  });
  it.each([0, 8])('preserves historical empty and past-end guidance at %i', async (offset) => {
    page(http, '/politicians/', { limit: 25, offset, include: 'all', family_name: 'Missing' }, []);
    const data = parity(
      await call({ includeFormer: true, name: 'Missing', offset }),
      searchMembersTool,
    );
    expect(data).toMatchObject({
      total: null,
      members: [],
      pagination: { hasMore: false, nextOffset: null },
      notice: expect.stringContaining(offset ? 'offset 0' : 'surname alone'),
    });
  });
  it.each([{ limit: 0 }, { limit: 10_001 }, { offset: -1 }])(
    'rejects invalid schema %j without network',
    async (input) => {
      expect((await call(input)).structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(http.calls).toHaveLength(0);
    },
  );
});
