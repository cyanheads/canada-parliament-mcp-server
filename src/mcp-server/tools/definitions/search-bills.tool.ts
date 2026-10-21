/**
 * @fileoverview Complete official-session bill filtering with bounded sponsor intersection.
 * @module mcp-server/tools/definitions/search-bills.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  includesText,
  normalizeBillCode,
  normalizeChamber,
  normalizeSession,
  normalizeSlug,
  normalizeVocabulary,
  paginate,
} from '@/domain/normalization.js';
import { BILL_STATUSES, BILL_TYPES, extendVocabulary } from '@/domain/reference-catalog.js';
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
import { getOpenParliamentService } from '@/services/openparliament/index.js';
import { formatResult, renderValue } from './_format.js';
import { BillSummarySchema } from './get-bill.tool.js';

/** Find official bills after applying all filters to the complete selected session. */
export const searchBillsTool = tool('canparl_search_bills', {
  description:
    'Find House and Senate bills in one session by title, number, type, chamber, status, or indexed MP sponsor. Sponsor results are the OpenParliament-indexed subset; fetch a bill for its sponsor, stages, divisions, and statute citation. Omitted session means the verified current official session. Follow nextOffset with identical filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { query: 'titleContains' },
  input: z.object({
    session: SessionInputSchema,
    titleContains: OptionalStringSchema.describe(
      'Literal case-insensitive substring of any English or French long or short title.',
    ),
    billCode: OptionalStringSchema.describe('Exact bill code; accepts bill s321, S321, or S-321.'),
    originatingChamber: OptionalStringSchema.describe(
      'House, House of Commons, or Senate; case-insensitive.',
    ),
    billType: OptionalStringSchema.describe(
      'Official bill type from canparl_list_reference topic bill_types.',
    ),
    status: OptionalStringSchema.describe(
      'Official bill status from canparl_list_reference topic bill_statuses.',
    ),
    sponsor: OptionalStringSchema.describe(
      'Verified MP OpenParliament slug or politician path/HTTPS URL from canparl_search_members; Senators are not indexed.',
    ),
    limit: LimitSchema,
    offset: OffsetSchema,
  }),
  output: z.object({
    session: z.string().describe('Verified official parliament-session token.'),
    total: z
      .number()
      .int()
      .nonnegative()
      .describe('Exact matching count after all filters and before pagination.'),
    bills: z
      .array(BillSummarySchema)
      .describe('Matching official bills ordered by chamber prefix then numeric code.'),
    pagination: PaginationSchema.describe('Local continuation in the filtered ordering.'),
    sponsorCoverage: z
      .enum(['not_applied', 'openparliament_index'])
      .describe('Whether the result is restricted to the third-party sponsor index.'),
    provenance: z
      .array(SourceSchema)
      .describe('Original retrieval metadata from all source requests.'),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        session: z.string().describe('Resolved official session.'),
        titleContains: z.string().nullable().describe('Trimmed literal title filter, or null.'),
        billCode: z.string().nullable().describe('Canonical exact bill code, or null.'),
        originatingChamber: z
          .enum(['House', 'Senate'])
          .nullable()
          .describe('Canonical chamber, or null.'),
        billType: z.string().nullable().describe('Canonical official bill type, or null.'),
        status: z.string().nullable().describe('Canonical official status, or null.'),
        sponsor: z
          .string()
          .nullable()
          .describe('Verified canonical OpenParliament sponsor slug, or null.'),
      })
      .strict()
      .describe('Normalized filters applied together with AND.'),
    totalCount: z.number().int().nonnegative().describe('Exact matching count before slicing.'),
    shown: z.number().int().nonnegative().describe('Number of bills in this page.'),
    cap: z.number().int().positive().describe('Requested page limit.'),
    truncated: z.boolean().describe('Whether more matching bills remain after this page.'),
    notice: z.string().optional().describe('Coverage, empty-result, or past-end guidance.'),
  },
  enrichmentTrailer: {
    appliedFilters: { render: (value) => renderValue(value, 'appliedFilters') },
  },
  errors: [
    {
      reason: 'unknown_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Session absent from the official bill session index.',
      recovery: 'Call canparl_list_reference with topic sessions and choose a listed bill session.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_bill_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Malformed bill code or chamber, or unrecognized type or status.',
      recovery:
        'Call canparl_list_reference with topic bill_types or bill_statuses, then retry canparl_search_bills with a listed value.',
      retryable: false,
    },
    {
      reason: 'sponsor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Supplied sponsor slug has no profile.',
      recovery: 'Call canparl_search_members with a name and use its verified OpenParliament slug.',
      retryable: false,
    },
    {
      reason: 'sponsor_scan_incomplete',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The bounded ten-page sponsor scan still has a continuation.',
      recovery:
        'Call canparl_search_bills without sponsor and inspect a specific result with canparl_get_bill.',
      retryable: false,
    },
  ],
  async handler(input, ctx) {
    const request = createRequestContext(ctx);
    try {
      const official = getLegisinfoService();
      let session = normalizeSession(input.session);
      const provenance = [];
      if (session === undefined) {
        const current = await official.getCurrentSession(request);
        session = current.data;
        provenance.push(...current.provenance);
      }
      const result = await official.listBills(session, request);
      provenance.push(...result.provenance);
      let billCode: string | null = null;
      let originatingChamber: 'House' | 'Senate' | null = null;
      let billType: string | null = null;
      let status: string | null = null;
      try {
        if (input.billCode) billCode = normalizeBillCode(input.billCode);
        if (input.originatingChamber)
          originatingChamber = normalizeChamber(input.originatingChamber);
        if (input.billType)
          billType = normalizeVocabulary(
            input.billType,
            extendVocabulary(
              BILL_TYPES,
              result.data.map((bill) => bill.billType),
            ),
          );
        if (input.status)
          status = normalizeVocabulary(
            input.status,
            extendVocabulary(
              BILL_STATUSES,
              result.data.map((bill) => bill.status),
            ),
          );
      } catch (error) {
        if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.ValidationError)
          throw error;
        throw ctx.fail('invalid_bill_filter', undefined, undefined, { cause: error });
      }
      const sponsor = input.sponsor ? normalizeSlug(input.sponsor) : null;
      let sponsorKeys: Set<string> | null = null;
      if (sponsor !== null) {
        const index = getOpenParliamentService();
        try {
          const profile = await index.getPolitician(sponsor, request);
          provenance.push(...profile.provenance);
        } catch (error) {
          request.throwIfAborted();
          if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) {
            throw ctx.fail('sponsor_not_found', undefined, undefined, { cause: error });
          }
          throw error;
        }
        sponsorKeys = new Set<string>();
        let offset = 0;
        for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
          const page = await index.listBills({ session, sponsor, limit: 100, offset }, request);
          provenance.push(...page.provenance);
          for (const bill of page.objects) {
            if (bill.session !== session)
              throw serviceUnavailable('The sponsor index did not honor the requested session.', {
                reason: 'upstream_response_invalid',
                retryable: false,
              });
            sponsorKeys.add(`${bill.session}/${bill.billCode}`);
          }
          if (page.nextOffset === null) break;
          if (pageNumber === 9) throw ctx.fail('sponsor_scan_incomplete');
          offset = page.nextOffset;
        }
      }
      const titleContains = input.titleContains;
      const filtered = result.data
        .filter(
          (bill) =>
            (!sponsorKeys || sponsorKeys.has(`${bill.session}/${bill.billCode}`)) &&
            (!billCode || bill.billCode === billCode) &&
            (!originatingChamber || bill.originatingChamber === originatingChamber) &&
            (!billType || bill.billType === billType) &&
            (!status || bill.status === status) &&
            (!titleContains ||
              [bill.longTitle.en, bill.longTitle.fr, bill.shortTitle.en, bill.shortTitle.fr].some(
                (title) => includesText(title, titleContains),
              )),
        )
        .sort(
          (a, b) =>
            a.billCode.slice(0, 1).localeCompare(b.billCode.slice(0, 1)) ||
            Number(a.billCode.slice(2)) - Number(b.billCode.slice(2)),
        );
      const page = paginate(filtered, input.offset, input.limit);
      ctx.enrich({
        appliedFilters: {
          session,
          titleContains: input.titleContains ?? null,
          billCode,
          originatingChamber,
          billType,
          status,
          sponsor,
        },
        shown: page.items.length,
        cap: input.limit,
        truncated: page.pagination.hasMore,
      });
      ctx.enrich.total(page.total);
      const notices: string[] = [];
      if (page.total === 0)
        notices.push(
          'No bills matched the applied filters; remove titleContains, status, or billType and retry canparl_search_bills.',
        );
      if (sponsor)
        notices.push(
          "Sponsor coverage is limited to OpenParliament's index, which may lag and does not index Senators as politicians; use canparl_search_bills without sponsor and canparl_get_bill to check official sponsors.",
        );
      if (input.offset > 0 && input.offset >= page.total)
        notices.push(
          'This offset is past the matching bills; retry canparl_search_bills with offset 0.',
        );
      if (notices.length) ctx.enrich.notice(notices.join(' '));
      request.throwIfOuterAborted();
      return {
        session,
        total: page.total,
        bills: page.items,
        pagination: page.pagination,
        sponsorCoverage: sponsor ? ('openparliament_index' as const) : ('not_applied' as const),
        provenance,
      };
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
