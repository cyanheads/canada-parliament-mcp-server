/** @fileoverview Synthetic speech HTTP boundary and CommonMark contract oracle. @module tests/fixtures/speech-tools/harness */
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { expect, vi } from 'vitest';
import {
  disposeOpenParliamentService,
  initOpenParliamentService,
} from '@/services/openparliament/index.js';
import { assertDomainParity, expectedText, parseMarkdown } from '../bill-tools/harness.js';

export { settle } from '../bill-tools/harness.js';
export const api = 'https://api.openparliament.ca';
export const actor = '/politicians/river-example/';
export const member = '/politicians/memberships/901/';
export const speech = (id = 1, extra: Record<string, unknown> = {}) => ({
  source_id: String(id),
  url: `/debates/2026/10/19/river-example-${id}/`,
  document_url: '/debates/2026/10/19/',
  politician_url: actor,
  politician_membership_url: null,
  time: '2026-10-19 23:59:59',
  procedural: false,
  attribution: { en: 'River Example', fr: 'Autre attribution' },
  h1: { en: 'École [x].*', fr: 'Titre français' },
  h2: { en: 'Second `heading`' },
  content: {
    en: '<p>École [x].* &amp; 中文<br>next line</p><p># heading\r\n``` fence</p>',
    fr: '<p>French only phrase</p>',
  },
  ...extra,
});
export const membership = (extra: Record<string, unknown> = {}) => ({
  url: member,
  politician_url: actor,
  start_date: '2020-01-01',
  end_date: '2026-10-19',
  party: { name: { en: 'Historical [party]' }, short_name: { en: 'HP' } },
  riding: { name: { en: 'Old riding\n第二行' }, province: 'ON' },
  ...extra,
});
export function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  const http = createFetchMock();
  http.install();
  initOpenParliamentService({ userAgent: 'synthetic-speech-tests' });
  return http;
}
export function teardown(http: ReturnType<typeof setup>) {
  disposeOpenParliamentService();
  http.restore();
  vi.useRealTimers();
}
export function profile(http: ReturnType<typeof setup>) {
  http.route({
    match: `${api}${actor}`,
    respond: Response.json({
      url: actor,
      name: 'River Example',
      current_party: { short_name: { en: 'Current, never historical' } },
    }),
  });
}
export function bill(http: ReturnType<typeof setup>, code = 'S-321') {
  http.route({
    match: `${api}/bills/45-1/${code}/`,
    respond: Response.json({
      url: `/bills/45-1/${code}/`,
      session: '45-1',
      number: code,
      name: { en: 'Synthetic bill' },
    }),
  });
}
export function pages(
  http: ReturnType<typeof setup>,
  rows: Record<string, unknown>[],
  params: Record<string, string | undefined> = {},
  terminal = true,
) {
  http.route({
    match: (request) => new URL(request.url).pathname === '/speeches/',
    respond: (request) => {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get('offset'));
      const expected = {
        limit: '20',
        offset: String(offset),
        procedural: 'false',
        ...params,
      };
      expect(Object.fromEntries(url.searchParams)).toStrictEqual(
        Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== undefined)),
      );
      const objects = rows.slice(offset, offset + 20);
      const next = offset + objects.length < rows.length || !terminal ? offset + 20 : null;
      const nextUrl = new URL(url);
      if (next !== null) nextUrl.searchParams.set('offset', String(next));
      return Response.json({
        objects,
        pagination: { offset, limit: 20, next_url: next === null ? null : nextUrl.href },
      });
    },
  });
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
  assertDomainParity(body, [result.content[0]!]);
  assertDomainParity(body, definition.format!(body as never));
  const trailer = parseMarkdown(
    result.content
      .slice(1)
      .map((block) => block.text ?? '')
      .join('\n'),
  ).text;
  expect(trailer).toContain(expectedText(data.appliedFilters, 'appliedFilters'));
  for (const key of ['shown', 'cap', 'truncated', 'excludedCommittees'])
    expect(trailer).toContain(`${key}: ${String(data[key])}`);
  expect(data.notice).toEqual(expect.any(String));
  expect(trailer).toContain(data.notice);
  return data;
}
/** Assert only declared error metadata, preserving omitted retryability. */
export function failure(
  result: {
    isError?: boolean | undefined;
    structuredContent?: unknown;
    content: readonly { type: string; text?: string }[];
  },
  contract: { reason: string; code: number; recovery: string; retryable?: boolean },
) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: contract.code,
      data: {
        reason: contract.reason,
        recovery: { hint: contract.recovery },
        ...(contract.retryable === undefined ? {} : { retryable: contract.retryable }),
      },
    },
  });
  expect(result.content.map((block) => block.text ?? '').join('\n')).toContain(contract.recovery);
}
