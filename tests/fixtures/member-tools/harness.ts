/** @fileoverview Synthetic member HTTP boundary and lossless rendering oracle. @module tests/fixtures/member-tools/harness */
import { readFileSync } from 'node:fs';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { expect, vi } from 'vitest';
import {
  disposeOpenParliamentService,
  initOpenParliamentService,
} from '@/services/openparliament/index.js';
import { disposeOurCommonsService, initOurCommonsService } from '@/services/ourcommons/index.js';
import { parseMarkdown, trailerFields } from '../bill-tools/harness.js';
import { decodeBun, expectExact } from '../markdown-decode.js';

export { settle } from '../bill-tools/harness.js';
export { collection, failure, rawPerson, rosterUrl, votePicker } from '../vote-tools/harness.js';
export const origin = 'https://api.openparliament.ca';
export const actor = '/politicians/river-example/';
/**
 * Captured OpenParliament `/politicians/lawrence-cannon/` body (2026-10-21), verbatim except the
 * office contact fields (`email`, `voice`, `fax`, `other_info.constituency_offices`), which the
 * profile parser never reads. Its one link is `http://`.
 */
export const lawrenceCannon = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL('./lawrence-cannon.json', import.meta.url), 'utf8'));
/**
 * Captured OurCommons `/Members/en/{personId}/votes/xml` bodies (2026-10-21). Rows are verbatim and
 * in feed order; each file keeps a subset: `2897-45-1` divisions 169–179, every C-15 division, and
 * the date-time inversions 159/158, 147/146, 131/130; `2897-44-1`, `35933-latest` (the request
 * without `parlSession`, 41-2), and `88721-45-1` (divisions 54–52, 53 Paired) keep three rows;
 * `empty` is the whole body for a session the member did not sit in.
 */
export const realMemberVotes = (
  name: '2897-45-1' | '2897-44-1' | '35933-latest' | '88721-45-1' | 'empty',
): string => readFileSync(new URL(`./member-votes/${name}.xml`, import.meta.url), 'utf8');
/** Official member-votes feed URL, with `parlSession` only when a session is supplied. */
export const memberVotesUrl = (personId: string, session?: string) =>
  `https://www.ourcommons.ca/Members/en/${personId}/votes/xml${session ? `?parlSession=${session}` : ''}`;
export function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  const unexpected: string[] = [];
  const http = createFetchMock([], {
    onUnhandled: (request) => {
      unexpected.push(request.url);
      throw new Error(`Unexpected HTTP: ${request.url}`);
    },
  });
  http.install();
  initOurCommonsService({ userAgent: 'synthetic-member-contract' });
  initOpenParliamentService({ userAgent: 'synthetic-member-contract' });
  return Object.assign(http, { unexpected });
}
export function teardown(http: ReturnType<typeof setup>) {
  disposeOurCommonsService();
  disposeOpenParliamentService();
  http.restore();
  vi.useRealTimers();
  expect(http.unexpected).toEqual([]);
}
export const profile = (extra: Record<string, unknown> = {}) => ({
  url: actor,
  name: 'River Example',
  other_info: { parl_mp_id: ['1'] },
  gender: 'Nonbinary',
  image: 'https://images.example.test/portrait.png',
  links: [{ url: 'https://example.test/profile?a=1&b=2', note: 'Public [site]\n`reference`' }],
  memberships: [
    {
      url: '/politicians/memberships/11/',
      politician_url: actor,
      party: { name: { en: 'Historical party' }, short_name: { en: 'Past' } },
      riding: { name: { en: 'Old riding' }, province: 'BC' },
      start_date: '2001-01-01',
      end_date: '2002-12-31',
      label: { en: 'Historical\nlabel' },
    },
    {
      url: '/politicians/memberships/12/',
      politician_url: actor,
      party: { name: { en: 'Later party' }, short_name: { en: 'Later' } },
      riding: { name: { en: 'Later riding' }, province: 'ON' },
      start_date: '2003-01-01',
      end_date: null,
      label: null,
    },
  ],
  ...extra,
});
export function page(
  http: ReturnType<typeof setup>,
  path: string,
  params: Record<string, string | number>,
  objects: unknown[],
  next: number | null = null,
) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const nextUrl = new URL(url);
  if (next !== null) nextUrl.searchParams.set('offset', String(next));
  http.route({
    match: url.href,
    respond: Response.json({
      objects,
      pagination: {
        offset: Number(params.offset),
        limit: Number(params.limit),
        next_url: next === null ? null : nextUrl.href,
      },
    }),
  });
  return url.href;
}
export function json(http: ReturnType<typeof setup>, path: string, data: unknown) {
  http.route({ match: `${origin}${path}`, respond: Response.json(data) });
}
export function parity(
  result: {
    isError?: boolean | undefined;
    structuredContent?: unknown;
    content: readonly { type: string; text?: string }[];
  },
  definition: {
    output: { parse(value: unknown): unknown };
    format?: ((value: never) => readonly { type: string; text?: string }[]) | undefined;
    enrichmentTrailer?: Record<string, { render?: unknown } | undefined> | undefined;
  },
) {
  expect(result.isError).not.toBe(true);
  const data = result.structuredContent as Record<string, unknown>;
  const body = definition.output.parse(data);
  const check = (blocks: readonly { type: string; text?: string }[]) => {
    const decoded = decodeBun(
      blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n'),
    );
    expectExact(decoded.value, body);
    const links: { text: string; href: string }[] = [];
    const images: { text: string; src: string }[] = [];
    const walk = (node: unknown, key: string): void => {
      if (Array.isArray(node)) for (const [i, v] of node.entries()) walk(v, String(i));
      else if (node !== null && typeof node === 'object')
        for (const [k, v] of Object.entries(node)) walk(v, k);
      else if (typeof node === 'string' && node.startsWith('https://')) {
        if (/image|photo|portrait/i.test(key)) images.push({ text: 'imageUrl', src: node });
        else links.push({ text: node, href: node });
      }
    };
    walk(body, 'value');
    expect(decoded.links).toEqual(links);
    expect(decoded.images).toEqual(images);
  };
  check([result.content[0]!]);
  check(definition.format!(body as never));
  const trailer = result.content.slice(1);
  const fields = trailerFields(trailer);
  const lines = trailer.flatMap((b) => (b.text ?? '').split('\n'));
  for (const key of ['appliedFilters', 'shown', 'cap', 'truncated', 'unavailable']) {
    if (key !== 'unavailable') expect(data).toHaveProperty(key);
    if (!(key in data)) continue;
    // Fields the tool renders itself decode structurally; the rest are the framework's whole `**key:** value` line.
    if (definition.enrichmentTrailer?.[key]?.render) expectExact(fields[key], data[key]);
    else expect(lines).toContain(`**${key}:** ${String(data[key])}`);
  }
  if (data.notice) {
    expect(lines).toContain(`> ${data.notice}`);
    expect(parseMarkdown(`> ${data.notice}`).text).toBe(data.notice);
  }
  return data;
}
