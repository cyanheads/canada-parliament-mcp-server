/** @fileoverview Source-index union and complete reference vocabulary contracts. @module tests/tools/list-reference.test */
import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { assertFilterRejection } from '../fixtures/filter-rejection.js';
import {
  collection,
  current,
  failure,
  listing,
  parity,
  rawBill,
  rawPerson,
  rawVote,
  rosterUrl,
  sessions,
  settle,
  setup,
  teardown,
  votes,
} from '../fixtures/vote-tools/harness.js';

describe('canparl_list_reference production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
    sessions(http, ['45-1', '38-1', '35-2']);
    http.route({ match: current, respond: Response.json([rawBill()]) });
  });
  afterEach(() => teardown(http));
  const call = (input: Record<string, unknown>) =>
    settle(runToolContract(listReferenceTool, input as z.input<typeof listReferenceTool.input>));
  it('unions actual indexes and reports sorted basic/full/unsupported coverage without guessed sessions', async () => {
    const result = await call({ topic: 'sessions', session: ' ' });
    const data = parity(result, listReferenceTool);
    expect(data).toMatchObject({
      session: null,
      currentSession: '45-1',
      totalCount: 4,
      shown: 4,
      cap: 4,
      truncated: false,
      appliedFilters: { topic: 'sessions', session: null },
      entries: [
        {
          value: '46-2',
          source: 'ourcommons',
          parliament: 46,
          sessionNumber: 2,
          observed: null,
          coverage: { bills: 'not_supported', houseDivisions: 'advertised' },
        },
        { value: '45-1', coverage: { bills: 'full', houseDivisions: 'advertised' } },
        { value: '38-1', coverage: { bills: 'full', houseDivisions: 'advertised' } },
        { value: '35-2', coverage: { bills: 'basic', houseDivisions: 'not_supported' } },
      ],
    });
  });
  it.each(['bill_types', 'bill_statuses', 'vote_results', 'vote_document_types', 'parties'])(
    'returns complete catalog plus observations for %s',
    async (topic) => {
      http.route({
        match: listing(),
        respond: Response.json([
          rawBill('C-901', {
            BillDocumentTypeNameEn: 'Synthetic type [x]\r\n',
            StatusNameEn: 'Synthetic status',
          }),
        ]),
      });
      votes(http, [
        rawVote(901, {
          DecisionResultName: 'Historical result',
          DecisionDivisionDocumentTypeName: 'Synthetic category',
        }),
      ]);
      http.route({
        match: rosterUrl,
        respond: new Response(
          collection('ArrayOfMemberOfParliament', 'MemberOfParliament', [
            rawPerson(1, { CaucusShortName: 'Independent' }),
          ]),
        ),
      });
      const result = await call({ topic });
      const data = parity(result, listReferenceTool);
      const entries = data.entries as { value: string; source: string; observed: boolean | null }[];
      expect(entries).toHaveLength(
        { bill_types: 6, bill_statuses: 14, vote_results: 4, vote_document_types: 10, parties: 8 }[
          topic
        ]!,
      );
      const observed = {
        bill_types: 'Synthetic type [x]',
        bill_statuses: 'Synthetic status',
        vote_results: 'Historical result',
        vote_document_types: 'Synthetic category',
        parties: 'Independent',
      }[topic];
      expect(entries.find((entry) => entry.value === observed)).toMatchObject({ observed: true });
      expect(entries.some((entry) => entry.observed === false)).toBe(true);
      expect(data).toMatchObject({
        session: '45-1',
        currentSession: '45-1',
        totalCount: entries.length,
        shown: entries.length,
        cap: entries.length,
        truncated: false,
        appliedFilters: { topic, session: '45-1' },
      });
      if (topic === 'parties')
        expect(entries.filter((entry) => entry.source === 'openparliament')).toEqual([
          expect.objectContaining({ value: 'Bloc', observed: null }),
          expect.objectContaining({ value: 'Green', observed: null }),
        ]);
      if (topic === 'vote_results') expect(JSON.stringify(entries)).toContain('Passed/Failed/Tie');
    },
  );
  it.each(['bill_types', 'bill_statuses', 'vote_results', 'vote_document_types', 'parties'])(
    'keeps catalog labels recognized when the selected feed is empty: %s',
    async (topic) => {
      http.route({ match: listing('38-1'), respond: Response.json([]) });
      votes(http, [], '38-1');
      http.route({ match: rosterUrl, respond: new Response('<ArrayOfMemberOfParliament/>') });
      const result = await call({ topic, session: { parliament: 38, session: 1 } });
      const data = parity(result, listReferenceTool);
      expect(data.session).toBe('38-1');
      expect(data.notice).toContain('observed=false');
      expect(
        (data.entries as { observed: boolean | null }[]).every(
          (entry) => entry.observed === false || entry.observed === null,
        ),
      ).toBe(true);
    },
  );
  it.each([
    { topic: 'sessions', session: '45-1' },
    { topic: 'bill_types', session: '46-2' },
    { topic: 'bill_statuses', session: '99-1' },
    { topic: 'parties', session: '46-2' },
    { topic: 'vote_results', session: '35-2' },
    { topic: 'vote_document_types', session: '35-2' },
  ])('returns topic-specific session recovery for %j', async (input) => {
    const reason =
      input.topic === 'sessions' ? 'incompatible_reference_session' : 'unknown_reference_session';
    const result = await call(input);
    failure(result, listReferenceTool.errors!.find((error) => error.reason === reason)!);
    if (input.topic === 'sessions') return;
    const votesIndex = input.topic.startsWith('vote_');
    assertFilterRejection(result, {
      field: 'session',
      rejected: input.session,
      allowed: votesIndex ? ['45-1', '38-1', '46-2'] : ['45-1', '38-1', '35-2'],
      shape: votesIndex
        ? 'Expected a session in the official House division session index'
        : 'Expected a session in the official bill session index',
    });
  });
  it.each([
    ['bill_types', '45-0'],
    ['vote_results', '45-0'],
    ['sessions', '45-0'],
    ['parties', '9007199254740992-1'],
  ])(
    'rejects malformed %s session %j as unknown_reference_session before HTTP',
    async (topic, session) => {
      const result = await call({ topic, session });
      failure(
        result,
        listReferenceTool.errors!.find((error) => error.reason === 'unknown_reference_session')!,
      );
      assertFilterRejection(result, {
        field: 'session',
        rejected: session,
        shape: 'Expected a parliament-session token such as 45-1',
      });
      expect(http.calls).toHaveLength(0);
    },
  );
  it.each(['bill_types', 'bill_statuses'])(
    'lists %s for a session holding a split bill beside its base code',
    async (topic) => {
      const historical = { ParliamentNumber: 38, SessionNumber: 1, IsSessionOngoing: false };
      http.route({
        match: listing('38-1'),
        respond: Response.json([
          rawBill('C-333', historical),
          rawBill('C-333A', { ...historical, StatusNameEn: 'Synthetic split status' }),
        ]),
      });
      const data = parity(await call({ topic, session: '38-1' }), listReferenceTool);
      expect(data).toMatchObject({ session: '38-1', appliedFilters: { topic, session: '38-1' } });
      if (topic === 'bill_statuses')
        expect(
          (data.entries as { value: string; observed: boolean | null }[]).find(
            (entry) => entry.value === 'Synthetic split status',
          ),
        ).toMatchObject({ observed: true });
    },
  );
  it.each([{ topic: 'unknown' }, { topic: 'sessions', session: { parliament: 0, session: 1 } }])(
    'rejects invalid schema input before HTTP %j',
    async (input) => {
      expect((await call(input)).structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(http.calls).toHaveLength(0);
    },
  );
});
