/** @fileoverview Complete official-session division search. @module mcp-server/tools/definitions/search-votes.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  includesText,
  normalizeBillCode,
  normalizeDate,
  normalizeSession,
  normalizeVocabulary,
  paginate,
  validateDateRange,
  vocabularyKey,
} from '@/domain/normalization.js';
import { extendVocabulary, VOTE_DOCUMENT_TYPES, VOTE_RESULTS } from '@/domain/reference-catalog.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  LimitSchema,
  OffsetSchema,
  OptionalStringSchema,
  PaginationSchema,
  SessionInputSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import { getLegisinfoService } from '@/services/legisinfo/index.js';
import { getOurCommonsService } from '@/services/ourcommons/index.js';
import { formatResult, renderValue } from './_format.js';

/** Official division metadata, joined independently of participant filtering. */
export const DivisionSchema = z
  .object({
    session: z.string().describe('Official parliament-session token.'),
    number: z.number().int().positive().describe('Division number within the session.'),
    dateTime: z.string().nullable().describe('Source Ottawa date-time, or null.'),
    subject: z.string().nullable().describe('Official division subject, or null.'),
    result: z.string().nullable().describe('Official result label, or null.'),
    yeas: z.number().int().nonnegative().nullable().describe('Official yea tally, or null.'),
    nays: z.number().int().nonnegative().nullable().describe('Official nay tally, or null.'),
    paired: z.number().int().nonnegative().nullable().describe('Official paired tally, or null.'),
    documentType: z.string().nullable().describe('Official document category, or null.'),
    billCode: z.string().nullable().describe('Linked canonical bill code, or null.'),
    url: z.string().describe('Official HTTPS division page.'),
  })
  .strict()
  .describe('Official House division metadata.');

