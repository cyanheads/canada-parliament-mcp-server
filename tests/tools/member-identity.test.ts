/** @fileoverview Shared slug-input resolution through the verified current-member crosswalk. @module tests/tools/member-identity.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CallBudget, createRequestContext } from '@/domain/request-context.js';
import type { Source } from '@/domain/schemas.js';
import { resolvePolitician } from '@/mcp-server/tools/definitions/_member-identity.js';
import {
  actor,
  collection,
  json,
  origin,
  page,
  profile,
  rawPerson,
  rosterUrl,
  settle,
  setup,
  teardown,
} from '../fixtures/member-tools/harness.js';

const namePage = `${origin}/politicians/?limit=4&offset=0&include=all&name=River+Example`;

describe('resolvePolitician', () => {
  let http: ReturnType<typeof setup>;
  let budget: CallBudget;
  beforeEach(() => {
    http = setup();
    budget = createRequestContext(createMockContext());
  });
  afterEach(() => {
    budget.dispose();
    teardown(http);
  });
  const roster = (...ids: number[]) =>
    http.route({
      match: rosterUrl,
      respond: new Response(
        collection(
          'ArrayOfMemberOfParliament',
          'MemberOfParliament',
          ids.map((id) => rawPerson(id)),
        ),
      ),
    });
  const candidate = (personIds: string[]) => {
    page(http, '/politicians/', { limit: 4, offset: 0, include: 'all', name: 'River Example' }, [
      { name: 'River Example', url: actor },
    ]);
    json(http, actor, profile({ other_info: { parl_mp_id: personIds } }));
  };
  const resolve = async (slug: string) => {
    const provenance: Source[] = [];
    const resolved = await settle(resolvePolitician(slug, budget, provenance));
    return { resolved, provenance: provenance.map((source) => source.url) };
  };
  const urls = () => http.calls.map((c) => c.request.url);

  it('preserves a unique exact recorded-name and ID match before broadened profile matches', async () => {
    roster(2897);
    page(http, '/politicians/', { limit: 4, offset: 0, include: 'all', name: 'River Example' }, [
      { name: 'River Example', url: actor },
      { name: 'River Example', url: '/politicians/variant-example/' },
    ]);
    json(http, actor, profile({ other_info: { parl_mp_id: ['2897'] } }));
    json(
      http,
      '/politicians/variant-example/',
      profile({
        url: '/politicians/variant-example/',
        name: 'River A. Example',
        other_info: { parl_mp_id: ['2897'] },
      }),
    );
    expect((await resolve('2897')).resolved?.slug).toBe('river-example');
    expect(urls()).toHaveLength(4);
  });

  it('preserves a successful exact-name crosswalk when the same page contains an accent/initial variant', async () => {
    roster(2897);
    page(http, '/politicians/', { limit: 4, offset: 0, include: 'all', name: 'River Example' }, [
      { name: 'River Example', url: actor },
      { name: 'Rivér A. Example', url: '/politicians/variant-example/' },
    ]);
    json(http, actor, profile({ other_info: { parl_mp_id: ['2897'] } }));
    expect((await resolve('2897')).resolved?.slug).toBe('river-example');
    expect(urls()).toEqual([rosterUrl, namePage, `${origin}${actor}`]);
  });

  it.each([`André${' A.'.repeat(10_000)}`, 'André\nA.\nB.'])(
    'compares long and linebreak names without mutating published values',
    async (first) => {
      const name = `${first} Example`;
      http.route({
        match: rosterUrl,
        respond: new Response(
          collection('ArrayOfMemberOfParliament', 'MemberOfParliament', [
            rawPerson(2897, { PersonOfficialFirstName: first }),
          ]),
        ),
      });
      page(http, '/politicians/', { limit: 4, offset: 0, include: 'all', name }, [
        { name, url: actor },
      ]);
      json(http, actor, profile({ name, other_info: { parl_mp_id: ['2897'] } }));
      const { resolved } = await resolve('2897');
      expect(resolved?.name).toBe(name);
      expect(new URL(urls()[1]!).searchParams.get('name')).toBe(name);
      expect(urls()).toHaveLength(3);
    },
  );

  it.each([
    'empty',
    'four',
    'continuation',
    'single',
    'ambiguous',
    'wrong-id',
    'unrelated',
    'duplicate',
  ] as const)(
    'keeps surname discovery complete, unique, and ID-verified for %s',
    async (scenario) => {
      roster(2897);
      page(
        http,
        '/politicians/',
        { limit: 4, offset: 0, include: 'all', name: 'River Example' },
        [],
      );
      const count =
        scenario === 'empty' ? 0 : scenario === 'four' ? 4 : scenario === 'ambiguous' ? 2 : 1;
      const rows = Array.from({ length: count }, (_, i) => ({
        name: 'River Example',
        url: `/politicians/candidate-${i}/`,
      }));
      if (scenario === 'duplicate') rows.push(...rows);
      page(
        http,
        '/politicians/',
        { limit: 4, offset: 0, include: 'all', family_name: 'Example' },
        rows,
        scenario === 'continuation' ? 4 : null,
      );
      if (!['four', 'continuation', 'empty'].includes(scenario))
        for (let i = 0; i < count; i++)
          json(
            http,
            `/politicians/candidate-${i}/`,
            profile({
              url: `/politicians/candidate-${i}/`,
              name: scenario === 'unrelated' ? 'Different Person' : 'River Example',
              other_info: { parl_mp_id: [scenario === 'wrong-id' ? '1' : '2897'] },
            }),
          );
      const { resolved } = await resolve('2897');
      expect(resolved?.slug ?? null).toBe(
        ['duplicate', 'single'].includes(scenario) ? 'candidate-0' : null,
      );
      expect(urls()).toHaveLength(
        3 + (['four', 'continuation', 'empty'].includes(scenario) ? 0 : count),
      );
    },
  );

  it('stops before profile verification when two complete surname pages exceed three unique candidates', async () => {
    http.route({
      match: rosterUrl,
      respond: new Response(
        collection('ArrayOfMemberOfParliament', 'MemberOfParliament', [
          rawPerson(2897, { PersonOfficialLastName: 'Éxample' }),
        ]),
      ),
    });
    page(http, '/politicians/', { limit: 4, offset: 0, include: 'all', name: 'River Éxample' }, []);
    for (const [family_name, start] of [
      ['Éxample', 0],
      ['Example', 2],
    ] as const)
      page(
        http,
        '/politicians/',
        { limit: 4, offset: 0, include: 'all', family_name },
        [start, start + 1].map((i) => ({
          name: 'River Example',
          url: `/politicians/candidate-${i}/`,
        })),
      );
    expect((await resolve('2897')).resolved).toBeNull();
    expect(urls()).toHaveLength(4);
  });

  it('propagates cancellation in surname discovery without starting profile verification', async () => {
    budget.dispose();
    const caller = new AbortController();
    budget = createRequestContext(createMockContext({ signal: caller.signal }));
    roster(2897);
    page(http, '/politicians/', { limit: 4, offset: 0, include: 'all', name: 'River Example' }, []);
    http.route({
      match: `${origin}/politicians/?limit=4&offset=0&include=all&family_name=Example`,
      respond: () => {
        caller.abort();
        return Response.json({ objects: [], pagination: { offset: 0, limit: 4, next_url: null } });
      },
    });
    await expect(resolve('2897')).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(urls()).toHaveLength(3);
  });

  it.each<[string, string, string, string[], boolean]>([
    ['Judy A.', 'Sgro', 'Judy Sgro', ['judy a. sgro'], true],
    ['Alex', 'Tremblay', 'Alexandre Tremblay', ['Alex Tremblay'], true],
    ['Andre\u0301', 'Be\u0301langer', 'André Belanger', [], true],
    ['André', 'Bélanger', 'Andre Belanger', [], false],
  ])(
    'discovers and verifies %s %s through bounded surname pages',
    async (first, last, name, aliases, originalHasRow) => {
      http.route({
        match: rosterUrl,
        respond: new Response(
          collection('ArrayOfMemberOfParliament', 'MemberOfParliament', [
            rawPerson(1787, { PersonOfficialFirstName: first, PersonOfficialLastName: last }),
          ]),
        ),
      });
      page(
        http,
        '/politicians/',
        { limit: 4, offset: 0, include: 'all', name: `${first} ${last}` },
        [],
      );
      const params = { limit: 4, offset: 0, include: 'all' };
      const surname = last;
      page(
        http,
        '/politicians/',
        { ...params, family_name: surname },
        originalHasRow ? [{ name, url: actor }] : [],
      );
      if (surname !== 'Sgro' && surname !== 'Tremblay')
        page(http, '/politicians/', { ...params, family_name: 'Belanger' }, [{ name, url: actor }]);
      json(
        http,
        actor,
        profile({ name, other_info: { parl_mp_id: ['1787'], alternate_name: aliases } }),
      );
      const { resolved } = await resolve('1787');
      expect(resolved).toMatchObject({ name, slug: 'river-example', personIds: ['1787'] });
      expect(urls().filter((url) => url === `${origin}${actor}`)).toHaveLength(1);
      expect(urls()).toHaveLength(['Be\u0301langer', 'Bélanger'].includes(surname) ? 5 : 4);
    },
  );

  /** Case, input, routes, resolved slug, requested URLs, and how many of them were retrieved. */
  it.each<[string, string, () => void, string | null, string[], number]>([
    [
      'a current personId verified by the crosswalk',
      '2897',
      () => {
        roster(2897);
        candidate(['2897']);
      },
      'river-example',
      [rosterUrl, namePage, `${origin}${actor}`],
      3,
    ],
    [
      'a current personId with no verified profile',
      '2897',
      () => {
        roster(2897);
        candidate(['1']);
      },
      null,
      [rosterUrl, namePage, `${origin}${actor}`],
      3,
    ],
    [
      'a numeric OpenParliament ID absent from the roster',
      '5724',
      () => {
        roster(1);
        json(http, '/politicians/5724/', profile({ url: '/politicians/5724/' }));
      },
      '5724',
      [rosterUrl, `${origin}/politicians/5724/`],
      2,
    ],
    [
      'a numeric value answered by another canonical profile',
      '413',
      () => {
        roster(1);
        json(http, '/politicians/413/', profile({ url: '/politicians/other-example/' }));
      },
      null,
      [rosterUrl, `${origin}/politicians/413/`],
      1,
    ],
    [
      'a numeric value OpenParliament does not have',
      '99999999',
      () => {
        roster(1);
        http.route({
          match: `${origin}/politicians/99999999/`,
          respond: new Response('', { status: 404 }),
        });
      },
      null,
      [rosterUrl, `${origin}/politicians/99999999/`],
      1,
    ],
    [
      'a slug, without the roster',
      'river-example',
      () => json(http, actor, profile()),
      'river-example',
      [`${origin}${actor}`],
      1,
    ],
    [
      'a missing slug, without the roster',
      'river-example',
      () => http.route({ match: `${origin}${actor}`, respond: new Response('', { status: 404 }) }),
      null,
      [`${origin}${actor}`],
      0,
    ],
  ])('resolves %s', async (_case, slug, routes, expected, requested, retrieved) => {
    routes();
    const { resolved, provenance } = await resolve(slug);
    expect(resolved?.slug ?? null).toBe(expected);
    expect(urls()).toEqual(requested);
    expect(provenance).toEqual(requested.slice(0, retrieved));
  });
  it('fails on an unavailable roster before any OpenParliament request', async () => {
    http.route({ match: rosterUrl, respond: new Response('<broken/>') });
    await expect(resolve('2897')).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    expect(urls()).toEqual([rosterUrl]);
  });
  it('propagates a malformed crosswalk page instead of reporting no profile', async () => {
    roster(2897);
    http.route({ match: namePage, respond: Response.json({}) });
    await expect(resolve('2897')).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    expect(urls()).toEqual([rosterUrl, namePage]);
  });
  it('propagates caller cancellation during a slug lookup instead of reporting no profile', async () => {
    budget.dispose();
    const caller = new AbortController();
    budget = createRequestContext(createMockContext({ signal: caller.signal }));
    http.route({
      match: `${origin}${actor}`,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const outcome = resolvePolitician('river-example', budget, []).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(urls()).toEqual([`${origin}${actor}`]);
  });
});
