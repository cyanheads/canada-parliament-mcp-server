/** @fileoverview Shared slug-input resolution through the verified current-member crosswalk, and the former-member disclosure. @module tests/tools/member-identity.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CallBudget, createRequestContext } from '@/domain/request-context.js';
import type { Source } from '@/domain/schemas.js';
import {
  findFormerMember,
  formerMemberNotice,
  formerMemberRecovery,
  resolvePolitician,
} from '@/mcp-server/tools/definitions/_member-identity.js';
import type { PoliticianProfile } from '@/services/openparliament/index.js';
import {
  actor,
  collection,
  json,
  origin,
  page,
  parliamentRosterUrl,
  profile,
  rawPerson,
  realRoster,
  rosterUrl,
  settle,
  setup,
  teardown,
} from '../fixtures/member-tools/harness.js';

const namePage = `${origin}/politicians/?limit=4&offset=0&include=all&name=River+Example`;
const everyoneUrl = parliamentRosterUrl('*');

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
    const resolution = await settle(resolvePolitician(slug, budget, provenance));
    return {
      resolved: resolution.profile,
      former: resolution.formerMember,
      provenance: provenance.map((source) => source.url),
    };
  };
  /** The captured all-Parliaments roster: former 192 Coderre and 1463 Abbott, sitting 72029 Albas. */
  const everyone = () =>
    http.route({ match: everyoneUrl, respond: new Response(realRoster('all')) });
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

  /**
   * Case, input, routes, resolved slug, former member named, requested URLs, and the retrieved ones.
   * A digit-only value read as an OpenParliament ID reads the all-Parliaments roster unless the
   * resolved profile lists those digits; current personIds and slugs never do.
   */
  it.each<[string, string, () => void, string | null, string | null, string[], string[]]>([
    [
      'a current personId verified by the crosswalk',
      '2897',
      () => {
        roster(2897);
        candidate(['2897']);
      },
      'river-example',
      null,
      [rosterUrl, namePage, `${origin}${actor}`],
      [rosterUrl, namePage, `${origin}${actor}`],
    ],
    [
      'a current personId with no verified profile',
      '2897',
      () => {
        roster(2897);
        candidate(['1']);
      },
      null,
      null,
      [rosterUrl, namePage, `${origin}${actor}`],
      [rosterUrl, namePage, `${origin}${actor}`],
    ],
    [
      'a numeric OpenParliament ID absent from both rosters',
      '5724',
      () => {
        roster(1);
        everyone();
        json(http, '/politicians/5724/', profile({ url: '/politicians/5724/' }));
      },
      '5724',
      null,
      [rosterUrl, `${origin}/politicians/5724/`, everyoneUrl],
      [rosterUrl, `${origin}/politicians/5724/`, everyoneUrl],
    ],
    [
      'a numeric OpenParliament ID whose profile lists its own digits',
      '5724',
      () => {
        roster(1);
        json(
          http,
          '/politicians/5724/',
          profile({ url: '/politicians/5724/', other_info: { parl_mp_id: ['5724'] } }),
        );
      },
      '5724',
      null,
      [rosterUrl, `${origin}/politicians/5724/`],
      [rosterUrl, `${origin}/politicians/5724/`],
    ],
    [
      // Denis Coderre's official personId 192 is another politician's numeric OpenParliament ID.
      'a former personId, which keeps its OpenParliament meaning and names the former member',
      '192',
      () => {
        roster(1);
        everyone();
        json(http, '/politicians/192/', profile({ url: '/politicians/192/' }));
      },
      '192',
      'Denis Coderre',
      [rosterUrl, `${origin}/politicians/192/`, everyoneUrl],
      [rosterUrl, `${origin}/politicians/192/`, everyoneUrl],
    ],
    [
      'a former personId OpenParliament does not have',
      '1463',
      () => {
        roster(1);
        everyone();
        http.route({
          match: `${origin}/politicians/1463/`,
          respond: new Response('', { status: 404 }),
        });
      },
      null,
      'Jim Abbott',
      [rosterUrl, `${origin}/politicians/1463/`, everyoneUrl],
      [rosterUrl, everyoneUrl],
    ],
    [
      // Dan Albas sits; the synthetic current roster lacks him, so the two rosters disagree.
      'a value whose all-Parliaments row still reads as sitting, naming no one',
      '72029',
      () => {
        roster(1);
        everyone();
        json(http, '/politicians/72029/', profile({ url: '/politicians/72029/' }));
      },
      '72029',
      null,
      [rosterUrl, `${origin}/politicians/72029/`, everyoneUrl],
      [rosterUrl, `${origin}/politicians/72029/`, everyoneUrl],
    ],
    [
      'a numeric value answered by another canonical profile',
      '413',
      () => {
        roster(1);
        everyone();
        json(http, '/politicians/413/', profile({ url: '/politicians/other-example/' }));
      },
      null,
      null,
      [rosterUrl, `${origin}/politicians/413/`, everyoneUrl],
      [rosterUrl, everyoneUrl],
    ],
    [
      'a numeric value OpenParliament does not have',
      '99999999',
      () => {
        roster(1);
        everyone();
        http.route({
          match: `${origin}/politicians/99999999/`,
          respond: new Response('', { status: 404 }),
        });
      },
      null,
      null,
      [rosterUrl, `${origin}/politicians/99999999/`, everyoneUrl],
      [rosterUrl, everyoneUrl],
    ],
    [
      'a slug, without the roster',
      'river-example',
      () => json(http, actor, profile()),
      'river-example',
      null,
      [`${origin}${actor}`],
      [`${origin}${actor}`],
    ],
    [
      'a missing slug, without the roster',
      'river-example',
      () => http.route({ match: `${origin}${actor}`, respond: new Response('', { status: 404 }) }),
      null,
      null,
      [`${origin}${actor}`],
      [],
    ],
  ])('resolves %s', async (_case, slug, routes, expected, former, requested, retrieved) => {
    routes();
    const resolution = await resolve(slug);
    expect(resolution.resolved?.slug ?? null).toBe(expected);
    expect(resolution.former?.name ?? null).toBe(former);
    expect(urls()).toEqual(requested);
    expect(resolution.provenance).toEqual(retrieved);
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

describe('former-member disclosure', () => {
  let http: ReturnType<typeof setup>;
  let budget: CallBudget;
  let caller: AbortController;
  beforeEach(() => {
    http = setup();
    caller = new AbortController();
    budget = createRequestContext(createMockContext({ signal: caller.signal }));
  });
  afterEach(() => {
    budget.dispose();
    teardown(http);
  });
  const numericProfile = '/politicians/192/';
  /** Current roster without 192, and 192 answered by an unrelated numeric OpenParliament profile. */
  const primary = () => {
    http.route({
      match: rosterUrl,
      respond: new Response(
        collection('ArrayOfMemberOfParliament', 'MemberOfParliament', [rawPerson(1)]),
      ),
    });
    json(http, numericProfile, profile({ url: numericProfile }));
  };
  const reads = () => http.calls.filter((c) => c.request.url === everyoneUrl).length;
  const resolve192 = async () => {
    const provenance: Source[] = [];
    const resolution = await settle(resolvePolitician('192', budget, provenance));
    return { ...resolution, provenance: provenance.map((source) => source.url) };
  };

  /** The captured all-Parliaments roster through Denis Coderre's whole row, ending between rows. */
  const head = () => {
    const all = realRoster('all');
    const close = '</MemberOfParliament>';
    return all.slice(0, all.indexOf(close, all.indexOf('<PersonId>192</PersonId>')) + close.length);
  };
  /** That head, then a connection reset before the rest of the body. */
  const reset = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head()));
          controller.error(new TypeError('terminated'));
        },
      }),
    );
  it.each<[string, () => Response | Promise<Response>]>([
    ['HTTP 403', () => new Response('<html>refused</html>', { status: 403 })],
    ['HTTP 404', () => new Response('', { status: 404 })],
    ['HTTP 429 on every attempt', () => new Response('', { status: 429 })],
    ['HTTP 500', () => new Response('', { status: 500 })],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    [
      'a bot-check HTML page served with 200 on every attempt',
      () =>
        new Response(
          '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>',
        ),
    ],
    ['a body that ends mid-document', () => new Response(head())],
    ['a body reset mid-stream on every attempt', reset],
    ['malformed XML', () => new Response('<broken/>')],
    ['an empty roster', () => new Response(realRoster('empty'))],
  ])('keeps the primary answer without the disclosure on %s', async (_case, respond) => {
    primary();
    http.route({ match: everyoneUrl, respond });
    const resolution = await resolve192();
    expect(resolution.profile?.slug).toBe('192');
    expect(resolution.formerMember).toBeNull();
    expect(reads()).toBeGreaterThan(0);
    expect(resolution.provenance).toEqual([rosterUrl, `${origin}${numericProfile}`]);
  });

  it('stops a stalled read at its five-second ceiling, well inside the call budget', async () => {
    primary();
    http.route({
      match: everyoneUrl,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    let settled = false;
    const started = Date.now();
    const outcome = resolvePolitician('192', budget, []).finally(() => {
      settled = true;
    });
    // The current roster and profile answer without fake time passing, so the ceiling starts at 0.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(reads()).toBe(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const resolution = await outcome;
    expect(Date.now() - started).toBe(5_000);
    expect(resolution).toMatchObject({ profile: { slug: '192' }, formerMember: null });
  });

  it('fails the call when the caller cancels during the read', async () => {
    primary();
    http.route({
      match: everyoneUrl,
      respond: () => {
        caller.abort();
        return new Response(realRoster('all'));
      },
    });
    await expect(resolve192()).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(reads()).toBe(1);
  });

  it.each([
    [45_000, null],
    [50_000, JsonRpcErrorCode.Timeout],
  ])(
    'after %ims, degrades on the upstream subdeadline but fails on the call deadline',
    async (elapsed, code) => {
      await vi.advanceTimersByTimeAsync(elapsed);
      const outcome = findFormerMember('192', null, budget, []).then(
        (row) => ({ row }),
        (error: unknown) => ({ error }),
      );
      if (code === null) expect(await outcome).toEqual({ row: null });
      else
        expect(await outcome).toMatchObject({
          error: { code, message: expect.stringContaining('50 second') },
        });
      expect(reads()).toBe(0);
    },
  );

  it('rethrows a programmer error raised inside the read instead of degrading', async () => {
    http.route({ match: everyoneUrl, respond: new Response(realRoster('all')) });
    const frozen: Source[] = Object.freeze<Source[]>([]) as Source[];
    await expect(settle(findFormerMember('192', null, budget, frozen))).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it.each(['river-example', '19a2'])(
    'makes no request for the non-numeric value %j',
    async (value) => {
      expect(await findFormerMember(value, null, budget, [])).toBeNull();
      expect(http.calls).toHaveLength(0);
    },
  );

  it('words the notice and the not-found recovery for each slug input', async () => {
    primary();
    http.route({ match: everyoneUrl, respond: new Response(realRoster('all')) });
    const { profile: read, formerMember } = await resolve192();
    const answered: PoliticianProfile = read!;
    const former = formerMember!;
    expect(formerMemberNotice('192', answered, former, 'politician')).toBe(
      "192 was read as OpenParliament's River Example; it is also the official personId of former MP Denis Coderre. For that member, call canparl_get_member with personId 192 and pass its member.slug as politician; a null member.slug means OpenParliament holds no verified profile.",
    );
    expect(formerMemberNotice('192', answered, former, 'sponsor')).toBe(
      "192 was read as OpenParliament's River Example; it is also the official personId of former MP Denis Coderre. For that member, call canparl_get_member with personId 192 and pass its member.slug as sponsor; a null member.slug means OpenParliament holds no verified profile.",
    );
    expect(formerMemberNotice('192', answered, former, 'slug')).toBe(
      "192 was read as OpenParliament's River Example; it is also the official personId of former MP Denis Coderre. For that member, call canparl_get_member with personId 192.",
    );
    expect(formerMemberRecovery('politician')).toEqual({
      recovery: {
        hint: "The politician value matches no OpenParliament profile, but its digits are a former MP's official personId; call canparl_get_member with those digits as personId and pass its member.slug as politician; a null member.slug means OpenParliament holds no verified profile.",
      },
    });
    expect(formerMemberRecovery('sponsor').recovery.hint).toBe(
      "The sponsor value matches no OpenParliament profile, but its digits are a former MP's official personId; call canparl_get_member with those digits as personId and pass its member.slug as sponsor; a null member.slug means OpenParliament holds no verified profile.",
    );
    expect(formerMemberRecovery('slug').recovery.hint).toBe(
      "The slug value matches no OpenParliament profile, but its digits are a former MP's official personId; call canparl_get_member with those digits as personId.",
    );
  });
});