/** Find divisions after applying every filter to the full selected session. */
export const searchVotesTool = tool('canparl_search_votes', {
  description:
    'Find recorded House divisions in one session by bill, result, document type, date, or subject. Return newest first and pass session plus number to canparl_get_vote. Omitted session resolves from the current official bill feed. Follow nextOffset with identical filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { query: 'subjectContains' },
  input: z.object({
    session: SessionInputSchema,
    billCode: OptionalStringSchema.describe('Exact bill code; accepts bill s321, S321, or S-321.'),
    result: OptionalStringSchema.describe(
      'Official result from vote_results; Passed and Failed are accepted aliases.',
    ),
    documentType: OptionalStringSchema.describe(
      'Official category from canparl_list_reference topic vote_document_types.',
    ),
    dateFrom: OptionalStringSchema.describe(
      'Inclusive Ottawa civil date YYYY-MM-DD; independently optional.',
    ),
    dateTo: OptionalStringSchema.describe(
      'Inclusive Ottawa civil date YYYY-MM-DD; independently optional.',
    ),
    subjectContains: OptionalStringSchema.describe(
      'Literal Unicode-normalized case-insensitive subject substring.',
    ),
    limit: LimitSchema,
    offset: OffsetSchema,
  }),
  output: z.object({
    session: z.string().describe('Resolved official session.'),
    total: z.number().int().nonnegative().describe('Exact matching count before pagination.'),
    divisions: z
      .array(DivisionSchema)
      .describe('Matching divisions, date-time descending then number descending.'),
    pagination: PaginationSchema.describe('Continuation within the filtered ordering.'),
    provenance: z.array(SourceSchema).describe('Source retrieval metadata.'),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        session: z.string().describe('Resolved session.'),
        billCode: z.string().nullable().describe('Canonical bill code, or null.'),
        result: z.string().nullable().describe('Canonical result, or null.'),
        documentType: z.string().nullable().describe('Canonical category, or null.'),
        dateFrom: z.string().nullable().describe('Inclusive lower date, or null.'),
        dateTo: z.string().nullable().describe('Inclusive upper date, or null.'),
        subjectContains: z.string().nullable().describe('Trimmed literal substring, or null.'),
      })
      .strict()
      .describe('Normalized AND filters.'),
    totalCount: z.number().int().nonnegative().describe('Exact matching count.'),
    shown: z.number().int().nonnegative().describe('Returned division count.'),
    cap: z.number().int().positive().describe('Requested page limit.'),
    truncated: z.boolean().describe('Whether more matches remain.'),
    notice: z.string().optional().describe('Empty-result or past-end guidance.'),
  },
  enrichmentTrailer: {
    appliedFilters: { render: (value) => renderValue(value, 'appliedFilters') },
  },
  errors: [
    {
      reason: 'unsupported_vote_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Session absent from the official division picker.',
      recovery:
        'Call canparl_list_reference with topic sessions and choose a session supporting House divisions.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_vote_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Bill code, result, or document category is unrecognized.',
      recovery:
        'Call canparl_list_reference with topic vote_results or vote_document_types, then retry canparl_search_votes with the canonical value.',
      retryable: false,
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A date is invalid or the bounds are reversed.',
      recovery:
        'Retry canparl_search_votes with real YYYY-MM-DD dates and dateFrom no later than dateTo.',
      retryable: false,
    },
  ],
  async handler(input, ctx) {
    const request = createRequestContext(ctx);
    try {
      const provenance = [];
      let session = normalizeSession(input.session);
      if (!session) {
        const current = await getLegisinfoService().getCurrentSession(request);
        session = current.data;
        provenance.push(...current.provenance);
      }
      let dateFrom: string | undefined;
      let dateTo: string | undefined;
      try {
        dateFrom = input.dateFrom ? normalizeDate(input.dateFrom) : undefined;
        dateTo = input.dateTo ? normalizeDate(input.dateTo) : undefined;
        validateDateRange(dateFrom, dateTo);
      } catch (error) {
        if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.ValidationError)
          throw error;
        throw ctx.fail('invalid_date_range', undefined, undefined, { cause: error });
      }
      const result = await getOurCommonsService().listVotes(session, request);
      provenance.push(...result.provenance);
      let billCode: string | null = null;
      let voteResult: string | null = null;
      let documentType: string | null = null;
      try {
        if (input.billCode) billCode = normalizeBillCode(input.billCode);
        if (input.result) {
          const key = vocabularyKey(input.result);
          voteResult = normalizeVocabulary(
            key === 'passed' ? 'Agreed To' : key === 'failed' ? 'Negatived' : input.result,
            extendVocabulary(
              VOTE_RESULTS,
              result.data.map((row) => row.result),
            ),
          );
        }
        if (input.documentType)
          documentType = normalizeVocabulary(
            input.documentType,
            extendVocabulary(
              VOTE_DOCUMENT_TYPES,
              result.data.map((row) => row.documentType),
            ),
          );
      } catch (error) {
        if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.ValidationError)
          throw error;
        throw ctx.fail('invalid_vote_filter', undefined, undefined, { cause: error });
      }
      const filtered = result.data
        .filter(
          (row) =>
            (!billCode || row.billCode === billCode) &&
            (!voteResult || row.result === voteResult) &&
            (!documentType || row.documentType === documentType) &&
            (!dateFrom || (row.dateTime !== null && row.dateTime.slice(0, 10) >= dateFrom)) &&
            (!dateTo || (row.dateTime !== null && row.dateTime.slice(0, 10) <= dateTo)) &&
            (!input.subjectContains || includesText(row.subject, input.subjectContains)),
        )
        .sort((a, b) => (b.dateTime ?? '').localeCompare(a.dateTime ?? '') || b.number - a.number);
      const page = paginate(filtered, input.offset, input.limit);
      ctx.enrich({
        appliedFilters: {
          session,
          billCode,
          result: voteResult,
          documentType,
          dateFrom: dateFrom ?? null,
          dateTo: dateTo ?? null,
          subjectContains: input.subjectContains ?? null,
        },
        shown: page.items.length,
        cap: input.limit,
        truncated: page.pagination.hasMore,
      });
      ctx.enrich.total(page.total);
      const notices = [];
      if (!page.total)
        notices.push(
          'No divisions matched; broaden the dates or remove billCode, result, or subjectContains and retry canparl_search_votes.',
        );
      if (input.offset > 0 && input.offset >= page.total)
        notices.push('Retry canparl_search_votes with offset 0 for the same session and filters.');
      if (notices.length) ctx.enrich.notice(notices.join(' '));
      request.throwIfOuterAborted();
      return {
        session,
        total: page.total,
        divisions: page.items,
        pagination: page.pagination,
        provenance,
      };
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
