/** @fileoverview Verified identities and independently bounded hydrated activity. @module tests/tools/get-member.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequestContext } from '@/domain/request-context.js';
import { getMemberTool } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { getOpenParliamentService } from '@/services/openparliament/index.js';
import {
  actor,
  collection,
  failure,
  json,
  origin,
  page,
  parity,
  profile,
  rawPerson,
  rosterUrl,
  setup,
  teardown,
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
  const candidates = (rows: unknown[], next: number | null = null) =>
    page(
      http,
      '/politicians/',
      { limit: 4, offset: 0, include: 'all', name: 'River Example' },
      rows,
      next,
    );
  const disabled = { sponsoredBills: 0, recentVotes: 0 };
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
        recentVotes: { status: 'unavailable', limit: 10 },
        notice: expect.stringContaining('No verified OpenParliament match'),
      });
      expect(http.calls).toHaveLength(
        2 + (['four', 'continuation'].includes(scenario) ? 0 : count),
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
  it.each([0, 20])(
    'keeps truly empty activity distinct from unavailable at offset %i',
    async (offset) => {
      json(http, actor, profile({ other_info: {}, image: null }));
      page(http, '/bills/', { limit: 5, offset, sponsor_politician: actor }, []);
      page(http, '/votes/ballots/', { limit: 10, offset, politician: actor }, []);
      const data = parity(
        await call({ slug: 'river-example', billsOffset: offset, votesOffset: offset }),
        getMemberTool,
      );
      expect(data).toMatchObject({
        sponsoredBills: { status: 'available', items: [], failure: null, nextOffset: null },
        recentVotes: { status: 'available', items: [], failure: null },
        notice: expect.stringContaining(offset ? 'billsOffset 0' : 'No activity was returned'),
      });
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
  it('completes the cold maximum 21 OpenParliament operations without scanning unrelated candidates', async () => {
    roster();
    candidates(
      [0, 1, 2].map((i) => ({ name: 'River Example', url: `/politicians/candidate-${i}/` })),
    );
    for (let i = 0; i < 3; i++)
      json(
        http,
        `/politicians/candidate-${i}/`,
        profile({
          url: `/politicians/candidate-${i}/`,
          other_info: { parl_mp_id: [i === 2 ? '1' : '99'] },
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
    page(
      http,
      '/votes/ballots/',
      { limit: 10, offset: 0, politician: selected },
      Array.from({ length: 10 }, (_, i) => ({ ...ballot(i + 1), politician_url: selected })),
    );
    for (let i = 1; i <= 10; i++) json(http, `/votes/45-1/${i}/`, vote(i));
    const data = parity(await call({ personId: '1' }), getMemberTool);
    expect(data).toMatchObject({
      shown: { sponsoredBills: 5, recentVotes: 10 },
      cap: { sponsoredBills: 5, recentVotes: 10 },
    });
    expect(http.calls.filter((c) => c.request.url.startsWith(origin))).toHaveLength(21);
  });
  it.each([
    {},
    { slug: '', personId: ' ' },
    { slug: 'river-example', personId: '1' },
    { personId: 'x' },
    { slug: 'https://evil.test/politicians/river-example/' },
  ])('returns declared identifier recovery %j', async (input) => {
    failure(await call(input), getMemberTool.errors![0]!);
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
  it('returns historical lookup recovery for a missing slug', async () => {
    http.route({ match: `${origin}${actor}`, respond: new Response('', { status: 404 }) });
    failure(await call({ slug: actor }), getMemberTool.errors![1]!);
  });
  it.each([
    { sponsoredBills: 6 },
    { sponsoredBills: -1 },
    { recentVotes: 11 },
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
});
