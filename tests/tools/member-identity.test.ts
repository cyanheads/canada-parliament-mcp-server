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
