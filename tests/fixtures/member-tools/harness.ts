/** @fileoverview Synthetic member HTTP boundary and lossless rendering oracle. @module tests/fixtures/member-tools/harness */
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { expect, vi } from 'vitest';
import {
  disposeOpenParliamentService,
  initOpenParliamentService,
} from '@/services/openparliament/index.js';
import { disposeOurCommonsService, initOurCommonsService } from '@/services/ourcommons/index.js';
import { expectedText, parseMarkdown } from '../bill-tools/harness.js';

export { settle } from '../bill-tools/harness.js';
export { collection, failure, rawPerson, rosterUrl } from '../vote-tools/harness.js';
export const origin = 'https://api.openparliament.ca';
export const actor = '/politicians/river-example/';
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
  },
) {
  expect(result.isError).not.toBe(true);
  const data = result.structuredContent as Record<string, unknown>;
  const body = definition.output.parse(data);
  const check = (blocks: readonly { type: string; text?: string }[]) => {
    const parsed = parseMarkdown(
      blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n'),
    );
    const links: { text: string; href: string }[] = [];
    const images: { text: string; src: string }[] = [];
    const expected = (node: unknown, key = 'value'): string => {
      if (Array.isArray(node))
        return `${key}: ${node.length ? '[array]' : '[]'}${node.map((v, i) => expected(v, String(i))).join('')}`;
      if (node !== null && typeof node === 'object')
        return `${key}: ${Object.keys(node).length ? '[object]' : '{}'}${Object.entries(node)
          .map(([k, v]) => expected(v, k))
          .join('')}`;
      if (typeof node === 'string' && node.startsWith('https://')) {
        if (/image|photo|portrait/i.test(key)) {
          images.push({ text: 'imageUrl', src: node });
          return `${key}: imageUrl`;
        }
        links.push({ text: node, href: node });
      }
      return `${key}:${node === '' ? '' : ` ${String(node)}`}`;
    };
    expect(parsed.text).toBe(expected(body));
    expect(parsed.links).toEqual(links);
    expect(parsed.images).toEqual(images);
  };
  check([result.content[0]!]);
  check(definition.format!(body as never));
  const trailer = parseMarkdown(
    result.content
      .slice(1)
      .map((b) => b.text ?? '')
      .join('\n'),
  ).text;
  for (const key of ['appliedFilters', 'shown', 'cap', 'truncated', 'unavailable']) {
    if (key !== 'unavailable') expect(data).toHaveProperty(key);
    if (key in data) expect(trailer).toContain(expectedText(data[key], key));
  }
  if (data.notice) expect(trailer).toContain(data.notice);
  return data;
}
