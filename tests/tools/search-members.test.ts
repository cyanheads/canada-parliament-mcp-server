/** @fileoverview Current roster and sparse historical member contracts. @module tests/tools/search-members.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POSTAL_CODE_FORMAT, PROVINCES } from '@/domain/normalization.js';
import { PARTIES } from '@/domain/reference-catalog.js';
import { getVoteTool } from '@/mcp-server/tools/definitions/get-vote.tool.js';
import { searchMembersTool } from '@/mcp-server/tools/definitions/search-members.tool.js';
import { assertMeasuredResponse } from '../fixtures/bill-tools/harness.js';
import {
  assertArgumentRejection,
  assertFilterRejection,
  type FilterRejection,
} from '../fixtures/filter-rejection.js';
import {
  collection,
  failure,
  page,
  parity,
  parliamentRosterUrl,
  postalLookupUrl,
  rawPerson,
  realPostalLookup,
  realRoster,
  rosterPicker,
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
    'returns every whole current/historical mode %j row with %i-character names in one page',
    async (includeFormer, size) => {
      const name = 'é'.repeat(size);
      if (includeFormer)
        page(
          http,
          '/politicians/',
          { limit: 100, offset: 0, include: 'all' },
          Array.from({ length: 8 }, (_, i) => ({ name, url: `/politicians/member-${i + 1}/` })),
        );
      else
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
      const result = await call({ includeFormer, limit: 10_000 });
      const data = parity(result, searchMembersTool) as {
        members: { personId: string | null; slug: string | null; name: string }[];
      };
      expect(assertMeasuredResponse(result, searchMembersTool)).toBeGreaterThan(24_000);
      expect(result.structuredContent).toMatchObject({
        total: includeFormer ? null : 8,
        shown: 8,
        cap: 100,
        truncated: false,
        pagination: { offset: 0, limit: 100, nextOffset: null, hasMore: false },
        notice: 'limit 10000 exceeds the per-call maximum of 100; returned up to 100.',
      });
      for (const row of data.members)
        expect(row.name).toBe(includeFormer ? name : `${name} Repeated`);
      expect(data.members.map((row) => (includeFormer ? row.slug : row.personId))).toEqual(
        Array.from({ length: 8 }, (_, i) => (includeFormer ? `member-${i + 1}` : String(i + 1))),
      );
    },
  );
  it.each([false, true])(
    'continues heavy current/historical mode %j rows by limit alone, returning each exactly once',
    async (includeFormer) => {
      const name = 'é'.repeat(15_000);
      if (includeFormer)
        for (const offset of [0, 3, 6])
          page(
            http,
            '/politicians/',
            { limit: 3, offset, include: 'all' },
            Array.from({ length: Math.min(3, 8 - offset) }, (_, i) => ({
              name,
              url: `/politicians/member-${offset + i + 1}/`,
            })),
            offset === 6 ? null : offset + 3,
          );
      else
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
      const ids: (string | null)[] = [];
      const sizes: number[] = [];
      let offset: number | null = 0;
      do {
        const result = await call({ includeFormer, limit: 3, offset });
        const data = parity(result, searchMembersTool) as {
          members: { personId: string | null; slug: string | null }[];
          pagination: { nextOffset: number | null };
        };
        expect(data).not.toHaveProperty('notice');
        sizes.push(data.members.length);
        ids.push(...data.members.map((row) => (includeFormer ? row.slug : row.personId)));
        offset = data.pagination.nextOffset;
        if (offset !== null) expect(offset).toBe(ids.length);
      } while (offset !== null);
      expect(sizes).toEqual([3, 3, 2]);
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
    [{ name: '', riding: ' ', province: '', party: ' ', postalCode: ' ' }, ['1', '2', '3']],
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
      appliedFilters: {
        includeFormer: false,
        parliament: null,
        nameMode: 'substring',
        postalCode: null,
      },
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
    const sizes: number[] = [];
    let offset: number | null = 0;
    do {
      const result = await call({ limit, offset });
      const data = parity(result, searchMembersTool) as {
        members: { personId: string }[];
        pagination: { nextOffset: number | null };
      };
      assertMeasuredResponse(result, searchMembersTool);
      expect(result.structuredContent).toMatchObject({
        total: 150,
        cap: 100,
        notice,
        pagination: { offset, limit: 100 },
      });
      sizes.push(data.members.length);
      ids.push(...data.members.map((row) => row.personId));
      offset = data.pagination.nextOffset;
      if (offset !== null) expect(offset).toBe(ids.length);
      expect(ids.length).toBeLessThanOrEqual(150);
    } while (offset !== null);
    expect(sizes).toEqual([100, 50]);
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
  it('carries the source gap and terminal null from whole heavy historical pages', async () => {
    page(
      http,
      '/politicians/',
      { limit: 100, offset: 7, include: 'all' },
      Array.from({ length: 4 }, (_, i) => ({
        name: 'é'.repeat(1500),
        url: `/politicians/gap-${i + 7}/`,
      })),
      12,
    );
    page(http, '/politicians/', { limit: 100, offset: 12, include: 'all' }, [
      { name: 'Final', url: '/politicians/gap-12/' },
    ]);
    const ids: string[] = [];
    const offsets: number[] = [];
    const wires: number[] = [];
    let offset: number | null = 7;
    do {
      offsets.push(offset);
      const result = await call({ includeFormer: true, limit: 100, offset });
      const data = parity(result, searchMembersTool) as {
        members: { slug: string }[];
        pagination: { nextOffset: number | null };
      };
      expect(data).not.toHaveProperty('notice');
      wires.push(assertMeasuredResponse(result, searchMembersTool));
      ids.push(...data.members.map((row) => row.slug));
      offset = data.pagination.nextOffset;
      expect(offsets.length).toBeLessThanOrEqual(5);
    } while (offset !== null);
    expect(ids).toEqual(['gap-7', 'gap-8', 'gap-9', 'gap-10', 'gap-12']);
    expect(offsets).toEqual([7, 12]);
    expect(wires[0]).toBeGreaterThan(24_000);
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
      appliedFilters: { nameMode, postalCode: null },
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
  describe('parliament rosters', () => {
    const offered = ['45', '44', '43', '42', '41', '40', '39', '38', '37', '36'];
    const urls = () => http.calls.map((entry) => entry.request.url);
    /** Real picker, the named Parliament rosters, and the real current roster (72029, 89156). */
    const official = (...parliaments: (45 | 41 | 38 | 36)[]) => {
      http.route(
        { match: rosterPicker, respond: () => new Response(realRoster('picker')) },
        { match: rosterUrl, respond: () => new Response(realRoster('current')) },
      );
      for (const parliament of parliaments)
        http.route({
          match: parliamentRosterUrl(parliament),
          respond: () => new Response(realRoster(`p${parliament}`)),
        });
    };
    type Row = Record<string, unknown> & { personId: string };
    const rows = (data: Record<string, unknown>) => data.members as Row[];
    it('searches a past Parliament by name with official identity, currentness, and membership span', async () => {
      official(41);
      const data = parity(await call({ parliament: 41, name: 'Trudeau' }), searchMembersTool);
      expect(data).toMatchObject({
        total: 1,
        totalCount: 1,
        members: [
          {
            personId: '58733',
            slug: null,
            name: 'Justin Trudeau',
            party: 'Liberal',
            riding: 'Papineau',
            province: 'Quebec',
            current: false,
            from: '2011-05-02T00:00:00',
            to: '2015-10-18T23:59:59',
            url: 'https://www.ourcommons.ca/Members/en/58733',
            detailLookup: { personId: '58733' },
          },
        ],
        appliedFilters: { includeFormer: false, parliament: 41, name: 'Trudeau', postalCode: null },
      });
      expect(urls()).toEqual([rosterPicker, parliamentRosterUrl(41), rosterUrl]);
      expect((data.provenance as { url: string }[]).map((source) => source.url)).toEqual([
        rosterPicker,
        parliamentRosterUrl(41),
        rosterUrl,
      ]);
    });
    it('marks a past-Parliament member who still sits as current and relays a blank caucus as null', async () => {
      official(41);
      const data = parity(await call({ parliament: 41 }), searchMembersTool);
      expect(rows(data).map((row) => [row.personId, row.current, row.party])).toEqual([
        ['72029', true, 'Conservative'],
        ['35933', false, 'Conservative'],
        ['71465', false, null],
        ['71341', false, 'NDP'],
        ['58733', false, 'Liberal'],
      ]);
      expect(rows(data)[0]).toMatchObject({
        riding: 'Okanagan—Coquihalla',
        to: '2015-10-18T23:59:59',
      });
    });
    it('filters a riding to everyone who held it in that Parliament, each with their own dates', async () => {
      official(38);
      const data = parity(await call({ parliament: 38, riding: 'Labrador' }), searchMembersTool);
      expect(data.total).toBe(2);
      expect(
        rows(data).map(({ personId, name, from, to }) => ({ personId, name, from, to })),
      ).toEqual([
        {
          personId: '18',
          name: "Lawrence O'Brien",
          from: '2004-06-28T00:00:00',
          to: '2004-12-16T23:59:59',
        },
        {
          personId: '29612',
          name: 'Todd Russell',
          from: '2005-05-24T00:00:00',
          to: '2006-01-22T23:59:00',
        },
      ]);
    });
    it.each<[38 | 36, string, string[]]>([
      [38, 'Bloc', ['25469']],
      [38, 'Conservative', ['1463']],
      [38, 'Liberal', ['13', '192', '18', '29612', '25458']],
      [36, 'Canadian Alliance', ['1463']],
      [36, 'reform', ['1519']],
      [36, 'Green Party', []],
    ])(
      "filters Parliament %i by its rows' last caucus %j, accepting that roster's own names",
      async (parliament, party, ids) => {
        official(parliament);
        const data = parity(await call({ parliament, party }), searchMembersTool);
        expect(rows(data).map((row) => row.personId)).toEqual(ids);
        expect(data.total).toBe(ids.length);
      },
    );
    it.each<[Record<string, unknown>, { personId: string; name: string; riding: string }[]]>([
      [
        { parliament: 41, name: 'Mylene' },
        [{ personId: '71341', name: 'Mylène Freeman', riding: 'Argenteuil—Papineau—Mirabel' }],
      ],
      [{ parliament: 41, name: 'Mylena' }, []],
      [
        { riding: 'Okanagan Lake West-South Kelowna' },
        [{ personId: '72029', name: 'Dan Albas', riding: 'Okanagan Lake West—South Kelowna' }],
      ],
      [{ riding: 'Okanagan Lake West South Kelowna' }, []],
    ])(
      'matches name and riding %j ignoring accents and dash style, relaying source spellings',
      async (input, expected) => {
        official(41);
        const data = parity(await call(input), searchMembersTool);
        expect(
          rows(data).map(({ personId, name, riding }) => ({ personId, name, riding })),
        ).toEqual(expected);
        expect(data).toMatchObject({
          total: expected.length,
          appliedFilters: { parliament: null, name: null, riding: null, ...input },
        });
        if (!expected.length)
          expect(data.notice).toBe(
            'No MPs matched; broaden or remove a filter and retry canparl_search_members.',
          );
      },
    );
    it('rejects a past caucus on the current roster, whose vocabulary lacks it', async () => {
      official();
      const result = await call({ party: 'Canadian Alliance' });
      failure(result, searchMembersTool.errors![1]!);
      assertFilterRejection(result, {
        field: 'party',
        rejected: 'Canadian Alliance',
        allowed: [...PARTIES, 'Bloc', 'Green'],
      });
    });
    it('reads the 45th Parliament roster, departed members included, not the current roster', async () => {
      official(45);
      const data = parity(await call({ parliament: 45 }), searchMembersTool);
      expect(rows(data).map((row) => [row.personId, row.current, row.to])).toEqual([
        ['89156', true, null],
        ['72029', true, null],
        ['88961', false, '2026-02-02T16:00:00'],
      ]);
      expect(data.total).toBe(3);
      expect(urls()).toEqual([rosterPicker, parliamentRosterUrl(45), rosterUrl]);
    });
    it.each([
      [0, 3, ['1463', '25469', '13'], 3],
      [3, 3, ['192', '18', '29612'], 6],
      [6, 3, ['25458'], null],
      [7, 3, [], null],
    ] as const)(
      'pages the sorted Parliament roster at offset %i, limit %i',
      async (offset, limit, ids, nextOffset) => {
        official(38);
        const data = parity(await call({ parliament: 38, offset, limit }), searchMembersTool);
        expect(rows(data).map((row) => row.personId)).toEqual(ids);
        expect(data).toMatchObject({
          total: 7,
          pagination: { offset, limit, nextOffset, hasMore: nextOffset !== null },
          truncated: nextOffset !== null,
        });
        if (!ids.length) expect(data.notice).toContain('offset 0');
      },
    );
    it('rejects a Parliament the roster does not offer, listing those offered, before any roster request', async () => {
      official();
      const result = await call({ parliament: 35 });
      failure(result, searchMembersTool.errors![1]!);
      assertFilterRejection(result, { field: 'parliament', rejected: '', allowed: offered });
      expect(urls()).toEqual([rosterPicker]);
    });
    it('rejects parliament in historical mode before any request', async () => {
      failure(await call({ includeFormer: true, parliament: 41 }), searchMembersTool.errors![0]!);
      expect(http.calls).toHaveLength(0);
    });
    it('fails an offered Parliament whose roster comes back empty instead of returning zero members', async () => {
      http.route(
        { match: rosterPicker, respond: () => new Response(realRoster('picker')) },
        { match: parliamentRosterUrl(41), respond: () => new Response(realRoster('empty')) },
      );
      const result = await call({ parliament: 41 });
      failure(
        result,
        searchMembersTool.errors!.find((entry) => entry.reason === 'roster_unavailable')!,
      );
      expect(urls()).toEqual([
        rosterPicker,
        parliamentRosterUrl(41),
        parliamentRosterUrl(41),
        parliamentRosterUrl(41),
      ]);
    });
    // The framework repairs a numeric string such as "41" to 41 before validation.
    it.each([0, 1.5, -2, 'forty-one'])(
      'rejects parliament %j at the schema without network',
      async (parliament) => {
        expect((await call({ parliament })).structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        expect(http.calls).toHaveLength(0);
      },
    );
    it('describes one caucus per member and the published membership dates', () => {
      const member = searchMembersTool.output.shape.members.element.shape;
      expect(searchMembersTool.input.shape.party.description).toContain(
        'the one caucus each member last held in that Parliament',
      );
      expect(member.party.description).toContain('one caucus per member');
      expect(member.from.description).toContain('FromDateTime as published');
      expect(member.to.description).toContain('ToDateTime as published; null while sitting');
      expect(searchMembersTool.input.shape.parliament.description).toContain('36th onward');
    });
  });
  describe('postal codes', () => {
    const urls = () => http.calls.map((entry) => entry.request.url);
    type Row = Record<string, unknown> & { personId: string };
    const ids = (data: Record<string, unknown>) =>
      (data.members as Row[]).map((row) => row.personId);
    const people: Record<string, Record<string, unknown>> = {
      110572: {
        PersonOfficialFirstName: 'Yasir',
        PersonOfficialLastName: 'Naqvi',
        ConstituencyName: 'Ottawa Centre',
      },
      122850: {
        PersonOfficialFirstName: 'Bruce',
        PersonOfficialLastName: 'Fanjoy',
        ConstituencyName: 'Carleton',
      },
      110459: {
        PersonOfficialFirstName: 'Jenna',
        PersonOfficialLastName: 'Sudds',
        ConstituencyName: 'Kanata',
      },
      72029: {
        PersonOfficialFirstName: 'Dan',
        PersonOfficialLastName: 'Albas',
        ConstituencyName: 'Okanagan Lake West—South Kelowna',
        ConstituencyProvinceTerritoryName: 'British Columbia',
        CaucusShortName: 'Conservative',
      },
    };
    /**
     * Current roster holding the captured lookups' members, or only `only`; 72029 no lookup names.
     * `changed` replaces fields of a member's roster row, the row the filters read.
     */
    const sitting = (
      only = Object.keys(people),
      changed: Record<string, Record<string, unknown>> = {},
    ) =>
      http.route({
        match: rosterUrl,
        respond: () =>
          new Response(
            collection(
              'ArrayOfMemberOfParliament',
              'MemberOfParliament',
              only.map((id) => rawPerson(Number(id), { ...people[id], ...changed[id] })),
            ),
          ),
      });
    const lookup = (code: 'K1A0A6' | 'K0A1L0' | 'Z9Z9Z9') =>
      http.route({
        match: postalLookupUrl(code),
        respond: () =>
          new Response(realPostalLookup(code.toLowerCase() as 'k1a0a6' | 'k0a1l0' | 'z9z9z9')),
      });
    const noSitting =
      'No sitting MP matched this postal code: it is unassigned, or its riding is vacant. Check the code, or retry canparl_search_members with riding set to the riding name.';
    const noMatch = 'No MPs matched; broaden or remove a filter and retry canparl_search_members.';
    it('reads every spelling of K1A 0A6 as one canonical lookup beside the cached roster', async () => {
      sitting();
      lookup('K1A0A6');
      for (const [i, postalCode] of ['K1A 0A6', 'k1a0a6', 'K1A-0A6', 'K1A 0A6'].entries()) {
        const data = parity(await call({ postalCode }), searchMembersTool);
        expect(data).toMatchObject({
          total: 1,
          totalCount: 1,
          members: [
            {
              personId: '110572',
              slug: null,
              name: 'Yasir Naqvi',
              riding: 'Ottawa Centre',
              current: true,
              detailLookup: { personId: '110572' },
            },
          ],
          appliedFilters: { includeFormer: false, parliament: null, postalCode: 'K1A0A6' },
          shown: 1,
          truncated: false,
        });
        expect(data).not.toHaveProperty('notice');
        expect(
          (data.provenance as { url: string; cached: boolean }[]).map((source) => [
            source.url,
            source.cached,
          ]),
        ).toEqual([
          [postalLookupUrl('K1A0A6'), i > 0],
          [rosterUrl, i > 0],
        ]);
      }
      expect(urls()).toEqual([postalLookupUrl('K1A0A6'), rosterUrl]);
    });
    /** 122850's roster row in another caucus and province, so caucus and province split the code. */
    const split = {
      122850: { CaucusShortName: 'Conservative', ConstituencyProvinceTerritoryName: 'Quebec' },
    };
    it.each<[Record<string, string>, string[], Record<string, Record<string, unknown>>?]>([
      [{}, ['122850', '110459']],
      [{ riding: 'Kanata' }, ['110459']],
      [{ name: 'jenna', party: 'Liberal', province: 'ON' }, ['110459']],
      [{ party: 'Conservative' }, ['122850'], split],
      [{ party: 'Liberal' }, ['110459'], split],
      [{ province: 'QC' }, ['122850'], split],
      [{ province: 'ON' }, ['110459'], split],
      [{ province: 'BC' }, []],
    ])(
      'returns every sitting MP of a code spanning ridings, ANDed with %j',
      async (input, expected, changed) => {
        sitting(undefined, changed);
        lookup('K0A1L0');
        const data = parity(await call({ postalCode: 'K0A 1L0', ...input }), searchMembersTool);
        expect(ids(data)).toEqual(expected);
        expect(data).toMatchObject({
          total: expected.length,
          appliedFilters: { postalCode: 'K0A1L0' },
        });
      },
    );
    it('pages the postal rows with an exact total', async () => {
      sitting();
      lookup('K0A1L0');
      const data = parity(
        await call({ postalCode: 'K0A1L0', limit: 1, offset: 1 }),
        searchMembersTool,
      );
      expect(ids(data)).toEqual(['110459']);
      expect(data).toMatchObject({
        total: 2,
        pagination: { offset: 1, limit: 1, nextOffset: null, hasMore: false },
      });
      expect(data).not.toHaveProperty('notice');
      const pastEnd = parity(await call({ postalCode: 'K0A1L0', offset: 2 }), searchMembersTool);
      expect(pastEnd).toMatchObject({
        total: 2,
        members: [],
        pagination: { offset: 2, nextOffset: null, hasMore: false },
        notice: 'Retry canparl_search_members with offset 0 and the same filters.',
      });
    });
    it('drops a lookup row whose personId is not on the current roster', async () => {
      sitting(['110459', '72029']);
      lookup('K0A1L0');
      const data = parity(await call({ postalCode: 'K0A1L0' }), searchMembersTool);
      expect(ids(data)).toEqual(['110459']);
      expect(data.total).toBe(1);
    });
    it.each<[string, 'K1A0A6' | 'Z9Z9Z9', string[] | undefined, Record<string, string>, string]>([
      ['an unassigned code', 'Z9Z9Z9', undefined, {}, noSitting],
      ['a code whose one member is off the current roster', 'K1A0A6', ['72029'], {}, noSitting],
      [
        'a code whose members the other filters exclude',
        'K1A0A6',
        undefined,
        { riding: 'Kanata' },
        noMatch,
      ],
    ])('returns an empty page with its notice for %s', async (_case, code, only, input, notice) => {
      sitting(only);
      lookup(code);
      const data = parity(await call({ postalCode: code, ...input }), searchMembersTool);
      expect(data).toMatchObject({
        total: 0,
        members: [],
        appliedFilters: { postalCode: code },
        pagination: { nextOffset: null, hasMore: false },
        notice,
      });
    });
    it.each<[string, string]>([
      ['K1A', ''],
      ['K1A0A', 'K1A0A'],
      ['K1A0A67', 'K1A0A67'],
      ['K1A  0A6', 'K1A  0A6'],
      ['1A1A1A', '1A1A1A'],
    ])('rejects postalCode %j at the schema before any request', async (postalCode, rejected) => {
      assertArgumentRejection(await call({ postalCode }), {
        lines: [`postalCode: ${POSTAL_CODE_FORMAT.expectation}`],
        rejected,
      });
      expect(http.calls).toHaveLength(0);
    });
    it.each<Record<string, unknown>>([
      { includeFormer: true },
      { parliament: 41 },
      { includeFormer: true, parliament: 41, riding: 'Ottawa' },
    ])('rejects postalCode with %j before any request', async (input) => {
      const result = await call({ postalCode: 'K1A 0A6', ...input });
      failure(result, searchMembersTool.errors![0]!);
      expect(result.structuredContent).toMatchObject({
        error: {
          message:
            'postalCode searches the current roster only, so it cannot be combined with includeFormer or parliament.',
        },
      });
      expect(http.calls).toHaveLength(0);
    });
    it.each<[string, (request: Request) => Response | Promise<Response>, number]>([
      [
        'HTTP 503 on every attempt',
        () => new Response('', { status: 503 }),
        JsonRpcErrorCode.ServiceUnavailable,
      ],
      [
        'malformed XML',
        () =>
          new Response(
            '<ArrayOfMemberOfParliament><MemberOfParliament><PersonId>x</PersonId></MemberOfParliament></ArrayOfMemberOfParliament>',
          ),
        JsonRpcErrorCode.SerializationError,
      ],
      [
        'a stalled response',
        (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            });
          }),
        JsonRpcErrorCode.Timeout,
      ],
    ])('fails the call on %s, never falling back to the roster', async (_case, respond, code) => {
      sitting();
      http.route({ match: postalLookupUrl('K1A0A6'), respond });
      const result = await call({ postalCode: 'K1A 0A6' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code } });
      expect(result.structuredContent).not.toHaveProperty('members');
      expect(new Set(urls())).toEqual(new Set([postalLookupUrl('K1A0A6')]));
    });
    it('names postal codes on the tool and calls province values abbreviations on both tools', () => {
      expect(searchMembersTool.description).toContain('postal code');
      expect(searchMembersTool.input.shape.postalCode.description).toContain('K1A 0A6');
      for (const description of [
        searchMembersTool.input.shape.province.description,
        getVoteTool.input.shape.province.description,
      ]) {
        expect(description).toContain('abbreviation');
        expect(description).not.toMatch(/postal/i);
      }
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
