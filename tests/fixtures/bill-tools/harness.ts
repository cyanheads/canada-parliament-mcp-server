/**
 * @fileoverview Network fixtures and CommonMark oracle for bill tool contracts.
 * @module tests/fixtures/bill-tools/harness
 */
import { execFileSync } from 'node:child_process';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { expect, vi } from 'vitest';
import { disposeLegisinfoService, initLegisinfoService } from '@/services/legisinfo/index.js';
import {
  disposeOpenParliamentService,
  initOpenParliamentService,
} from '@/services/openparliament/index.js';

export const picker = 'https://www.parl.ca/legisinfo/en/bills';
export const current = `${picker}/json`;
export const listing = (session = '45-1') => `${current}?parlsession=${session}`;
export const detail = (code = 'C-901', session = '45-1') =>
  `https://www.parl.ca/legisinfo/en/bill/${session}/${code.toLowerCase()}/json`;
export const rawBill = (code = 'C-901', extra: Record<string, unknown> = {}) => ({
  ParliamentNumber: 45,
  SessionNumber: 1,
  NumberCode: code,
  IsSessionOngoing: true,
  LongTitleEn: 'Synthetic marine act',
  LongTitleFr: 'Loi synthétique sur la mer',
  ShortTitleEn: 'Marine Act',
  ShortTitleFr: 'Loi marine',
  BillDocumentTypeNameEn: 'Government Bill',
  OriginatingChamberNameEn: 'House of Commons',
  StatusNameEn: 'At second reading in the House of Commons',
  LatestCompletedMajorStageNameEn: 'First reading',
  LatestCompletedMajorStageChamberNameEn: 'House of Commons',
  ReceivedRoyalAssentDateTime: null,
  ...extra,
});

/** Fresh real service accessors with only the HTTP boundary replaced. */
export function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  const http = createFetchMock();
  http.install();
  initLegisinfoService({ userAgent: 'synthetic-bill-contract-tests' });
  initOpenParliamentService({ userAgent: 'synthetic-bill-contract-tests' });
  return http;
}
/** Release all service queues and restore the process boundary. */
export function teardown(http: ReturnType<typeof createFetchMock>) {
  disposeLegisinfoService();
  disposeOpenParliamentService();
  http.restore();
  vi.useRealTimers();
}
/** Drive pacing without a real wait or swallowing early failures. */
export async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(25_000);
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}
/** Declare the discovered source sessions, never infer them arithmetically. */
export function sessions(http: ReturnType<typeof createFetchMock>, values = ['45-1', '35-2']) {
  http.route({
    match: picker,
    respond: new Response(
      values
        .map((value) => `<a data-input="parlsession" data-value="${value}">Synthetic session</a>`)
        .join(''),
    ),
  });
}

interface Parsed {
  images: unknown[];
  links: { text: string; href: string }[];
  text: string;
}
/** Actual CommonMark text callbacks and DOM destinations, not string matching Markdown. */
export function parseMarkdown(markdown: string): Parsed {
  return JSON.parse(
    execFileSync(
      'bun',
      [
        '-e',
        `
const markdown = await Bun.stdin.text();
const result = { text: '', links: [], images: [] };
Bun.markdown.render(markdown, { text(value) { result.text += value; return value; } });
const { parseHTML } = await import('linkedom');
const { document } = parseHTML(Bun.markdown.html(markdown));
result.links = [...document.querySelectorAll('a')].map(a => ({text:a.textContent,href:a.getAttribute('href')}));
result.images = [...document.querySelectorAll('img')].map(img => ({text:img.getAttribute('alt'),src:img.getAttribute('src')}));
console.log(JSON.stringify(result));`,
      ],
      { input: markdown, encoding: 'utf8' },
    ),
  ) as Parsed;
}
/** Independent expected label/leaf walk verifies every field, row, and nested value. */
export function expectedText(value: unknown, key = 'value'): string {
  if (Array.isArray(value))
    return `${key}: ${value.length ? '[array]' : '[]'}${value.map((item, i) => expectedText(item, String(i))).join('')}`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return `${key}: ${entries.length ? '[object]' : '{}'}${entries.map(([name, item]) => expectedText(item, name)).join('')}`;
  }
  return `${key}:${value === '' ? '' : ` ${String(value)}`}`;
}
/** Check a whole domain body independently from the framework's trailer formatting. */
export function assertDomainParity(
  value: unknown,
  blocks: readonly { type: string; text?: string }[],
) {
  const markdown = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  const parsed = parseMarkdown(markdown);
  expect(parsed.text).toBe(expectedText(value));
  const urls: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' && node.startsWith('https://')) urls.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
  expect(parsed.links).toEqual(urls.map((url) => ({ text: url, href: url })));
  expect(parsed.images).toEqual([]);
  expect(markdown).not.toContain('```');
}

/** Both envelopes contain the declared error and actionable recovery. */
export function assertError(
  result: {
    isError?: boolean | undefined;
    structuredContent?: unknown;
    content: readonly { type: string; text?: string }[];
  },
  reason: string,
  code: number,
  hint: string,
) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code, data: { reason, retryable: false, recovery: { hint } } },
  });
  expect(
    result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
  ).toContain(hint);
}
