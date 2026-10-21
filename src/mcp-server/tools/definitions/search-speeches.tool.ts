/**
 * @fileoverview Bounded House Hansard scan with historical affiliation enrichment.
 * @module mcp-server/tools/definitions/search-speeches.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  includesText,
  normalizeBillCode,
  normalizeDate,
  normalizeSession,
  normalizeSlug,
  validateDateRange,
} from '@/domain/normalization.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  OffsetSchema,
  OptionalStringSchema,
  SessionInputSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import {
  type BillReference,
  getOpenParliamentService,
  type Membership,
  type Speech,
} from '@/services/openparliament/index.js';
import { formatResult, renderValue } from './_format.js';

const BillScopeSchema = z
  .object({
    session: SessionInputSchema.describe('Required explicit parliament-session for this bill.'),
    code: OptionalStringSchema.describe('Required bill code; accepts bill s321, S321, or S-321.'),
  })
  .strict()
  .describe('Explicit bill identity from canparl_search_bills.');

const SpeechSchema = z
  .object({
    id: z.string().describe('Source speech identifier.'),
    speaker: z.string().nullable().describe('English source attribution, or null.'),
    politician: z
      .string()
      .nullable()
      .describe('OpenParliament speaker slug, or null for institutional speakers.'),
    membershipUrl: z.string().nullable().describe('Historical membership HTTPS URL, or null.'),
    party: z
      .string()
      .nullable()
      .describe('Party from the speech-date membership, or null when unavailable.'),
    riding: z
      .string()
      .nullable()
      .describe('Riding from the speech-date membership, or null when unavailable.'),
    time: z.string().describe('Original Ottawa civil date-time; no timezone offset is invented.'),
    h1: z.string().nullable().describe('English primary heading, or null.'),
    h2: z.string().nullable().describe('English secondary heading, or null.'),
    content: z
      .string()
      .nullable()
      .describe('Complete English plain text, or null when unavailable.'),
    procedural: z
      .boolean()
      .nullable()
      .describe('Source procedural flag, or null when unavailable.'),
    url: z.string().describe('Absolute HTTPS speech link.'),
    debateUrl: z.string().nullable().describe('Absolute HTTPS House debate document link.'),
  })
  .strict()
  .describe('One indexed House speech with complete text and historical affiliation.');

/** Find indexed House speeches without treating a bounded negative scan as absence. */
export const searchSpeechesTool = tool('canparl_search_speeches', {
  description:
    'Find indexed House Hansard speeches by speaker, bill debated or mentioned, or date. contains scans at most 100 candidate speeches per call; follow nextOffset without changing filters until exhausted before drawing a negative conclusion.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    politician: OptionalStringSchema.describe(
      'Speaker slug or exact OpenParliament politician path/HTTPS URL from canparl_search_members.',
    ),
    billDebated: BillScopeSchema.optional().describe(
      'Bill debated; combined with all other scopes using AND.',
    ),
    mentionedBill: BillScopeSchema.optional().describe(
      'Bill mentioned; combined with all other scopes using AND.',
    ),
    dateFrom: OptionalStringSchema.describe(
      'Inclusive Ottawa civil date lower bound, YYYY-MM-DD; independently optional.',
    ),
    dateTo: OptionalStringSchema.describe(
      'Inclusive Ottawa civil date upper bound, YYYY-MM-DD; independently optional.',
    ),
    substantiveOnly: z
      .boolean()
      .default(true)
      .describe(
        'Exclude procedural remarks when true; false includes substantive and procedural remarks.',
      ),
    contains: OptionalStringSchema.describe(
      'Local case-insensitive Unicode-normalized literal English text substring; cannot be the only scope.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe('Maximum returned matches, 1–10; candidate pages contain 20 rows.'),
    offset: OffsetSchema.describe(
      'Raw candidate offset; keep every filter identical when continuing.',
    ),
  }),
  output: z.object({
    speeches: z
      .array(SpeechSchema)
      .describe('Matching House speeches in source order with complete English prose.'),
    scanned: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Raw candidates actually visited, including excluded committee records; at most 100.',
      ),
    exhausted: z
      .boolean()
      .describe('True only after visiting every row of a source-terminal page.'),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('First unvisited raw candidate offset, or null when exhausted.'),
    provenance: z
      .array(SourceSchema)
      .describe(
        'Original retrieval metadata for scope validation, candidate pages, and successful membership retrievals.',
      ),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        politician: z.string().nullable().describe('Normalized verified speaker slug, or null.'),
        billDebated: z
          .string()
          .nullable()
          .describe('Exact applied bill_debated source path, or null.'),
        mentionedBill: z
          .string()
          .nullable()
          .describe('Exact applied mentioned_bill source path, or null.'),
        dateFrom: z.string().nullable().describe('Inclusive normalized lower date, or null.'),
        dateTo: z.string().nullable().describe('Inclusive normalized upper date, or null.'),
        substantiveOnly: z.boolean().describe('Whether procedural=false was applied and verified.'),
        contains: z
          .string()
          .nullable()
          .describe('Trimmed local literal English text filter, or null.'),
        offset: z.number().int().nonnegative().describe('Requested raw candidate offset.'),
      })
      .strict()
      .describe(
        'All normalized filters applied with AND; bill relationships rely on the source endpoint.',
      ),
    shown: z.number().int().nonnegative().describe('Number of returned matching speeches.'),
    cap: z.number().int().positive().describe('Requested maximum returned matches.'),
    truncated: z
      .boolean()
      .describe(
        'Whether raw candidates remain to be scanned; not an exact count of further matches.',
      ),
    excludedCommittees: z
      .number()
      .int()
      .nonnegative()
      .describe('Visited candidates excluded because they were not House debate documents.'),
    notice: z
      .string()
      .optional()
      .describe('Coverage, continuation, procedural-filter, and unavailable affiliation guidance.'),
  },
  enrichmentTrailer: {
    appliedFilters: { render: (value) => renderValue(value, 'appliedFilters') },
  },
  errors: [
    {
      reason: 'speech_scope_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No speaker, bill, or date bound is supplied.',
      recovery:
        'Retry canparl_search_speeches with politician from canparl_search_members, a bill from canparl_search_bills, or a date bound.',
    },
    {
      reason: 'invalid_speech_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A slug, bill, or date is malformed, incomplete, or has reversed bounds.',
      recovery:
        'Call canparl_list_reference with topic sessions, then retry canparl_search_speeches with canonical identifiers and valid date bounds.',
    },
    {
      reason: 'speech_entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A supplied speaker or bill is absent from OpenParliament.',
      recovery:
        'Call canparl_search_members or canparl_search_bills to verify the identifier; OpenParliament may not yet index the official record.',
    },
    {
      reason: 'upstream_filter_not_honored',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      when: 'A returned candidate violates an applied speaker, time, or procedural filter.',
      recovery:
        'Narrow the dates or use canparl_get_bill/canparl_get_member to inspect source records before retrying canparl_search_speeches.',
    },
  ],
  async handler(input, ctx) {
    const request = createRequestContext(ctx);
    try {
      let politician: string | undefined;
      let billDebated: BillReference | undefined;
      let mentionedBill: BillReference | undefined;
      let dateFrom: string | undefined;
      let dateTo: string | undefined;
      try {
        politician = input.politician ? normalizeSlug(input.politician) : undefined;
        const normalizeBill = (
          bill: z.infer<typeof BillScopeSchema> | undefined,
        ): BillReference | undefined => {
          if (!bill) return undefined;
          const session = normalizeSession(bill.session);
          if (!session || !bill.code) throw ctx.fail('invalid_speech_filter');
          return { session, code: normalizeBillCode(bill.code) };
        };
        billDebated = normalizeBill(input.billDebated);
        mentionedBill = normalizeBill(input.mentionedBill);
        dateFrom = input.dateFrom ? normalizeDate(input.dateFrom) : undefined;
        dateTo = input.dateTo ? normalizeDate(input.dateTo) : undefined;
        validateDateRange(dateFrom, dateTo);
        if (dateTo === '9999-12-31') throw ctx.fail('invalid_speech_filter');
      } catch (error) {
        throw ctx.fail('invalid_speech_filter', undefined, undefined, { cause: error });
      }
      if (!politician && !billDebated && !mentionedBill && !dateFrom && !dateTo)
        throw ctx.fail('speech_scope_required');
      const service = getOpenParliamentService();
      const provenance: z.infer<typeof SourceSchema>[] = [];
      try {
        if (politician) {
          const profile = await service.getPolitician(politician, request);
          provenance.push(...profile.provenance);
        }
        const bills = new Map(
          [billDebated, mentionedBill]
            .filter((bill) => bill !== undefined)
            .map((bill) => [`${bill.session}/${bill.code}`, bill]),
        );
        for (const bill of bills.values()) {
          const detail = await service.getBill(bill.session, bill.code, request);
          provenance.push(...detail.provenance);
        }
      } catch (error) {
        request.throwIfAborted();
        if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)
          throw ctx.fail('speech_entity_not_found', undefined, undefined, { cause: error });
        throw error;
      }
      const matches: Speech[] = [];
      let scanned = 0;
      let excludedCommittees = 0;
      let exhausted = false;
      let nextOffset: number | null = input.offset;
      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        request.throwIfAborted();
        if (nextOffset === null) break;
        const pageOffset: number = nextOffset;
        const page = await service.listSpeeches(
          {
            ...(politician ? { politician } : {}),
            ...(billDebated ? { billDebated } : {}),
            ...(mentionedBill ? { mentionedBill } : {}),
            ...(dateFrom ? { dateFrom } : {}),
            ...(dateTo ? { dateTo } : {}),
            substantiveOnly: input.substantiveOnly,
            limit: 20,
            offset: pageOffset,
          },
          request,
        );
        provenance.push(...page.provenance);
        let visited = 0;
        for (const speech of page.objects) {
          request.throwIfAborted();
          visited++;
          scanned++;
          const date = speech.time.slice(0, 10);
          if (
            (politician && speech.politician !== politician) ||
            (dateFrom && date < dateFrom) ||
            (dateTo && date > dateTo) ||
            (input.substantiveOnly && speech.procedural !== false)
          )
            throw ctx.fail('upstream_filter_not_honored');
          if (
            !speech.debateUrl ||
            !new URL(speech.debateUrl).pathname.startsWith('/debates/') ||
            new URL(speech.url).pathname.startsWith('/committees/')
          ) {
            excludedCommittees++;
          } else if (!input.contains || includesText(speech.content, input.contains)) {
            matches.push(speech);
          }
          if (matches.length === input.limit) break;
        }
        exhausted = visited === page.objects.length && page.nextOffset === null;
        nextOffset = exhausted
          ? null
          : visited < page.objects.length
            ? pageOffset + visited
            : page.nextOffset;
        if (matches.length === input.limit || exhausted) break;
      }
      const memberships = new Map<string, Membership | null>();
      const unavailable = new Set<string>();
      for (const speech of matches) {
        request.throwIfOuterAborted();
        const url = speech.membershipUrl;
        if (!url || memberships.has(url)) continue;
        try {
          request.throwIfAborted();
          const result = await service.getMembership(url, request);
          provenance.push(...result.provenance);
          memberships.set(url, result.data);
        } catch (error) {
          request.throwIfOuterAborted();
          if (
            !(error instanceof McpError) ||
            ![
              JsonRpcErrorCode.NotFound,
              JsonRpcErrorCode.ServiceUnavailable,
              JsonRpcErrorCode.Timeout,
              JsonRpcErrorCode.RateLimited,
            ].includes(error.code)
          )
            throw error;
          memberships.set(url, null);
          unavailable.add(
            error.code === JsonRpcErrorCode.Timeout ? 'Timeout' : 'SourceUnavailable',
          );
        }
      }
      let missingAffiliations = 0;
      const speeches = matches.map((speech) => {
        const membership = speech.membershipUrl ? memberships.get(speech.membershipUrl) : null;
        const date = speech.time.slice(0, 10);
        const valid =
          membership &&
          membership.startDate !== null &&
          membership.startDate <= date &&
          (membership.endDate === null || membership.endDate >= date) &&
          (!speech.politician ||
            membership.politicianUrl ===
              `https://openparliament.ca/politicians/${speech.politician}/`);
        const party = valid ? (membership.party.name ?? membership.party.shortName) : null;
        const riding = valid ? membership.riding : null;
        if (party === null || riding === null) missingAffiliations++;
        return { ...speech, party, riding };
      });
      const notices = [
        input.substantiveOnly
          ? 'substantiveOnly=true excludes procedural remarks; set substantiveOnly=false to include them.'
          : 'substantiveOnly=false includes procedural and substantive remarks.',
      ];
      if (excludedCommittees)
        notices.push(
          'Non-House or committee candidates were excluded and are included in scanned and excludedCommittees.',
        );
      if (missingAffiliations)
        notices.push(
          'Historical party or riding is unavailable for some returned speeches; nulls never substitute current affiliation.',
        );
      if (unavailable.size)
        notices.push(
          `Optional historical membership enrichment was unavailable (${[...unavailable].join(', ')}).`,
        );
      if (!speeches.length)
        notices.push(
          exhausted
            ? 'No indexed speeches matched; broaden dates or remove contains and retry canparl_search_speeches. This does not establish that no parliamentary speech occurred.'
            : 'No text matches among the scanned candidates; call canparl_search_speeches with nextOffset and identical filters to continue.',
        );
      const path = (bill: BillReference | undefined) =>
        bill ? `/bills/${bill.session}/${bill.code}/` : null;
      ctx.enrich({
        appliedFilters: {
          politician: politician ?? null,
          billDebated: path(billDebated),
          mentionedBill: path(mentionedBill),
          dateFrom: dateFrom ?? null,
          dateTo: dateTo ?? null,
          substantiveOnly: input.substantiveOnly,
          contains: input.contains ?? null,
          offset: input.offset,
        },
        shown: speeches.length,
        cap: input.limit,
        truncated: !exhausted,
        excludedCommittees,
      });
      ctx.enrich.notice(notices.join(' '));
      request.throwIfOuterAborted();
      return { speeches, scanned, exhausted, nextOffset, provenance };
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
