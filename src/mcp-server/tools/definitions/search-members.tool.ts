/**
 * @fileoverview Complete current roster search and sparse historical name lookup.
 * @module mcp-server/tools/definitions/search-members.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  clampCount,
  filterFailure,
  includesText,
  normalizeFilter,
  normalizeProvince,
  normalizeVocabulary,
  paginate,
} from '@/domain/normalization.js';
import { extendVocabulary, OFFICIAL_PARTY_ALIASES, PARTIES } from '@/domain/reference-catalog.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  LIST_CAP,
  LimitSchema,
  OffsetSchema,
  OptionalStringSchema,
  PaginationSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import { getOpenParliamentService } from '@/services/openparliament/index.js';
import { getOurCommonsService } from '@/services/ourcommons/index.js';
import { fitResponsePage, formatResult, measuredTrailer } from './_format.js';

/** Identifiers and known member attributes without inferred historical facts. */
export const MemberSummarySchema = z
  .object({
    personId: z.string().nullable().describe('Official person ID, or null.'),
    slug: z.string().nullable().describe('Verified OpenParliament slug, or null.'),
    name: z.string().describe('Recorded full name.'),
    party: z.string().nullable().describe('Source caucus name, or null.'),
    riding: z.string().nullable().describe('Source riding name, or null.'),
    province: z.string().nullable().describe('Province or territory, or null.'),
    current: z
      .boolean()
      .nullable()
      .describe('Current official roster membership, or null if unverified.'),
    url: z.string().describe('Absolute HTTPS member profile URL.'),
    detailLookup: z
      .union([
        z
          .object({ personId: z.string().describe('Official identifier for canparl_get_member.') })
          .strict()
          .describe('Official member lookup.'),
        z
          .object({
            slug: z.string().describe('OpenParliament identifier for canparl_get_member.'),
          })
          .strict()
          .describe('Historical member lookup.'),
      ])
      .describe('Pass exactly this identifier to canparl_get_member.'),
  })
  .strict()
  .describe('Known public member identity.');

const enrichment = {
  totalCount: z
    .number()
    .int()
    .optional()
    .describe('Exact filtered current roster count; absent for historical searches.'),
  appliedFilters: z
    .object({
      includeFormer: z.boolean().describe('Selected historical mode.'),
      name: z.string().nullable().describe('Applied name text.'),
      nameMode: z
        .enum(['substring', 'surname', 'full_name', 'index'])
        .describe('Actual source name matching semantics.'),
      riding: z.string().nullable().describe('Applied riding substring.'),
      province: z.string().nullable().describe('Canonical province name.'),
      party: z.string().nullable().describe('Canonical official caucus.'),
    })
    .strict()
    .describe('Normalized AND filters and name semantics.'),
  shown: z.number().int().describe('Returned row count.'),
  cap: z.number().int().describe('Effective page limit after the per-call cap.'),
  truncated: z.boolean().describe('More queried rows remain.'),
  notice: z
    .string()
    .optional()
    .describe('Limit clamp, empty page, historical coverage, or response-budget guidance.'),
};

