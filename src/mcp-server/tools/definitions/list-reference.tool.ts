/** @fileoverview Actual source session indexes and observed/catalog vocabulary. @module mcp-server/tools/definitions/list-reference.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { normalizeSession, vocabularyKey } from '@/domain/normalization.js';
import {
  BILL_STATUSES,
  BILL_TYPES,
  extendVocabulary,
  OFFICIAL_PARTY_ALIASES,
  PARTIES,
  VOTE_DOCUMENT_TYPES,
  VOTE_RESULTS,
} from '@/domain/reference-catalog.js';
import { createRequestContext } from '@/domain/request-context.js';
import { SessionInputSchema, SourceNameSchema, SourceSchema } from '@/domain/schemas.js';
import { getLegisinfoService } from '@/services/legisinfo/index.js';
import { getOurCommonsService } from '@/services/ourcommons/index.js';
import { formatResult, renderValue } from './_format.js';

const TopicSchema = z
  .enum([
    'sessions',
    'bill_types',
    'bill_statuses',
    'vote_results',
    'vote_document_types',
    'parties',
  ])
  .describe('Reference topic used to construct source-specific filters.');
const EntrySchema = z
  .object({
    value: z.string().describe('Canonical filter value or actual session token.'),
    label: z.string().describe('Source-specific display label.'),
    source: SourceNameSchema,
    description: z.string().describe('Applicability and source vocabulary guidance.'),
    observed: z
      .boolean()
      .nullable()
      .describe('Whether observed in the selected feed; null when not applicable.'),
    coverage: z
      .object({
        bills: z
          .enum(['basic', 'full', 'not_supported'])
          .describe('Official advertised bill coverage.'),
        houseDivisions: z
          .enum(['advertised', 'not_supported'])
          .describe('Whether the official division picker advertises the session.'),
        openParliament: z
          .string()
          .describe('Qualitative indexing coverage, without an exhaustive session guarantee.'),
      })
      .strict()
      .optional()
      .describe('Combined source coverage for a session.'),
    parliament: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Actual parliament number from source index.'),
    sessionNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Actual session number from source index.'),
  })
  .strict()
  .describe('One source-specific canonical reference entry.');

/** Discover canonical source-specific sessions and vocabulary without guessed coverage. */
export const listReferenceTool = tool('canparl_list_reference', {
  description:
    'List canonical session coverage and bill, division, and caucus vocabulary. Use source-specific terms when constructing filters. Omitted session means the verified current session for vocabulary. For topic sessions omit session; the entire global index is returned.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({ topic: TopicSchema, session: SessionInputSchema }),
  output: z.object({
    topic: TopicSchema,
    session: z
      .string()
      .nullable()
      .describe('Selected session, or null for the global session index.'),
    currentSession: z
      .string()
      .describe('Current session verified from the official default bill feed.'),
    entries: z
      .array(EntrySchema)
      .describe('Complete bounded reference vocabulary or real session union.'),
    provenance: z.array(SourceSchema).describe('Source retrieval metadata.'),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        topic: TopicSchema,
        session: z.string().nullable().describe('Normalized selected session or null.'),
      })
      .strict()
      .describe('Resolved reference scope.'),
    totalCount: z.number().int().nonnegative().describe('Exact number of reference entries.'),
    shown: z.number().int().nonnegative().describe('All returned reference entries.'),
    cap: z
      .number()
      .int()
      .nonnegative()
      .describe('Complete reference entry count; no display cap is imposed.'),
    truncated: z.boolean().describe('Always false: the entire vocabulary is returned.'),
    notice: z.string().optional().describe('Catalog-only or historical coverage guidance.'),
  },
  enrichmentTrailer: {
    appliedFilters: { render: (value) => renderValue(value, 'appliedFilters') },
  },
  errors: [
    {
      reason: 'unknown_reference_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Session absent from the topic-relevant source index.',
      recovery:
        'Call canparl_list_reference with topic sessions and omit session to see supported choices.',
      retryable: false,
    },
    {
      reason: 'incompatible_reference_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A session is supplied for the global sessions topic.',
      recovery: 'Call canparl_list_reference with topic sessions and omit the session argument.',
      retryable: false,
    },
  ],
  async handler(input, ctx) {
    const request = createRequestContext(ctx);
    try {
      const selected = normalizeSession(input.session);
      if (input.topic === 'sessions' && selected) throw ctx.fail('incompatible_reference_session');
      const official = getLegisinfoService();
      const house = getOurCommonsService();
      const current = await official.getCurrentSession(request);
      const provenance = [...current.provenance];
      const session = input.topic === 'sessions' ? null : (selected ?? current.data);
      const entries: z.infer<typeof EntrySchema>[] = [];
      if (input.topic === 'sessions') {
        const [bills, votes] = await Promise.all([
          official.getSessions(request),
          house.getVoteSessions(request),
        ]);
        provenance.push(...bills.provenance, ...votes.provenance);
        const sessions = new Map<string, { parliament: number; sessionNumber: number }>();
        for (const row of [...bills.data, ...votes.data]) sessions.set(row.session, row);
        for (const [token, row] of sessions) {
          const bill = bills.data.find((item) => item.session === token);
          const vote = votes.data.find((item) => item.session === token);
          entries.push({
            value: token,
            label: token,
            source: bill ? 'legisinfo' : 'ourcommons',
            description:
              'Actual advertised official session. Record availability may vary within its source coverage.',
            observed: null,
            parliament: row.parliament,
            sessionNumber: row.sessionNumber,
            coverage: {
              bills: bill?.coverage ?? 'not_supported',
              houseDivisions: vote ? 'advertised' : 'not_supported',
              openParliament:
                'Politician name history since 1994; indexed bills, ballots, and speeches are not guaranteed for every session.',
            },
          });
        }
        entries.sort(
          (a, b) =>
            (b.parliament ?? 0) - (a.parliament ?? 0) ||
            (b.sessionNumber ?? 0) - (a.sessionNumber ?? 0),
        );
      } else if (session) {
        const voteTopic = input.topic === 'vote_results' || input.topic === 'vote_document_types';
        if (voteTopic) {
          const index = await house.getVoteSessions(request);
          provenance.push(...index.provenance);
          if (!index.data.some((row) => row.session === session))
            throw ctx.fail('unknown_reference_session');
        } else {
          const index = await official.getSessions(request);
          provenance.push(...index.provenance);
          if (!index.data.some((row) => row.session === session))
            throw ctx.fail('unknown_reference_session');
        }
        let catalog: readonly string[];
        let observed: (string | null)[];
        let source: 'legisinfo' | 'ourcommons';
        if (input.topic === 'bill_types' || input.topic === 'bill_statuses') {
          const rows = await official.listBills(session, request);
          provenance.push(...rows.provenance);
          catalog = input.topic === 'bill_types' ? BILL_TYPES : BILL_STATUSES;
          observed = rows.data.map((row) =>
            input.topic === 'bill_types' ? row.billType : row.status,
          );
          source = 'legisinfo';
        } else if (voteTopic) {
          const rows = await house.listVotes(session, request);
          provenance.push(...rows.provenance);
          catalog = input.topic === 'vote_results' ? VOTE_RESULTS : VOTE_DOCUMENT_TYPES;
          observed = rows.data.map((row) =>
            input.topic === 'vote_results' ? row.result : row.documentType,
          );
          source = 'ourcommons';
        } else {
          const rows = await house.listMembers(request);
          provenance.push(...rows.provenance);
          catalog = PARTIES;
          observed = rows.data.map((row) => row.party);
          source = 'ourcommons';
        }
        const observedKeys = new Set(
          observed.filter((value): value is string => !!value?.trim()).map(vocabularyKey),
        );
        for (const value of extendVocabulary(catalog, observed))
          entries.push({
            value,
            label: value,
            source,
            observed: observedKeys.has(vocabularyKey(value)),
            description:
              input.topic === 'vote_results'
                ? 'Official division result. OpenParliament uses Passed/Failed/Tie for results and Yes/No/Paired/Didn’t vote for ballots; official participant feeds do not list nonvoters.'
                : input.topic === 'parties'
                  ? 'Official current-roster caucus vocabulary, not an exhaustive historical list. canparl_get_vote also accepts caucuses observed in the full division participant feed.'
                  : 'Canonical source label; catalog labels remain valid filters even when no selected-session record uses them.',
          });
        if (input.topic === 'parties')
          for (const [alias, canonical] of Object.entries(OFFICIAL_PARTY_ALIASES))
            entries.push({
              value: alias,
              label: alias,
              source: 'openparliament',
              description: `OpenParliament alias for official caucus ${canonical}; accepted only at official filter boundaries.`,
              observed: null,
            });
        if (!observedKeys.size)
          ctx.enrich.notice(
            'No labels were observed in the selected feed; catalog entries remain valid and are marked observed=false.',
          );
      }
      ctx.enrich({
        appliedFilters: { topic: input.topic, session },
        shown: entries.length,
        cap: entries.length,
        truncated: false,
      });
      ctx.enrich.total(entries.length);
      request.throwIfOuterAborted();
      return { topic: input.topic, session, currentSession: current.data, entries, provenance };
    } finally {
      request.dispose();
    }
  },
  format: (result) =>
    formatResult({
      ...result,
      entries: result.entries.map(({ coverage, parliament, sessionNumber, ...entry }) => ({
        ...entry,
        ...(coverage === undefined ? {} : { coverage }),
        ...(parliament === undefined ? {} : { parliament }),
        ...(sessionNumber === undefined ? {} : { sessionNumber }),
      })),
    }),
});
