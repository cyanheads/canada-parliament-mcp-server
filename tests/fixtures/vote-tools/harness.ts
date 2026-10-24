/** @fileoverview Synthetic House HTTP fixtures and production rendering oracle. @module tests/fixtures/vote-tools/harness */
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { expect, vi } from 'vitest';
import { disposeLegisinfoService, initLegisinfoService } from '@/services/legisinfo/index.js';
import { disposeOurCommonsService, initOurCommonsService } from '@/services/ourcommons/index.js';
import {
  assertDomainParity,
  assertMeasuredResponse,
  expectExact,
  parseMarkdown,
  trailerFields,
} from '../bill-tools/harness.js';

export { current, listing, picker, rawBill, sessions, settle } from '../bill-tools/harness.js';
export const votePicker = 'https://www.ourcommons.ca/Members/en/votes';
export const votesUrl = (session = '45-1') => `${votePicker}/xml?parlSession=${session}`;
export const detailUrl = (session = '45-1', number = 901) =>
  `${votePicker}/${session.replace('-', '/')}/${number}/xml`;
export const rosterUrl = 'https://www.ourcommons.ca/Members/en/search/xml';

/** Escape synthetic text at the XML network boundary. */
export function xml(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      value === null
        ? `<${key} xsi:nil="true"/>`
        : `<${key}>${String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</${key}>`,
    )
    .join('');
}
export const rawVote = (number = 901, extra: Record<string, unknown> = {}) => ({
  ParliamentNumber: 45,
  SessionNumber: 1,
  DecisionDivisionNumber: number,
  DecisionEventDateTime: '2026-10-19T23:59:00',
  DecisionDivisionSubject: 'École [x].*\r\n\n# synthetic `motion`',
  DecisionResultName: 'Agreed To',
  DecisionDivisionNumberOfYeas: 2,
  DecisionDivisionNumberOfNays: 1,
  DecisionDivisionNumberOfPaired: 1,
  DecisionDivisionDocumentTypeName: 'Legislative Process',
  BillNumberCode: 'S-321',
  ...extra,
});
export const rawPerson = (id = 1, extra: Record<string, unknown> = {}) => ({
  ParliamentNumber: 45,
  SessionNumber: 1,
  DecisionDivisionNumber: 901,
  PersonId: id,
  PersonOfficialFirstName: 'River',
  PersonOfficialLastName: 'Example',
  CaucusShortName: 'Liberal',
  ConstituencyName: 'Synthetic [riding]',
  ConstituencyProvinceTerritoryName: 'Ontario',
  VoteValueName: 'Yea',
  ...extra,
});
export function collection(root: string, child: string, rows: Record<string, unknown>[]): string {
  return `<${root}>${rows.map((row) => `<${child}>${xml(row)}</${child}>`).join('')}</${root}>`;
}
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
  initLegisinfoService({ userAgent: 'synthetic-vote-tests' });
  initOurCommonsService({ userAgent: 'synthetic-vote-tests' });
  http.route({
    match: votePicker,
    respond: new Response(
      ['45-1', '38-1', '46-2']
        .map((value) => `<a data-input="parlSession" data-value="${value}">${value}</a>`)
        .join(''),
    ),
  });
  return Object.assign(http, { unexpected });
}
export function teardown(http: ReturnType<typeof setup>) {
  disposeLegisinfoService();
  disposeOurCommonsService();
  http.restore();
  vi.useRealTimers();
  expect(http.unexpected).toEqual([]);
}
export function votes(http: ReturnType<typeof setup>, rows = [rawVote()], session = '45-1') {
  http.route({
    match: votesUrl(session),
    respond: new Response(collection('ArrayOfVote', 'Vote', rows)),
  });
}
export function ballots(
  http: ReturnType<typeof setup>,
  rows = [rawPerson()],
  session = '45-1',
  number = 901,
) {
  http.route({
    match: detailUrl(session, number),
    respond: new Response(collection('ArrayOfVoteParticipant', 'VoteParticipant', rows)),
  });
}
type ToolResult = {
  isError?: boolean | undefined;
  structuredContent?: unknown;
  content: readonly { type: string; text?: string }[];
};
type Definition = {
  enrichment?: Record<string, unknown>;
  enrichmentTrailer?: Record<string, { render?: unknown } | undefined> | undefined;
  output: { parse(value: unknown): unknown };
  format?: ((value: never) => readonly { type: string; text?: string }[]) | undefined;
};
/** Structurally decode the domain body from `content[0]` and from `format()`. */
function domainParity(result: ToolResult, definition: Definition) {
  expect(result.isError).not.toBe(true);
  const data = result.structuredContent as Record<string, unknown>;
  const body = definition.output.parse(data);
  assertDomainParity(body, [result.content[0]!]);
  assertDomainParity(body, definition.format!(body as never));
  return data;
}
/** Budgeted ballot page: domain parity, every enrichment field exact, measure equal to the wire. */
export function ballotParity(result: ToolResult, definition: Definition) {
  const data = domainParity(result, definition);
  assertMeasuredResponse(result, definition, data.ballots as unknown[]);
  return data;
}
/** Check actual CommonMark leaves for both the tool body and every enrichment value. */
export function parity(result: ToolResult, definition: Definition) {
  const data = domainParity(result, definition);
  if (definition.enrichmentTrailer?.shown?.render) {
    assertMeasuredResponse(result, definition, data.divisions as unknown[]);
    return data;
  }
  expectExact(trailerFields(result.content.slice(1)).appliedFilters, data.appliedFilters);
  const trailer = parseMarkdown(
    result.content
      .slice(1)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n'),
  ).text;
  for (const key of ['shown', 'cap', 'truncated', 'tallyMatchesBallots'])
    if (key in data) expect(trailer).toContain(`${key}: ${String(data[key])}`);
  expect(trailer).toContain(`${String(data.totalCount)} total`);
  if (data.notice) expect(trailer).toContain(data.notice);
  return data;
}
/** Validate declared domain failures on both consumption paths. */
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
        retryable: contract.retryable ?? false,
        recovery: { hint: contract.recovery },
      },
    },
  });
  expect(
    result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
  ).toContain(contract.recovery);
}
