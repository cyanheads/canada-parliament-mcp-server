/** @fileoverview Complete official-session division search. @module mcp-server/tools/definitions/search-votes.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  clampCount,
  filterFailure,
  includesText,
  normalizeBillCode,
  normalizeDate,
  normalizeFilter,
  normalizeSession,
  normalizeVocabulary,
  paginate,
  validateDateRange,
} from '@/domain/normalization.js';
import {
  extendVocabulary,
  VOTE_DOCUMENT_TYPES,
  VOTE_RESULT_ALIASES,
  VOTE_RESULTS,
} from '@/domain/reference-catalog.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  LIST_CAP,
  LimitSchema,
  OffsetSchema,
  OptionalStringSchema,
  PaginationSchema,
  SessionInputSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import { getLegisinfoService } from '@/services/legisinfo/index.js';
import { getOurCommonsService } from '@/services/ourcommons/index.js';
import { fitResponsePage, formatResult, measuredTrailer } from './_format.js';

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

const enrichment = {
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
  cap: z.number().int().positive().describe('Effective page limit after the per-call cap.'),
  truncated: z.boolean().describe('Whether more matches remain.'),
  notice: z
    .string()
    .optional()
    .describe('Limit clamp, empty-result, past-end, or response-budget guidance.'),
};

/** Find divisions after applying every filter to the full selected session. */
export const searchVotesTool = tool('canparl_search_votes', {
  description:
    'Find recorded House divisions in one session by bill, result, document type, date, or subject. Return newest first and pass session plus number to canparl_get_vote. Omitted session resolves from the current official bill feed. Follow nextOffset with identical filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { query: 'subjectContains' },
  input: z.object({
    session: SessionInputSchema,
    billCode: OptionalStringSchema.describe(
      'Exact bill code, including a split-bill suffix letter such as C-15A; accepts bill s321, S321, S 321, or S-321.',
    ),
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
    limit: LimitSchema.describe(
      'Maximum rows, default 25, effective cap 100; values through 10000 are accepted and clamp with a notice. Whole records may end the page early at the 24000-byte response budget; follow nextOffset.',
    ),
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
  enrichment,
  enrichmentTrailer: measuredTrailer(enrichment),
  errors: [
    {
      reason: 'unsupported_vote_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Session malformed or absent from the official division picker.',
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
        'Retry canparl_search_votes with a value or bill-code shape the error names; canparl_list_reference topics vote_results and vote_document_types list results and categories.',
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
    {
      reason: 'upstream_blocked',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'An official parliamentary source refuses the request with HTTP 403.',
      recovery: 'Retry the affected official source later for parliamentary data.',
      retryable: false,
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const request = createRequestContext(ctx);
    try {
      const limit = clampCount('limit', input.limit, LIST_CAP);
      let requested: string | undefined;
      try {
        requested = normalizeFilter('session', input.session, (value) => normalizeSession(value));
      } catch (error) {
        throw ctx.fail('unsupported_vote_session', ...filterFailure(error));
      }
      const resolved = await getLegisinfoService().resolveSession(requested, request);
      const session = resolved.data;
      const provenance = [...resolved.provenance];
      let dateFrom: string | undefined;
      let dateTo: string | undefined;
      try {
        dateFrom = normalizeFilter('dateFrom', input.dateFrom, normalizeDate);
        dateTo = normalizeFilter('dateTo', input.dateTo, normalizeDate);
        normalizeFilter('dateFrom', dateFrom, (from) => validateDateRange(from, dateTo));
      } catch (error) {
        throw ctx.fail('invalid_date_range', ...filterFailure(error));
      }
      const result = await getOurCommonsService().listVotes(session, request);
      provenance.push(...result.provenance);
      let billCode: string | null;
      let voteResult: string | null;
      let documentType: string | null;
      try {
        billCode = normalizeFilter('billCode', input.billCode, normalizeBillCode) ?? null;
        const results = extendVocabulary(
          VOTE_RESULTS,
          result.data.map((row) => row.result),
        );
        voteResult =
          normalizeFilter('result', input.result, (value) =>
            normalizeVocabulary(value, results, VOTE_RESULT_ALIASES),
          ) ?? null;
        const documentTypes = extendVocabulary(
          VOTE_DOCUMENT_TYPES,
          result.data.map((row) => row.documentType),
        );
        documentType =
          normalizeFilter('documentType', input.documentType, (value) =>
            normalizeVocabulary(value, documentTypes),
          ) ?? null;
      } catch (error) {
        throw ctx.fail('invalid_vote_filter', ...filterFailure(error));
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
      const page = paginate(filtered, input.offset, limit.value);
      const notices: string[] = [];
      if (limit.notice) notices.push(limit.notice);
      if (!page.total)
        notices.push(
          'No divisions matched; broaden the dates or remove billCode, result, or subjectContains and retry canparl_search_votes.',
        );
      if (input.offset > 0 && input.offset >= page.total)
        notices.push('Retry canparl_search_votes with offset 0 for the same session and filters.');
      const { result: response, enriched } = fitResponsePage(
        page.items.length,
        'canparl_search_votes',
        (count, budgetNotice) => {
          const selected = paginate(filtered, input.offset, count);
          const notice = [...notices, ...(budgetNotice ? [budgetNotice] : [])].join(' ');
          return {
            result: {
              session,
              total: page.total,
              divisions: selected.items,
              pagination: { ...selected.pagination, limit: limit.value },
              provenance,
            },
            enriched: {
              appliedFilters: {
                session,
                billCode,
                result: voteResult,
                documentType,
                dateFrom: dateFrom ?? null,
                dateTo: dateTo ?? null,
                subjectContains: input.subjectContains ?? null,
              },
              totalCount: page.total,
              shown: selected.items.length,
              cap: limit.value,
              truncated: selected.pagination.hasMore,
              ...(notice ? { notice } : {}),
            },
          };
        },
      );
      ctx.enrich(enriched);
      request.throwIfOuterAborted();
      return response;
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
