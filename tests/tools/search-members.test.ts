/** @fileoverview Current roster and sparse historical member contracts. @module tests/tools/search-members.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchMembersTool } from '@/mcp-server/tools/definitions/search-members.tool.js';
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
    ).toContain(`**${data.totalCount} total**`);
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
  });
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
  it.each([{ province: 'PQ' }, { province: 'Atlantis' }, { party: 'Imaginary' }])(
    'returns declared current-filter recovery %j',
    async (input) => {
      roster();
      failure(await call(input), searchMembersTool.errors![1]!);
    },
  );
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
  it.each([{ limit: 0 }, { limit: 101 }, { offset: -1 }])(
    'rejects invalid schema %j without network',
    async (input) => {
      expect((await call(input)).structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(http.calls).toHaveLength(0);
    },
  );
});
