/**
 * @fileoverview Complete official-session bill filtering with bounded sponsor intersection.
 * @module mcp-server/tools/definitions/search-bills.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  clampCount,
  filterFailure,
  includesText,
  normalizeBillCode,
  normalizeChamber,
  normalizeFilter,
  normalizeSlug,
  normalizeVocabulary,
  paginate,
} from '@/domain/normalization.js';
import { BILL_STATUSES, BILL_TYPES, extendVocabulary } from '@/domain/reference-catalog.js';
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
import { getOpenParliamentService } from '@/services/openparliament/index.js';
import { formatResult, renderValue } from './_format.js';
import { resolvePolitician } from './_member-identity.js';
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
    billCode: OptionalStringSchema.describe(
      'Exact bill code, including a split-bill suffix letter such as C-15A; accepts bill s321, S321, S 321, or S-321.',
    ),
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
      "MP OpenParliament slug or politician path/HTTPS URL (member.slug from canparl_get_member, or an includeFormer canparl_search_members row), or a current MP's official personId; Senators are not indexed. A digit-only value equal to a current personId, or its /politicians/<digits>/ path or profile URL, is read as that personId.",
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
      .describe(
        'Matching official bills ordered by chamber prefix, number, then split-bill suffix letter.',
      ),
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
        sponsorName: z
          .string()
          .nullable()
          .describe('Name on the verified OpenParliament sponsor profile, or null.'),
      })
      .strict()
      .describe('Normalized filters applied together with AND.'),
    totalCount: z.number().int().nonnegative().describe('Exact matching count before slicing.'),
    shown: z.number().int().nonnegative().describe('Number of bills in this page.'),
    cap: z.number().int().positive().describe('Effective page limit after the per-call cap.'),
    truncated: z.boolean().describe('Whether more matching bills remain after this page.'),
    notice: z
      .string()
      .optional()
      .describe('Limit clamp, coverage, empty-result, or past-end guidance.'),
  },
  enrichmentTrailer: {
    appliedFilters: { render: (value) => renderValue(value, 'appliedFilters') },
  },
  errors: [
    {
      reason: 'unknown_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Session malformed or absent from the official bill session index.',
      recovery: 'Call canparl_list_reference with topic sessions and choose a listed bill session.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_bill_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Malformed bill code, chamber, or sponsor slug, or unrecognized type or status.',
      recovery:
        "Retry canparl_search_bills with a value or shape the error names; canparl_list_reference topics bill_types and bill_statuses list types and statuses, and a sponsor is member.slug from canparl_get_member, a slug from an includeFormer canparl_search_members row, or a current MP's personId.",
      retryable: false,
    },
    {
      reason: 'sponsor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Sponsor slug has no profile of its own, or a current personId has no unique verified OpenParliament profile.',
      recovery:
        'Call canparl_search_members with includeFormer true and a surname or full name, then pass a returned slug as sponsor.',
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
      const limit = clampCount('limit', input.limit, LIST_CAP);
      const official = getLegisinfoService();
      const resolved = await official.resolveSession(input.session, request);
      const session = resolved.data;
      const provenance = [...resolved.provenance];
      const result = await official.listBills(session, request);
      provenance.push(...result.provenance);
      let billCode: string | null;
      let originatingChamber: 'House' | 'Senate' | null;
      let billType: string | null;
      let status: string | null;
      let sponsor: string | null;
      try {
        billCode = normalizeFilter('billCode', input.billCode, normalizeBillCode) ?? null;
        originatingChamber =
          normalizeFilter('originatingChamber', input.originatingChamber, normalizeChamber) ?? null;
        const types = extendVocabulary(
          BILL_TYPES,
          result.data.map((bill) => bill.billType),
        );
        billType =
          normalizeFilter('billType', input.billType, (value) =>
            normalizeVocabulary(value, types),
          ) ?? null;
        const statuses = extendVocabulary(
          BILL_STATUSES,
          result.data.map((bill) => bill.status),
        );
        status =
          normalizeFilter('status', input.status, (value) =>
            normalizeVocabulary(value, statuses),
          ) ?? null;
        sponsor = normalizeFilter('sponsor', input.sponsor, normalizeSlug) ?? null;
      } catch (error) {
        throw ctx.fail('invalid_bill_filter', ...filterFailure(error));
      }
      let sponsorKeys: Set<string> | null = null;
      let sponsorName: string | null = null;
      if (sponsor !== null) {
        const index = getOpenParliamentService();
        const profile = await resolvePolitician(sponsor, request, provenance);
        if (!profile) throw ctx.fail('sponsor_not_found');
        sponsor = profile.slug;
        sponsorName = profile.name;
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
            Number.parseInt(a.billCode.slice(2), 10) - Number.parseInt(b.billCode.slice(2), 10) ||
            a.billCode.localeCompare(b.billCode),
        );
      const page = paginate(filtered, input.offset, limit.value);
      ctx.enrich({
        appliedFilters: {
          session,
          titleContains: input.titleContains ?? null,
          billCode,
          originatingChamber,
          billType,
          status,
          sponsor,
          sponsorName,
        },
        shown: page.items.length,
        cap: limit.value,
        truncated: page.pagination.hasMore,
      });
      ctx.enrich.total(page.total);
      const notices: string[] = [];
      if (limit.notice) notices.push(limit.notice);
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