/** Search complete current roster or page the source historical name index. */
export const searchMembersTool = tool('canparl_search_members', {
  description:
    "Find current House MPs by name, riding, province, or caucus. Set includeFormer for OpenParliament's historical name index; historical rows may contain only a name and slug. Follow nextOffset with identical filters and use detailLookup with canparl_get_member.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    includeFormer: z
      .boolean()
      .default(false)
      .describe(
        'Use the sparse historical name index instead of the complete current official roster.',
      ),
    name: OptionalStringSchema.describe(
      'Current: literal name substring. Historical: one token is surname lookup; multiple tokens are full recorded name lookup, not substring search.',
    ),
    riding: OptionalStringSchema.describe('Literal riding substring; current roster only.'),
    province: OptionalStringSchema.describe(
      'Province postal code or full English name; current roster only.',
    ),
    party: OptionalStringSchema.describe(
      'Official caucus name; Bloc and Green aliases accepted; current roster only.',
    ),
    limit: LimitSchema.describe(
      'Maximum rows, default 25, effective cap 100; values through 10000 are accepted and clamp with a notice. Whole records may end the page early at the 24000-byte response budget; follow nextOffset.',
    ),
    offset: OffsetSchema,
  }),
  output: z.object({
    total: z
      .number()
      .int()
      .nullable()
      .describe('Exact filtered current count; null for historical index.'),
    members: z.array(MemberSummarySchema).describe('Returned member identities.'),
    pagination: PaginationSchema.describe('Continuation in the selected source ordering.'),
    provenance: z.array(SourceSchema).describe('Original source retrieval metadata.'),
  }),
  enrichment,
  enrichmentTrailer: measuredTrailer(enrichment),
  errors: [
    {
      reason: 'unsupported_historical_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Historical mode includes geographic or caucus filters.',
      recovery:
        'Retry canparl_search_members with includeFormer false for geographic or party filters, or omit those filters for historical name lookup.',
      retryable: false,
    },
    {
      reason: 'invalid_member_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown province or current caucus.',
      recovery:
        'Call canparl_list_reference with topic parties, then retry canparl_search_members with a listed caucus and a province code or full name.',
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
      if (input.includeFormer && (input.riding || input.province || input.party))
        throw ctx.fail('unsupported_historical_filter');
      const limit = clampCount('limit', input.limit, LIST_CAP);
      const notices: string[] = limit.notice ? [limit.notice] : [];
      if (input.includeFormer) {
        const nameMode: 'full_name' | 'surname' | 'index' = input.name
          ? /\s/u.test(input.name)
            ? 'full_name'
            : 'surname'
          : 'index';
        const page = await getOpenParliamentService().listPoliticians(
          {
            include: 'all',
            limit: limit.value,
            offset: input.offset,
            ...(nameMode === 'surname' && input.name
              ? { familyName: input.name }
              : input.name
                ? { name: input.name }
                : {}),
          },
          request,
        );
        const members = page.objects.map((row) => ({
          personId: null,
          slug: row.slug,
          name: row.name,
          party: null,
          riding: null,
          province: null,
          current: null,
          url: row.url,
          detailLookup: { slug: row.slug },
        }));
        if (!members.length)
          notices.push(
            input.offset
              ? 'Retry canparl_search_members with offset 0 and the same filters.'
              : 'Try a surname alone or the full recorded name with canparl_search_members includeFormer true.',
          );
        const { result, enriched } = fitResponsePage(
          members.length,
          'canparl_search_members',
          (count, budgetNotice) => {
            const nextOffset = count < members.length ? input.offset + count : page.nextOffset;
            const notice = [...notices, ...(budgetNotice ? [budgetNotice] : [])].join(' ');
            return {
              result: {
                total: null,
                members: members.slice(0, count),
                pagination: {
                  offset: input.offset,
                  limit: limit.value,
                  nextOffset,
                  hasMore: nextOffset !== null,
                },
                provenance: page.provenance,
              },
              enriched: {
                appliedFilters: {
                  includeFormer: true,
                  name: input.name ?? null,
                  nameMode,
                  riding: null,
                  province: null,
                  party: null,
                },
                shown: count,
                cap: limit.value,
                truncated: nextOffset !== null,
                ...(notice ? { notice } : {}),
              },
            };
          },
        );
        ctx.enrich(enriched);
        request.throwIfAborted();
        return result;
      }
      const roster = await getOurCommonsService().listMembers(request);
      let province: string | undefined;
      let party: string | undefined;
      try {
        province = normalizeFilter('province', input.province, normalizeProvince);
        const parties = extendVocabulary(
          PARTIES,
          roster.data.map((row) => row.party),
        );
        party = normalizeFilter('party', input.party, (value) =>
          normalizeVocabulary(value, parties, OFFICIAL_PARTY_ALIASES),
        );
      } catch (error) {
        throw ctx.fail('invalid_member_filter', ...filterFailure(error));
      }
      const rows = roster.data
        .filter(
          (row) =>
            (!input.name || includesText(row.name, input.name)) &&
            (!input.riding || includesText(row.riding, input.riding)) &&
            (!province || row.province === province) &&
            (!party || row.party === party),
        )
        .sort(
          (a, b) =>
            a.lastName.localeCompare(b.lastName, 'en-CA') ||
            a.firstName.localeCompare(b.firstName, 'en-CA') ||
            a.personId.localeCompare(b.personId),
        );
      const page = paginate(rows, input.offset, limit.value);
      const members = page.items.map(({ firstName: _first, lastName: _last, ...member }) =>
        MemberSummarySchema.parse(member),
      );
      if (!members.length)
        notices.push(
          input.offset && page.total
            ? 'Retry canparl_search_members with offset 0 and the same filters.'
            : 'No MPs matched; broaden name or riding and retry canparl_search_members.',
        );
      const { result, enriched } = fitResponsePage(
        members.length,
        'canparl_search_members',
        (count, budgetNotice) => {
          const nextOffset =
            count < members.length ? input.offset + count : page.pagination.nextOffset;
          const notice = [...notices, ...(budgetNotice ? [budgetNotice] : [])].join(' ');
          return {
            result: {
              total: page.total,
              members: members.slice(0, count),
              pagination: { ...page.pagination, nextOffset, hasMore: nextOffset !== null },
              provenance: roster.provenance,
            },
            enriched: {
              totalCount: page.total,
              appliedFilters: {
                includeFormer: false,
                name: input.name ?? null,
                nameMode: 'substring' as const,
                riding: input.riding ?? null,
                province: province ?? null,
                party: party ?? null,
              },
              shown: count,
              cap: limit.value,
              truncated: nextOffset !== null,
              ...(notice ? { notice } : {}),
            },
          };
        },
      );
      ctx.enrich(enriched);
      request.throwIfAborted();
      return result;
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
