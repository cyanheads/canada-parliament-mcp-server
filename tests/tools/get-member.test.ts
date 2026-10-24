/** @fileoverview Verified identities and independently bounded hydrated activity. @module tests/tools/get-member.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequestContext } from '@/domain/request-context.js';
import { getMemberTool } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { getOpenParliamentService } from '@/services/openparliament/index.js';
import { assertFilterRejection, type FilterRejection } from '../fixtures/filter-rejection.js';
import {
  actor,
  collection,
  failure,
  json,
  lawrenceCannon,
  memberVotesUrl,
  origin,
  page,
  parity,
  profile,
  rawPerson,
  realMemberVotes,
  rosterUrl,
  setup,
  teardown,
  votePicker,
} from '../fixtures/member-tools/harness.js';

describe('canparl_get_member production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
  });
  afterEach(() => teardown(http));
  const call = async (input: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const pending = runToolContract(
      getMemberTool,
      input,
      signal ? { context: { signal } } : undefined,
    );
    await vi.advanceTimersByTimeAsync(44_000);
    return pending;
  };
  const roster = (rows = [rawPerson()]) =>
    http.route({
      match: rosterUrl,
      respond: new Response(collection('ArrayOfMemberOfParliament', 'MemberOfParliament', rows)),
    });
  const surnamePage = `${origin}/politicians/?limit=4&offset=0&include=all&family_name=Example`;
  const candidates = (rows: unknown[], next: number | null = null) => {
    if (rows.length === 0 && next === null)
      page(
        http,
        '/politicians/',
        { limit: 4, offset: 0, include: 'all', family_name: 'Example' },
        [],
      );
    return page(
      http,
      '/politicians/',
      { limit: 4, offset: 0, include: 'all', name: 'River Example' },
      rows,
      next,
    );
  };
  const disabled = { sponsoredBills: 0, recentVotes: 0 };
  it.each([{ personId: '1787' }, { slug: '1787' }])(
    'crosswalks the captured Judy Sgro name/alias/ID through %j on both surfaces',
    async (input) => {
      roster([
        rawPerson(1787, { PersonOfficialFirstName: 'Judy A.', PersonOfficialLastName: 'Sgro' }),
      ]);
      // Exact response and identity fields captured from OpenParliament on 2026-10-24.
      page(
        http,
        '/politicians/',
        { limit: 4, offset: 0, include: 'all', name: 'Judy A. Sgro' },
        [],
      );
      page(http, '/politicians/', { limit: 4, offset: 0, include: 'all', family_name: 'Sgro' }, [
        { name: 'Judy Sgro', url: '/politicians/judy-sgro/' },
      ]);
      json(http, '/politicians/judy-sgro/', {
        name: 'Judy Sgro',
        given_name: 'Judy',
        family_name: 'Sgro',
        gender: 'female',
        url: '/politicians/judy-sgro/',
        other_info: {
          parl_mp_id: ['1787'],
          alternate_name: ['judy sgro', 'the honourable judy sgro', 'judy a. sgro'],
        },
      });
      const data = parity(await call({ ...input, ...disabled }), getMemberTool);
      expect(data).toMatchObject({
        member: { personId: '1787', name: 'Judy A. Sgro', slug: 'judy-sgro' },
        openParliament: { status: 'available', reason: null },
        appliedFilters: { personId: '1787', slug: null },
      });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        rosterUrl,
        `${origin}/politicians/?limit=4&offset=0&include=all&name=Judy+A.+Sgro`,
        `${origin}/politicians/?limit=4&offset=0&include=all&family_name=Sgro`,
        `${origin}/politicians/judy-sgro/`,
      ]);
    },
  );
  const memberVotes = (personId: string, body: string, session?: string) =>
    http.route({ match: memberVotesUrl(personId, session), respond: () => new Response(body) });
  const bill = (number: number, detail = false) => ({
    url: `/bills/45-1/C-${number}/`,
    session: '45-1',
    number: `C-${number}`,
    name: { en: 'Act [one]\n# title', fr: 'Loi `deux`' },
    ...(detail ? { status: { en: 'At second reading' } } : {}),
  });
  const ballot = (number: number) => ({
    politician_url: actor,
    vote_url: `/votes/45-1/${number}/`,
    ballot: 'Yes',
  });
  const vote = (number: number) => ({
    url: `/votes/45-1/${number}/`,
    session: '45-1',
    number,
    date: '2026-10-19',
    description: { en: 'Motion\n[subject]' },
  });
  it('verifies exact full-name candidates against profile IDs and preserves historical depth', async () => {
    roster();
    candidates([
      { name: 'Different Name', url: '/politicians/other/' },
      { name: 'River Example', url: actor },
    ]);
    json(http, actor, profile());
    const data = parity(await call({ personId: ' 1 ', ...disabled }), getMemberTool);
    expect(data).toMatchObject({
      member: {
        personId: '1',
        slug: 'river-example',
        name: 'River Example',
        party: 'Liberal',
        current: true,
        gender: 'Nonbinary',
        imageUrl: 'https://images.example.test/portrait.png',
        links: [
          { url: 'https://example.test/profile?a=1&b=2', note: 'Public [site]\n`reference`' },
        ],
        detailLookup: { personId: '1' },
      },
      memberships: [
        {
          party: { name: 'Historical party', shortName: 'Past' },
          riding: 'Old riding',
          province: 'British Columbia',
          startDate: '2001-01-01',
          endDate: '2002-12-31',
          label: 'Historical\nlabel',
        },
        {
          url: 'https://openparliament.ca/politicians/memberships/12/',
          party: { name: 'Later party', shortName: 'Later' },
          riding: 'Later riding',
          province: 'Ontario',
          startDate: '2003-01-01',
          endDate: null,
          label: null,
        },
      ],
      openParliament: { status: 'available', reason: null },
      sponsoredBills: { status: 'not_requested', offset: 0, limit: 0 },
      recentVotes: { status: 'not_requested' },
      unavailable: [],
      shown: { sponsoredBills: 0, recentVotes: 0 },
      cap: disabled,
      truncated: { sponsoredBills: false, recentVotes: false },
    });
    expect(http.calls.map((c) => c.request.url)).toEqual([
      rosterUrl,
      `${origin}/politicians/?limit=4&offset=0&include=all&name=River+Example`,
      `${origin}${actor}`,
    ]);
  });
  it.each(['none', 'mismatch', 'multiple', 'four', 'continuation'] as const)(
    'retains official identity without guessing for %s',
    async (scenario) => {
      roster();
      const count =
        scenario === 'none' ? 0 : scenario === 'four' ? 4 : scenario === 'multiple' ? 2 : 1;
      const rows = Array.from({ length: count }, (_, i) => ({
        name: 'River Example',
        url: `/politicians/candidate-${i}/`,
      }));
      candidates(rows, scenario === 'continuation' ? 4 : null);
      if (scenario !== 'four' && scenario !== 'continuation')
        rows.forEach((row, i) => {
          json(
            http,
            row.url,
            profile({
              url: row.url,
              other_info: { parl_mp_id: [scenario === 'mismatch' ? '2' : '1'] },
              image: null,
              memberships: [],
              links: [],
              gender: null,
              name: 'River Example',
              given_name: String(i),
            }),
          );
        });
      memberVotes('1', realMemberVotes('empty'));
      const data = parity(await call({ personId: '1' }), getMemberTool);
      expect(data).toMatchObject({
        member: { personId: '1', slug: null, current: true },
        memberships: null,
        openParliament: { status: 'unavailable' },
        sponsoredBills: {
          status: 'unavailable',
          items: [],
          offset: 0,
          limit: 5,
          failure: { recovery: expect.stringContaining('canparl_search_bills') },
        },
        recentVotes: { status: 'available', items: [], limit: 10, failure: null },
        notice: expect.stringContaining('No verified OpenParliament match'),
      });
      expect(http.calls).toHaveLength(
        3 +
          (['four', 'continuation'].includes(scenario) ? 0 : count) +
          (scenario === 'none' ? 1 : 0),
      );
    },
  );
  it.each([true, false, null])(
    'determines slug currentness only from verified identity %j',
    async (current) => {
      json(
        http,
        actor,
        profile({
          other_info: current === null ? {} : { parl_mp_id: ['1'] },
          memberships: null,
          image: null,
          links: [],
          gender: null,
        }),
      );
      if (current !== null) roster(current ? [rawPerson()] : []);
      const data = parity(
        await call({ slug: `https://openparliament.ca${actor}`, personId: '', ...disabled }),
        getMemberTool,
      );
      expect(data).toMatchObject({
        member: { current, imageUrl: null, gender: null },
        memberships: null,
        unavailable: expect.arrayContaining([
          {
            section: 'memberships',
            failure: expect.objectContaining({ reason: 'membership_history_unavailable' }),
          },
        ]),
      });
      expect(http.calls).toHaveLength(current === null ? 1 : 2);
    },
  );
  it('hydrates independent activity pages and preserves actual detail status and subject', async () => {
    json(http, actor, profile({ other_info: {}, image: null }));
    page(
      http,
      '/bills/',
      { limit: 2, offset: 7, sponsor_politician: actor },
      [bill(2), bill(1)],
      12,
    );
    json(http, '/bills/45-1/C-2/', bill(2, true));
    json(http, '/bills/45-1/C-1/', bill(1));
    page(
      http,
      '/votes/ballots/',
      { limit: 2, offset: 9, politician: actor },
      [ballot(2), { ...ballot(2), ballot: "Didn't vote" }],
      15,
    );
    json(http, '/votes/45-1/2/', vote(2));
    const data = parity(
      await call({
        slug: actor,
        sponsoredBills: 2,
        billsOffset: 7,
        recentVotes: 2,
        votesOffset: 9,
      }),
      getMemberTool,
    );
    expect(data).toMatchObject({
      sponsoredBills: {
        status: 'available',
        offset: 7,
        limit: 2,
        nextOffset: 12,
        hasMore: true,
        failure: null,
        items: [
          {
            billCode: 'C-2',
            status: 'At second reading',
            title: { en: 'Act [one]\n# title', fr: 'Loi `deux`' },
          },
          { billCode: 'C-1', status: null },
        ],
      },
      recentVotes: {
        status: 'available',
        offset: 9,
        limit: 2,
        nextOffset: 15,
        items: [
          { number: 2, subject: 'Motion\n[subject]', date: '2026-10-19', ballot: 'Yes' },
          { ballot: "Didn't vote" },
        ],
      },
      shown: { sponsoredBills: 2, recentVotes: 2 },
      truncated: { sponsoredBills: true, recentVotes: true },
    });
    expect(http.calls.filter((c) => c.request.url === `${origin}/votes/45-1/2/`)).toHaveLength(1);
  });
  const someUnavailable =
    'Some optional enrichment is unavailable; inspect unavailable and section failure metadata before drawing historical conclusions.';
  const noActivity =
    'No activity was returned by this OpenParliament page; use canparl_search_bills or canparl_search_votes to inspect official records.';
  const pastEnd = 'Retry canparl_get_member with billsOffset 0 or votesOffset 0 for that section.';
  it.each<[number, number, string]>([
    [0, 0, `${someUnavailable} ${noActivity}`],
    [20, 20, `${someUnavailable} ${pastEnd}`],
    [20, 0, `${someUnavailable} ${noActivity} ${pastEnd}`],
  ])(
    'keeps truly empty activity distinct from unavailable at billsOffset %i and votesOffset %i',
    async (billsOffset, votesOffset, notice) => {
      json(http, actor, profile({ other_info: {}, image: null }));
      page(http, '/bills/', { limit: 5, offset: billsOffset, sponsor_politician: actor }, []);
      page(http, '/votes/ballots/', { limit: 10, offset: votesOffset, politician: actor }, []);
      const data = parity(
        await call({ slug: 'river-example', billsOffset, votesOffset }),
        getMemberTool,
      );
      expect(data).toMatchObject({
        sponsoredBills: { status: 'available', items: [], failure: null, nextOffset: null },
        recentVotes: { status: 'available', items: [], failure: null },
      });
      expect(data.notice).toBe(notice);
    },
  );
  it.each(['bills', 'votes'])(
    'discards a whole partially hydrated %s section while preserving the other',
    async (section) => {
      json(http, actor, profile({ other_info: {}, image: null }));
      page(http, '/bills/', { limit: 2, offset: 3, sponsor_politician: actor }, [bill(1), bill(2)]);
      json(http, '/bills/45-1/C-1/', bill(1, true));
      json(http, '/bills/45-1/C-2/', section === 'bills' ? {} : bill(2, true));
      page(http, '/votes/ballots/', { limit: 2, offset: 4, politician: actor }, [
        ballot(1),
        ballot(2),
      ]);
      json(http, '/votes/45-1/1/', vote(1));
      json(http, '/votes/45-1/2/', section === 'votes' ? {} : vote(2));
      const data = parity(
        await call({
          slug: 'river-example',
          sponsoredBills: 2,
          billsOffset: 3,
          recentVotes: 2,
          votesOffset: 4,
        }),
        getMemberTool,
      );
      expect(data[section === 'bills' ? 'sponsoredBills' : 'recentVotes']).toMatchObject({
        status: 'unavailable',
        items: [],
        offset: section === 'bills' ? 3 : 4,
        limit: 2,
        nextOffset: null,
        hasMore: false,
        failure: {
          reason: 'enrichment_unavailable',
          retryable: false,
          recovery: expect.stringContaining('returned identifier'),
        },
      });
      expect(data[section === 'bills' ? 'recentVotes' : 'sponsoredBills']).toMatchObject({
        status: 'available',
        items: expect.any(Array),
      });
    },
  );
  it('completes the cold maximum 10 OpenParliament operations, with ballots from one official request', async () => {
    roster([rawPerson(2897)]);
    candidates(
      [0, 1, 2].map((i) => ({ name: 'River Example', url: `/politicians/candidate-${i}/` })),
    );
    for (let i = 0; i < 3; i++)
      json(
        http,
        `/politicians/candidate-${i}/`,
        profile({
          url: `/politicians/candidate-${i}/`,
          other_info: { parl_mp_id: [i === 2 ? '2897' : '99'] },
          image: null,
        }),
      );
    const selected = '/politicians/candidate-2/';
    page(
      http,
      '/bills/',
      { limit: 5, offset: 0, sponsor_politician: selected },
      Array.from({ length: 5 }, (_, i) => bill(i + 1)),
    );
    for (let i = 1; i <= 5; i++) json(http, `/bills/45-1/C-${i}/`, bill(i, true));
    memberVotes('2897', realMemberVotes('2897-45-1'));
    const data = parity(await call({ personId: '2897' }), getMemberTool);
    expect(data).toMatchObject({
      shown: { sponsoredBills: 5, recentVotes: 10 },
      cap: { sponsoredBills: 5, recentVotes: 10 },
    });
    expect(data).not.toHaveProperty('notice');
    const urls = http.calls.map((c) => c.request.url);
    expect(urls.filter((url) => url.startsWith(origin))).toHaveLength(10);
    expect(urls.filter((url) => !url.startsWith(origin))).toEqual([
      rosterUrl,
      memberVotesUrl('2897'),
    ]);
  });
  it.each([
    [6, 11],
    [10_000, 10_000],
  ])(
    'clamps sponsoredBills %i and recentVotes %i to 5 and 10 rows before any request',
    async (sponsoredBills, recentVotes) => {
      json(http, actor, profile({ image: null, other_info: { parl_mp_id: ['2897'] } }));
      roster([rawPerson(2897)]);
      const billsPage = page(
        http,
        '/bills/',
        { limit: 5, offset: 0, sponsor_politician: actor },
        Array.from({ length: 5 }, (_, i) => bill(i + 1)),
        5,
      );
      for (let i = 1; i <= 5; i++) json(http, `/bills/45-1/C-${i}/`, bill(i, true));
      memberVotes('2897', realMemberVotes('2897-45-1'));
      const data = parity(await call({ slug: actor, sponsoredBills, recentVotes }), getMemberTool);
      expect(data).toMatchObject({
        sponsoredBills: { status: 'available', limit: 5, nextOffset: 5, hasMore: true },
        recentVotes: { status: 'available', limit: 10, nextOffset: 10, hasMore: true },
        appliedFilters: { sponsoredBills: 5, billsOffset: 0, recentVotes: 10, votesOffset: 0 },
        shown: { sponsoredBills: 5, recentVotes: 10 },
        cap: { sponsoredBills: 5, recentVotes: 10 },
        truncated: { sponsoredBills: true, recentVotes: true },
        notice: `sponsoredBills ${sponsoredBills} exceeds the per-call maximum of 5; returned up to 5. recentVotes ${recentVotes} exceeds the per-call maximum of 10; returned up to 10.`,
      });
      const urls = http.calls.map((c) => c.request.url);
      expect(urls.filter((url) => url.includes('/bills/'))).toEqual([
        billsPage,
        ...Array.from({ length: 5 }, (_, i) => `${origin}/bills/45-1/C-${i + 1}/`),
      ]);
      expect(urls.filter((url) => url.includes('/votes/'))).toEqual([memberVotesUrl('2897')]);
      expect(urls.filter((url) => url.startsWith(origin))).toHaveLength(7);
    },
  );
  it('clamps only the section over its cap and leaves the other unannounced', async () => {
    json(http, actor, profile({ image: null, other_info: { parl_mp_id: ['2897'] } }));
    roster([rawPerson(2897)]);
    page(http, '/bills/', { limit: 2, offset: 0, sponsor_politician: actor }, [bill(1)]);
    json(http, '/bills/45-1/C-1/', bill(1, true));
    memberVotes('2897', realMemberVotes('2897-45-1'));
    const data = parity(
      await call({ slug: actor, sponsoredBills: 2, recentVotes: 25 }),
      getMemberTool,
    );
    expect(data).toMatchObject({
      appliedFilters: { sponsoredBills: 2, recentVotes: 10 },
      cap: { sponsoredBills: 2, recentVotes: 10 },
      notice: 'recentVotes 25 exceeds the per-call maximum of 10; returned up to 10.',
    });
  });
  const exactlyOne = 'Expected exactly one of slug or personId';
  it.each<[Record<string, string>, FilterRejection]>([
    [{}, { field: 'slug|personId', rejected: '', shape: exactlyOne }],
    [
      { slug: '', personId: ' ' },
      { field: 'slug|personId', rejected: '', shape: exactlyOne },
    ],
    [
      { slug: 'river-example', personId: '1' },
      { field: 'slug|personId', rejected: 'river-example', shape: exactlyOne },
    ],
    [{ personId: 'x' }, { field: 'personId', rejected: '', shape: 'Expected a decimal' }],
    [{ personId: 'zzQ9' }, { field: 'personId', rejected: 'zzQ9', shape: 'Expected a decimal' }],
    [
      { slug: 'https://evil.test/politicians/river-example/' },
      {
        field: 'slug',
        rejected: 'evil.test',
        shape: 'Expected an OpenParliament politician slug',
      },
    ],
    [
      { slug: 'https://' },
      { field: 'slug', rejected: 'https://', shape: 'Expected an OpenParliament' },
    ],
  ])('returns declared identifier recovery %j', async (input, expected) => {
    const result = await call(input);
    failure(result, getMemberTool.errors![0]!);
    assertFilterRejection(result, expected);
    expect(http.calls).toHaveLength(0);
  });
  it('returns historical lookup recovery for an unknown official ID', async () => {
    roster([]);
    failure(await call({ personId: '9' }), getMemberTool.errors![1]!);
  });
  it('retains a slug profile while roster currentness is unavailable', async () => {
    json(http, actor, profile({ image: null }));
    http.route({ match: rosterUrl, respond: new Response('<broken/>') });
    const data = parity(await call({ slug: actor, ...disabled }), getMemberTool);
    expect(data).toMatchObject({
      member: { current: null, slug: 'river-example', personId: '1' },
      openParliament: { status: 'available' },
      unavailable: [
        {
          section: 'currentness',
          failure: {
            code: 'SerializationError',
            reason: 'enrichment_unavailable',
            retryable: false,
          },
        },
      ],
    });
  });
  it('does not assign currentness when several current IDs match one profile', async () => {
    json(http, actor, profile({ other_info: { parl_mp_id: ['1', '2'] }, image: null }));
    roster([rawPerson(1), rawPerson(2)]);
    const data = parity(await call({ slug: actor, ...disabled }), getMemberTool);
    expect(data).toMatchObject({
      member: { current: null, personId: null, detailLookup: { slug: 'river-example' } },
      unavailable: [
        { section: 'currentness', failure: { code: 'ServiceUnavailable', retryable: false } },
      ],
    });
  });
  it('propagates required malformed profile failures rather than inventing an official fallback', async () => {
    json(http, actor, {});
    const result = await call({ slug: actor, ...disabled });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.SerializationError } },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('malformed response'),
        }),
      ]),
    );
    expect(http.calls).toHaveLength(1);
  });
  it('preserves sparse activity detail and empty membership history without fabricating labels', async () => {
    json(
      http,
      actor,
      profile({ other_info: {}, memberships: [], image: null, links: [], gender: null }),
    );
    page(http, '/bills/', { limit: 1, offset: 0, sponsor_politician: actor }, [bill(1)]);
    json(http, '/bills/45-1/C-1/', { ...bill(1), name: {} });
    page(http, '/votes/ballots/', { limit: 1, offset: 0, politician: actor }, [
      { ...ballot(1), ballot: 'No' },
    ]);
    json(http, '/votes/45-1/1/', { ...vote(1), date: null, description: {} });
    const data = parity(
      await call({ slug: actor, sponsoredBills: 1, recentVotes: 1 }),
      getMemberTool,
    );
    expect(data).toMatchObject({
      memberships: [],
      sponsoredBills: { items: [{ title: { en: null, fr: null }, status: null }], hasMore: false },
      recentVotes: { items: [{ date: null, subject: null, ballot: 'No' }], hasMore: false },
    });
    expect(data.unavailable).toEqual([expect.objectContaining({ section: 'currentness' })]);
  });
  it('rejects a candidate profile with the correct ID but a different recorded name', async () => {
    roster();
    candidates([{ name: 'River Example', url: actor }]);
    json(http, actor, profile({ name: 'Different Person' }));
    const data = parity(await call({ personId: '1', ...disabled }), getMemberTool);
    expect(data).toMatchObject({
      member: { slug: null },
      openParliament: { status: 'unavailable' },
    });
    expect(http.calls).toHaveLength(3);
  });
  it('returns a real profile whose one link is http, relayed as published and rendered as text', async () => {
    json(http, '/politicians/lawrence-cannon/', lawrenceCannon());
    const result = await call({ slug: 'lawrence-cannon', ...disabled });
    const data = parity(result, getMemberTool);
    expect(data).toMatchObject({
      member: {
        personId: null,
        slug: 'lawrence-cannon',
        name: 'Lawrence Cannon',
        current: null,
        imageUrl: 'https://openparliament.ca/media/polpics/414.jpg',
        links: [{ url: 'http://www.lawrencecannon.com/', note: 'Official site' }],
      },
      memberships: [
        { riding: 'Pontiac', province: 'Quebec', label: 'Conservative MP for Pontiac' },
      ],
    });
    const [body] = result.content;
    expect(body?.type === 'text' ? body.text.split('\n') : []).toContain(
      '>>>> url: http://www.lawrencecannon.com/\\',
    );
    expect(http.calls.map((c) => c.request.url)).toEqual([
      `${origin}/politicians/lawrence-cannon/`,
    ]);
  });
  it('resolves relative and protocol-relative profile links against OpenParliament', async () => {
    json(
      http,
      actor,
      profile({
        other_info: {},
        links: [
          { url: '/members/relative-link/', note: null },
          { url: '//example-mp.test/home', note: 'Site' },
        ],
      }),
    );
    const result = await call({ slug: actor, ...disabled });
    expect(parity(result, getMemberTool)).toMatchObject({
      member: {
        links: [
          { url: 'https://openparliament.ca/members/relative-link/', note: null },
          { url: 'https://example-mp.test/home', note: 'Site' },
        ],
      },
    });
  });
  it('returns historical lookup recovery for a missing slug', async () => {
    http.route({ match: `${origin}${actor}`, respond: new Response('', { status: 404 }) });
    failure(await call({ slug: actor }), getMemberTool.errors![1]!);
  });
  const numericProfile = (id: string, extra: Record<string, unknown> = {}) =>
    profile({
      url: `/politicians/${id}/`,
      name: 'Numeric Example',
      other_info: {},
      memberships: [],
      image: null,
      links: [],
      gender: null,
      ...extra,
    });
  it('keeps a digit-only slug absent from the current roster as an OpenParliament ID', async () => {
    roster();
    json(http, '/politicians/5724/', numericProfile('5724'));
    const data = parity(await call({ slug: '5724', ...disabled }), getMemberTool);
    expect(data).toMatchObject({
      member: {
        personId: null,
        slug: '5724',
        name: 'Numeric Example',
        current: null,
        url: 'https://openparliament.ca/politicians/5724/',
        detailLookup: { slug: '5724' },
      },
      openParliament: { status: 'available', reason: null },
      appliedFilters: { slug: '5724', personId: null },
    });
  });
  it('reads a digit-only slug that is a current personId through the verified crosswalk', async () => {
    roster([rawPerson(2897)]);
    candidates([{ name: 'River Example', url: actor }]);
    json(http, actor, profile({ other_info: { parl_mp_id: ['2897'] } }));
    json(http, '/politicians/2897/', numericProfile('2897', { name: 'Unrelated Candidate' }));
    const data = parity(await call({ slug: ' 2897 ', ...disabled }), getMemberTool);
    expect(data).toMatchObject({
      member: {
        personId: '2897',
        slug: 'river-example',
        name: 'River Example',
        current: true,
        detailLookup: { personId: '2897' },
      },
      openParliament: { status: 'available', reason: null },
      appliedFilters: { slug: null, personId: '2897' },
      unavailable: [],
    });
    expect(http.calls.map((c) => c.request.url)).toEqual([
      rosterUrl,
      `${origin}/politicians/?limit=4&offset=0&include=all&name=River+Example`,
      `${origin}${actor}`,
    ]);
  });
  it.each([
    '/politicians/2897/',
    'https://openparliament.ca/politicians/2897/',
    'https://api.openparliament.ca/politicians/2897/',
  ])('reads slug %j, holding a current personId, through the verified crosswalk', async (slug) => {
    roster([rawPerson(2897)]);
    candidates([{ name: 'River Example', url: actor }]);
    json(http, actor, profile({ other_info: { parl_mp_id: ['2897'] } }));
    const data = parity(await call({ slug, ...disabled }), getMemberTool);
    expect(data).toMatchObject({
      member: { personId: '2897', slug: 'river-example', detailLookup: { personId: '2897' } },
      appliedFilters: { slug: null, personId: '2897' },
    });
    expect(http.calls.map((c) => c.request.url)).toEqual([
      rosterUrl,
      `${origin}/politicians/?limit=4&offset=0&include=all&name=River+Example`,
      `${origin}${actor}`,
    ]);
  });
  it('describes the slug personId reading and the profile link rule', () => {
    expect(getMemberTool.input.shape.slug.description).toBe(
      'Returned OpenParliament slug, politician path, or HTTPS OpenParliament profile URL; never a guessed name. A digit-only value equal to a current official personId, or its /politicians/<digits>/ path or profile URL, is read as that personId.',
    );
    expect(getMemberTool.output.shape.member.shape.links.element.shape.url.description).toBe(
      'Absolute http or https URL as published, or a relative value resolved against https://openparliament.ca; never fetched, and only https values render as links.',
    );
  });
  it('retains the official profile when a current personId slug has no verified crosswalk', async () => {
    roster([rawPerson(2897)]);
    candidates([]);
    const data = parity(await call({ slug: '2897', ...disabled }), getMemberTool);
    expect(data).toMatchObject({
      member: { personId: '2897', slug: null, current: true, detailLookup: { personId: '2897' } },
      memberships: null,
      openParliament: { status: 'unavailable', reason: 'enrichment_unavailable' },
      appliedFilters: { slug: null, personId: '2897' },
      unavailable: [
        {
          section: 'openParliament',
          failure: {
            code: 'ServiceUnavailable',
            reason: 'enrichment_unavailable',
            retryable: false,
          },
        },
      ],
      notice: expect.stringContaining('No verified OpenParliament match'),
    });
    expect(http.calls).toHaveLength(3);
  });
  it('reads the roster once, before OpenParliament, for a numeric slug and reuses it for currentness', async () => {
    roster();
    json(http, '/politicians/5724/', numericProfile('5724', { other_info: { parl_mp_id: ['9'] } }));
    const data = parity(await call({ slug: '5724', ...disabled }), getMemberTool);
    expect(data).toMatchObject({
      member: { slug: '5724', current: false, personId: '9', detailLookup: { slug: '5724' } },
      unavailable: [],
    });
    expect(http.calls.map((c) => c.request.url)).toEqual([
      rosterUrl,
      `${origin}/politicians/5724/`,
    ]);
    expect((data.provenance as { url: string }[]).map((source) => source.url)).toEqual([
      rosterUrl,
      `${origin}/politicians/5724/`,
    ]);
  });
  it.each(['413', '/politicians/413/'])(
    'returns historical lookup recovery when numeric slug %j answers with another canonical profile',
    async (slug) => {
      roster();
      json(http, '/politicians/413/', numericProfile('413', { url: actor }));
      failure(await call({ slug, ...disabled }), getMemberTool.errors![1]!);
      expect(http.calls.map((c) => c.request.url)).toEqual([
        rosterUrl,
        `${origin}/politicians/413/`,
      ]);
    },
  );
  it('fails a digit-only slug on an unavailable roster before any OpenParliament request', async () => {
    http.route({ match: rosterUrl, respond: new Response('<broken/>') });
    const result = await call({ slug: '2897', ...disabled });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.SerializationError } },
    });
    expect(http.calls.map((c) => c.request.url)).toEqual([rosterUrl]);
  });
  it.each([
    { sponsoredBills: 10_001 },
    { sponsoredBills: -1 },
    { recentVotes: 10_001 },
    { recentVotes: -1 },
    { billsOffset: -1 },
    { votesOffset: -1 },
  ])('rejects invalid activity bounds %j before HTTP', async (input) => {
    expect((await call({ slug: actor, ...input })).structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });
  it('propagates caller cancellation without converting it to optional unavailability', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await call({ personId: '1' }, controller.signal);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
    });
    expect(http.calls).toHaveLength(0);
  });
  it('aborts in-flight required profile I/O and starts no later enrichment', async () => {
    const controller = new AbortController();
    let aborted = false;
    http.route({
      match: `${origin}${actor}`,
      respond: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(request.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const pending = runToolContract(
      getMemberTool,
      { slug: actor },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringMatching(/cancel/i) }),
      ]),
    );
    expect(aborted).toBe(true);
    expect(http.calls).toHaveLength(1);
  });
  it('expires optional work at 45 seconds, discards partial hydration, and never starts later ballots', async () => {
    json(http, actor, profile({ other_info: {}, image: null }));
    page(
      http,
      '/bills/',
      { limit: 5, offset: 7, sponsor_politician: actor },
      Array.from({ length: 5 }, (_, i) => bill(i + 1)),
    );
    let aborted = false;
    for (let i = 1; i <= 5; i++)
      http.route({
        match: `${origin}/bills/45-1/C-${i}/`,
        respond: (request) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(Response.json(bill(i, true))), 9_000);
            request.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                aborted = true;
                reject(request.signal.reason);
              },
              { once: true },
            );
          }),
      });
    const pending = runToolContract(getMemberTool, {
      slug: actor,
      billsOffset: 7,
      votesOffset: 13,
    });
    await vi.advanceTimersByTimeAsync(45_001);
    const data = parity(await pending, getMemberTool);
    expect(data).toMatchObject({
      member: { slug: 'river-example' },
      sponsoredBills: {
        status: 'unavailable',
        items: [],
        offset: 7,
        limit: 5,
        nextOffset: null,
        failure: { code: 'Timeout', reason: 'enrichment_timeout' },
      },
      recentVotes: {
        status: 'unavailable',
        offset: 13,
        limit: 10,
        failure: { code: 'Timeout', reason: 'enrichment_timeout' },
      },
    });
    expect(aborted).toBe(true);
    expect(http.calls.some((c) => c.request.url.includes('/votes/ballots/'))).toBe(false);
  });
  it('expires queued optional hydration behind competing calls without partial activity or later dispatch', async () => {
    http.route({
      match: `${origin}${actor}`,
      respond: async () => {
        await new Promise((resolve) => setTimeout(resolve, 9_000));
        return Response.json(profile({ other_info: {}, image: null }));
      },
    });
    page(
      http,
      '/bills/',
      { limit: 5, offset: 7, sponsor_politician: actor },
      Array.from({ length: 5 }, (_, i) => bill(i + 1)),
    );
    for (let i = 1; i <= 5; i++)
      http.route({
        match: `${origin}/bills/45-1/C-${i}/`,
        respond: async () => {
          await new Promise((resolve) => setTimeout(resolve, 9_000));
          return Response.json(bill(i, true));
        },
      });
    const pending = runToolContract(getMemberTool, {
      slug: actor,
      billsOffset: 7,
      votesOffset: 13,
    });
    await vi.advanceTimersByTimeAsync(28_000);
    const competingBudget = createRequestContext(createMockContext());
    const competitors = Array.from({ length: 12 }, (_, i) => {
      const slug = `competitor-${i}`;
      json(
        http,
        `/politicians/${slug}/`,
        profile({ url: `/politicians/${slug}/`, other_info: {}, image: null }),
      );
      return getOpenParliamentService().getPolitician(slug, competingBudget);
    });
    const competingOutcomes = Promise.allSettled(competitors);
    try {
      await vi.advanceTimersByTimeAsync(17_001);
      const data = parity(await pending, getMemberTool);
      expect(data).toMatchObject({
        member: { slug: 'river-example' },
        sponsoredBills: {
          status: 'unavailable',
          items: [],
          offset: 7,
          limit: 5,
          nextOffset: null,
          hasMore: false,
          failure: {
            code: 'Timeout',
            reason: 'enrichment_timeout',
            retryable: true,
            recovery: expect.any(String),
          },
        },
        recentVotes: {
          status: 'unavailable',
          items: [],
          offset: 13,
          limit: 10,
          failure: { code: 'Timeout', reason: 'enrichment_timeout' },
        },
      });
      const ownUrls = () =>
        http.calls.map((c) => c.request.url).filter((url) => !url.includes('competitor-'));
      expect(ownUrls()).toEqual([
        `${origin}${actor}`,
        `${origin}/bills/?limit=5&offset=7&sponsor_politician=%2Fpoliticians%2Friver-example%2F`,
        `${origin}/bills/45-1/C-1/`,
        `${origin}/bills/45-1/C-2/`,
      ]);
      expect(http.calls.some((c) => c.request.url.includes('competitor-'))).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      await competingOutcomes;
      expect(ownUrls()).toHaveLength(4);
    } finally {
      competingBudget.dispose();
    }
  });

  describe('official member ballots', () => {
    type Row = Record<string, unknown> & { number: number };
    type Section = { items: Row[] } & Record<string, unknown>;
    const reason = (name: string) => getMemberTool.errors!.find((entry) => entry.reason === name)!;
    const division = (number: number) =>
      `https://www.ourcommons.ca/Members/en/votes/45/1/${number}`;
    const official179 = {
      session: '45-1',
      number: 179,
      date: '2026-10-20',
      subject: 'Opposition Motion (Affordability crisis)',
      ballot: 'Yes',
      url: division(179),
      source: 'ourcommons',
      officialBallot: 'Yea',
      billCode: null,
      result: 'Negatived',
    };
    const official178 = {
      session: '45-1',
      number: 178,
      date: '2026-10-08',
      subject:
        '2nd reading of Bill C-39, An Act respecting certain measures to strengthen the economy',
      ballot: 'No',
      url: division(178),
      source: 'ourcommons',
      officialBallot: 'Nay',
      billCode: 'C-39',
      result: 'Agreed To',
    };
    const sessions = () =>
      http.route({
        match: votePicker,
        respond: () =>
          new Response(
            ['45-1', '44-1']
              .map((value) => `<a data-input="parlSession" data-value="${value}">${value}</a>`)
              .join(''),
          ),
      });
    /** Current member 2897 without a verified crosswalk, so only official ballots are read. */
    const officialOnly = (body = realMemberVotes('2897-45-1'), session?: string) => {
      roster([rawPerson(2897)]);
      candidates([]);
      memberVotes('2897', body, session);
    };
    const namePage = `${origin}/politicians/?limit=4&offset=0&include=all&name=River+Example`;
    const numbers = (data: Record<string, unknown>) =>
      (data.recentVotes as Section).items.map((row) => row.number);
    const emptyNotice =
      "No official ballots matched; the member-votes feed covers one session, the member's latest unless votesSession names another, so change votesSession or remove votesBillCode and retry canparl_get_member, or use canparl_search_votes.";
    /** Notices every officialOnly call carries: no crosswalk, so OpenParliament is unavailable. */
    const officialOnlyNotice = `No verified OpenParliament match is available; retain the official profile and use canparl_search_members with includeFormer true to inspect named candidates. ${someUnavailable}`;
    /** The real feed with division 176 listed ahead of 177 at 177's date-time: only the number orders them. */
    const tied = (() => {
      const rows = realMemberVotes('2897-45-1').split('</MemberVote>');
      const at = rows.findIndex((row) => row.includes('<DecisionDivisionNumber>177<'));
      const [row177 = '', row176 = ''] = rows.slice(at, at + 2);
      const time = (row: string) => /<DecisionEventDateTime>([^<]+)</.exec(row)?.[1] ?? '';
      rows.splice(at, 2, row176.replace(time(row176), time(row177)), row177);
      return rows.join('</MemberVote>');
    })();

    it('replaces OpenParliament ballot hydration with one official request at default limits', async () => {
      roster([rawPerson(2897)]);
      candidates([{ name: 'River Example', url: actor }]);
      json(http, actor, profile({ other_info: { parl_mp_id: ['2897'] }, image: null }));
      page(
        http,
        '/bills/',
        { limit: 5, offset: 0, sponsor_politician: actor },
        Array.from({ length: 5 }, (_, i) => bill(i + 1)),
      );
      for (let i = 1; i <= 5; i++) json(http, `/bills/45-1/C-${i}/`, bill(i, true));
      memberVotes('2897', realMemberVotes('2897-45-1'));
      const data = parity(await call({ personId: '2897' }), getMemberTool);
      const section = data.recentVotes as Section;
      expect(section).toMatchObject({
        status: 'available',
        offset: 0,
        limit: 10,
        total: null,
        nextOffset: 10,
        hasMore: true,
        failure: null,
      });
      expect(section.items[0]).toEqual(official179);
      expect(section.items[1]).toEqual(official178);
      expect(numbers(data)).toEqual([179, 178, 177, 176, 175, 174, 173, 172, 171, 170]);
      expect(data).toMatchObject({
        appliedFilters: {
          recentVotes: 10,
          votesOffset: 0,
          votesSession: '45-1',
          votesBillCode: null,
        },
        shown: { sponsoredBills: 5, recentVotes: 10 },
        truncated: { sponsoredBills: false, recentVotes: true },
        unavailable: [],
      });
      expect(data.provenance).toContainEqual(
        expect.objectContaining({
          source: 'ourcommons',
          url: memberVotesUrl('2897'),
          cached: false,
        }),
      );
      expect(http.calls.map((c) => c.request.url)).toEqual([
        rosterUrl,
        namePage,
        `${origin}${actor}`,
        memberVotesUrl('2897'),
        `${origin}/bills/?limit=5&offset=0&sponsor_politician=%2Fpoliticians%2Friver-example%2F`,
        ...Array.from({ length: 5 }, (_, i) => `${origin}/bills/45-1/C-${i + 1}/`),
      ]);
    });
    it.each<[number, number[], number | null]>([
      [0, [179, 178, 177, 176, 175, 174, 173, 172, 171, 170], 10],
      [10, [169, 158, 159, 146, 147, 130, 131, 82, 81, 80], 20],
      [20, [79, 78, 77, 75, 53], null],
      [25, [], null],
    ])(
      'orders by date-time then number and pages locally at votesOffset %i',
      async (votesOffset, expected, nextOffset) => {
        officialOnly(tied);
        const data = parity(
          await call({ personId: '2897', sponsoredBills: 0, votesOffset }),
          getMemberTool,
        );
        expect(numbers(data)).toEqual(expected);
        expect(data.recentVotes).toMatchObject({
          status: 'available',
          offset: votesOffset,
          limit: 10,
          total: null,
          nextOffset,
          hasMore: nextOffset !== null,
          failure: null,
        });
        expect(data).toMatchObject({
          shown: { recentVotes: expected.length },
          truncated: { recentVotes: nextOffset !== null },
        });
        expect(data.notice).toBe(
          expected.length ? officialOnlyNotice : `${officialOnlyNotice} ${pastEnd}`,
        );
        expect(http.calls.map((c) => c.request.url)).toEqual([
          rosterUrl,
          namePage,
          surnamePage,
          memberVotesUrl('2897'),
        ]);
      },
    );
    it.each(['c15', 'bill C-15', 'C 15'])(
      'keeps only C-15 ballots for votesBillCode %j, never unlinked rows',
      async (votesBillCode) => {
        officialOnly();
        const data = parity(
          await call({ personId: '2897', sponsoredBills: 0, votesBillCode }),
          getMemberTool,
        );
        expect(numbers(data)).toEqual([82, 81, 80, 79, 78, 77, 75, 53]);
        expect((data.recentVotes as Section).items.every((row) => row.billCode === 'C-15')).toBe(
          true,
        );
        expect(data).toMatchObject({
          recentVotes: { nextOffset: null, hasMore: false },
          appliedFilters: { votesBillCode: 'C-15', votesSession: '45-1' },
        });
      },
    );
    it.each<[string, number, string]>([
      ['C-15', 10, `${officialOnlyNotice} ${pastEnd}`],
      ['C-9999', 10, `${officialOnlyNotice} ${emptyNotice}`],
      ['C-9999', 0, `${officialOnlyNotice} ${emptyNotice}`],
    ])(
      'states no match only for an empty filtered set: votesBillCode %s at votesOffset %i',
      async (votesBillCode, votesOffset, notice) => {
        officialOnly();
        const data = parity(
          await call({ personId: '2897', sponsoredBills: 0, votesBillCode, votesOffset }),
          getMemberTool,
        );
        expect(data).toMatchObject({
          recentVotes: { status: 'available', items: [], nextOffset: null, hasMore: false },
          appliedFilters: { votesBillCode, votesOffset },
        });
        expect(data.notice).toBe(notice);
      },
    );
    it('returns an available empty section with recovery when no ballot matches the bill', async () => {
      officialOnly();
      const data = parity(
        await call({ personId: '2897', sponsoredBills: 0, votesBillCode: 'C-9999' }),
        getMemberTool,
      );
      expect(data).toMatchObject({
        recentVotes: { status: 'available', items: [], nextOffset: null, failure: null },
        appliedFilters: { votesBillCode: 'C-9999', votesSession: '45-1' },
        notice: expect.stringContaining(emptyNotice),
      });
      expect(data.notice).not.toContain('OpenParliament page');
    });
    it('keeps a nil official date-time as a null date, ordered after dated ballots', async () => {
      officialOnly(
        realMemberVotes('2897-45-1').replace(
          '<DecisionEventDateTime>2026-10-20T15:15:00</DecisionEventDateTime>',
          '<DecisionEventDateTime xsi:nil="true" />',
        ),
      );
      const data = parity(
        await call({ personId: '2897', sponsoredBills: 0, votesOffset: 20 }),
        getMemberTool,
      );
      expect(numbers(data)).toEqual([78, 77, 75, 53, 179]);
      expect((data.recentVotes as Section).items.at(-1)).toEqual({ ...official179, date: null });
    });
    it('returns an available empty section and a null session for an empty feed', async () => {
      officialOnly(realMemberVotes('empty'));
      const data = parity(await call({ personId: '2897', sponsoredBills: 0 }), getMemberTool);
      expect(data).toMatchObject({
        recentVotes: { status: 'available', items: [], nextOffset: null, hasMore: false },
        appliedFilters: { votesSession: null, votesBillCode: null },
        notice: expect.stringContaining(emptyNotice),
      });
    });
    it.each<[string | { parliament: number; session: number }]>([
      ['44-1'],
      [{ parliament: 44, session: 1 }],
    ])('reads verified votesSession %j', async (votesSession) => {
      sessions();
      officialOnly(realMemberVotes('2897-44-1'), '44-1');
      const data = parity(
        await call({ personId: '2897', sponsoredBills: 0, votesSession }),
        getMemberTool,
      );
      expect(numbers(data)).toEqual([925, 924, 918]);
      expect((data.recentVotes as Section).items[0]).toEqual({
        session: '44-1',
        number: 925,
        date: '2024-12-12',
        subject: 'Ninth report of the Standing Committee on Veterans',
        ballot: 'Yes',
        url: 'https://www.ourcommons.ca/Members/en/votes/44/1/925',
        source: 'ourcommons',
        officialBallot: 'Yea',
        billCode: null,
        result: 'Agreed To',
      });
      expect(data).toMatchObject({ appliedFilters: { votesSession: '44-1' } });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        rosterUrl,
        namePage,
        surnamePage,
        votePicker,
        memberVotesUrl('2897', '44-1'),
      ]);
    });
    it('relays official Paired ballots unchanged in both vocabularies', async () => {
      sessions();
      roster([rawPerson(88721)]);
      candidates([]);
      memberVotes('88721', realMemberVotes('88721-45-1'), '45-1');
      const data = parity(
        await call({ personId: '88721', sponsoredBills: 0, votesSession: '45-1' }),
        getMemberTool,
      );
      expect(
        (data.recentVotes as Section).items.map(({ number, ballot, officialBallot, billCode }) => ({
          number,
          ballot,
          officialBallot,
          billCode,
        })),
      ).toEqual([
        { number: 54, ballot: 'Paired', officialBallot: 'Paired', billCode: null },
        { number: 53, ballot: 'Paired', officialBallot: 'Paired', billCode: 'C-15' },
        { number: 52, ballot: 'Yes', officialBallot: 'Yea', billCode: 'C-241' },
      ]);
    });
    it('fails a votesSession absent from the divisions picker before reading ballots', async () => {
      sessions();
      roster([rawPerson(2897)]);
      candidates([]);
      const result = await call({ personId: '2897', sponsoredBills: 0, votesSession: '39-1' });
      failure(result, reason('unsupported_vote_session'));
      assertFilterRejection(result, {
        field: 'votesSession',
        rejected: '39-1',
        allowed: ['45-1', '44-1'],
        shape: 'Expected a session in the official House division session index',
      });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        rosterUrl,
        namePage,
        surnamePage,
        votePicker,
      ]);
    });
    it.each<[Record<string, unknown>, string, FilterRejection]>([
      [
        { votesSession: '45-0' },
        'unsupported_vote_session',
        { field: 'votesSession', rejected: '', shape: 'Expected a parliament-session token' },
      ],
      [
        { votesBillCode: 'C-015' },
        'invalid_vote_filter',
        {
          field: 'votesBillCode',
          rejected: 'C-015',
          shape: 'Expected a House or Senate bill code',
        },
      ],
    ])('rejects malformed %j before any request', async (input, name, expected) => {
      const result = await call({ personId: '2897', ...input });
      failure(result, reason(name));
      assertFilterRejection(result, expected);
      expect(http.calls).toHaveLength(0);
    });
    it("reads a former member's latest session through a slug with one parl_mp_id", async () => {
      json(http, actor, profile({ other_info: { parl_mp_id: ['35933'] }, image: null }));
      roster([rawPerson(2897)]);
      memberVotes('35933', realMemberVotes('35933-latest'));
      const data = parity(await call({ slug: actor, sponsoredBills: 0 }), getMemberTool);
      expect(data).toMatchObject({
        member: { personId: '35933', slug: 'river-example', current: false },
        appliedFilters: { slug: 'river-example', personId: null, votesSession: '41-2' },
        unavailable: [],
      });
      expect(numbers(data)).toEqual([467, 466, 465]);
      expect((data.recentVotes as Section).items[0]).toMatchObject({
        session: '41-2',
        date: '2015-06-18',
        ballot: 'Yes',
        billCode: 'S-2',
        url: 'https://www.ourcommons.ca/Members/en/votes/41/2/467',
      });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        `${origin}${actor}`,
        rosterUrl,
        memberVotesUrl('35933'),
      ]);
    });
    it('marks only recentVotes unavailable when the official feed is malformed', async () => {
      roster([rawPerson(2897)]);
      candidates([{ name: 'River Example', url: actor }]);
      json(http, actor, profile({ other_info: { parl_mp_id: ['2897'] }, image: null }));
      page(http, '/bills/', { limit: 1, offset: 0, sponsor_politician: actor }, [bill(1)]);
      json(http, '/bills/45-1/C-1/', bill(1, true));
      memberVotes('2897', realMemberVotes('2897-45-1').replace('<PersonId>2897', '<PersonId>2898'));
      const data = parity(await call({ personId: '2897', sponsoredBills: 1 }), getMemberTool);
      expect(data).toMatchObject({
        member: { personId: '2897', slug: 'river-example', current: true },
        openParliament: { status: 'available' },
        sponsoredBills: { status: 'available', items: [{ billCode: 'C-1' }] },
        recentVotes: {
          status: 'unavailable',
          items: [],
          offset: 0,
          limit: 10,
          nextOffset: null,
          hasMore: false,
          failure: {
            code: 'SerializationError',
            reason: 'enrichment_unavailable',
            retryable: false,
            recovery: expect.stringContaining('canparl_search_votes'),
          },
        },
        unavailable: [
          {
            section: 'recentVotes',
            failure: expect.objectContaining({ code: 'SerializationError' }),
          },
        ],
        appliedFilters: { votesSession: null },
      });
      expect(http.calls.filter((c) => c.request.url === memberVotesUrl('2897'))).toHaveLength(1);
    });
    it('propagates caller cancellation during the official request', async () => {
      const controller = new AbortController();
      roster([rawPerson(2897)]);
      candidates([]);
      http.route({
        match: memberVotesUrl('2897'),
        respond: (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            });
            controller.abort();
          }),
      });
      const result = await call({ personId: '2897' }, controller.signal);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
      });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        rosterUrl,
        namePage,
        surnamePage,
        memberVotesUrl('2897'),
      ]);
    });
    it('labels OpenParliament ballots for a member without one official personId', async () => {
      json(http, actor, profile({ other_info: {}, image: null }));
      page(http, '/votes/ballots/', { limit: 10, offset: 0, politician: actor }, [ballot(1)]);
      json(http, '/votes/45-1/1/', { ...vote(1), result: 'Passed' });
      const data = parity(await call({ slug: actor, sponsoredBills: 0 }), getMemberTool);
      expect((data.recentVotes as Section).items).toEqual([
        {
          session: '45-1',
          number: 1,
          date: '2026-10-19',
          subject: 'Motion\n[subject]',
          ballot: 'Yes',
          url: 'https://openparliament.ca/votes/45-1/1/',
          source: 'openparliament',
          officialBallot: null,
          billCode: null,
          result: 'Passed',
        },
      ]);
      expect(data).toMatchObject({ appliedFilters: { votesSession: null, votesBillCode: null } });
    });
    it.each([
      [{ votesSession: '45-1' }, { votesSession: '45-1', votesBillCode: null }],
      [{ votesBillCode: 'c15' }, { votesSession: null, votesBillCode: 'C-15' }],
    ])(
      'marks recentVotes unavailable for official filters %j without one official personId',
      async (input, applied) => {
        json(http, actor, profile({ other_info: { parl_mp_id: ['1', '2'] }, image: null }));
        roster([]);
        const data = parity(
          await call({ slug: actor, sponsoredBills: 0, ...input }),
          getMemberTool,
        );
        expect(data).toMatchObject({
          member: { personId: null },
          recentVotes: {
            status: 'unavailable',
            items: [],
            failure: {
              code: 'ServiceUnavailable',
              reason: 'official_identity_unavailable',
              retryable: false,
            },
          },
          appliedFilters: applied,
          notice: expect.stringContaining(
            'votesSession and votesBillCode filter official ballots, which need one official personId; this member has none, so remove them to read OpenParliament ballots.',
          ),
        });
        expect(http.calls.map((c) => c.request.url)).toEqual([`${origin}${actor}`, rosterUrl]);
      },
    );
  });
});
