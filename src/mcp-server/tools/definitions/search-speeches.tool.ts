/**
 * @fileoverview Bounded House Hansard scan with historical affiliation enrichment.
 * @module mcp-server/tools/definitions/search-speeches.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  clampCount,
  filterFailure,
  includesText,
  normalizeBillCode,
  normalizeDate,
  normalizeFilter,
  normalizeSession,
  normalizeSlug,
  rejectFilter,
  validateDateRange,
} from '@/domain/normalization.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  COUNT_CEILING,
  OffsetSchema,
  OptionalStringSchema,
  SessionInputSchema,
  type Source,
  SourceSchema,
} from '@/domain/schemas.js';
import {
  type BillReference,
  getOpenParliamentService,
  type Membership,
  type Speech,
} from '@/services/openparliament/index.js';
import { formatResult, measuredTrailer, RESPONSE_BUDGET, responseBytes } from './_format.js';
import { resolvePolitician } from './_member-identity.js';

const BillScopeSchema = z
  .object({
    session: SessionInputSchema.describe('Required explicit parliament-session for this bill.'),
    code: OptionalStringSchema.describe(
      'Required bill code, including a split-bill suffix letter such as C-15A; accepts bill s321, S321, S 321, or S-321.',
    ),
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
/** Per-call match cap; each match may hydrate one membership request. */
const MATCH_CAP = 10;
const enrichment = {
  appliedFilters: z
    .object({
      politician: z.string().nullable().describe('Normalized verified speaker slug, or null.'),
      politicianName: z
        .string()
        .nullable()
        .describe('Name on the verified OpenParliament speaker profile, or null.'),
      billDebated: z.string().nullable().describe('Selected debated-bill path, or null.'),
      mentionedBill: z.string().nullable().describe('Selected mentioned-bill path, or null.'),
      dateFrom: z.string().nullable().describe('Inclusive normalized lower date, or null.'),
      dateTo: z.string().nullable().describe('Inclusive normalized upper date, or null.'),
      substantiveOnly: z.boolean().describe('Whether procedural remarks were excluded.'),
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
  cap: z
    .number()
    .int()
    .positive()
    .describe('Effective maximum returned matches after the per-call cap.'),
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
    .describe(
      'Limit clamp, coverage, continuation, procedural-filter, unavailable affiliation, and response-budget guidance.',
    ),
};
/** Where a page ends: returned speeches, scan position, and the retrievals made before it. */
interface PageEnd {
  /** Response-budget stop after fitting speeches, or one speech exceeding the budget alone. */
  budget?: 'stopped' | 'exceeded';
  count: number;
  excluded: number;
  exhausted: boolean;
  nextOffset: number | null;
  scanned: number;
  /** Scope and candidate-page provenance entries; returned memberships follow them. */
  sources: number;
}

/** Find indexed House speeches without treating a bounded negative scan as absence. */
export const searchSpeechesTool = tool('canparl_search_speeches', {
  description:
    'Find indexed House Hansard speeches by speaker, bill debated or mentioned, or date. contains scans at most 100 candidate speeches per call; follow nextOffset without changing filters until exhausted before drawing a negative conclusion.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    politician: OptionalStringSchema.describe(
      "Speaker OpenParliament slug or exact politician path/HTTPS URL (member.slug from canparl_get_member, or an includeFormer canparl_search_members row), or a current MP's official personId. A digit-only value equal to a current personId, or its /politicians/<digits>/ path or profile URL, is read as that personId.",
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
      .max(COUNT_CEILING)
      .default(5)
      .describe(
        'Maximum returned matches, 1–10 per call; larger values up to 10000 clamp to 10 with a notice. A page ends early at the 24000-byte response budget, returning at least one match whole. Candidate pages contain 20 rows.',
      ),
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
        'Raw candidates visited, including excluded committee records; at most 100. A response-budget stop ends it before the first match not returned.',
      ),
    exhausted: z
      .boolean()
      .describe('True only after visiting every row of a source-terminal page.'),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'First unvisited raw candidate offset, or null when exhausted; after a response-budget stop, the first match not returned.',
      ),
    provenance: z
      .array(SourceSchema)
      .describe(
        'Original retrieval metadata for scope validation, candidate pages fetched before the page ended, and memberships of returned speeches.',
      ),
  }),
  enrichment,
  enrichmentTrailer: measuredTrailer(enrichment),
  errors: [
    {
      reason: 'speech_scope_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No speaker, bill, or date bound is supplied.',
      recovery:
        "Retry canparl_search_speeches with a politician (member.slug from canparl_get_member, a slug from an includeFormer canparl_search_members row, or a current MP's personId), a bill from canparl_search_bills, or a date bound.",
      retryable: false,
    },
    {
      reason: 'invalid_speech_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A slug, bill, or date is malformed, incomplete, or has reversed bounds.',
      recovery:
        "Retry canparl_search_speeches in the shape the error names: a politician slug (member.slug from canparl_get_member or an includeFormer canparl_search_members row) or a current MP's personId, a bill session and code from canparl_search_bills, and YYYY-MM-DD dates with dateFrom no later than dateTo.",
      retryable: false,
    },
    {
      reason: 'speech_entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A supplied speaker or bill is absent from OpenParliament, or a current personId has no unique verified profile.',
      recovery:
        'Call canparl_search_members with includeFormer true or canparl_search_bills to verify the identifier; OpenParliament may not yet index the official record.',
      retryable: false,
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
      const limit = clampCount('limit', input.limit, MATCH_CAP);
      let politician: string | undefined;
      let billDebated: BillReference | undefined;
      let mentionedBill: BillReference | undefined;
      let dateFrom: string | undefined;
      let dateTo: string | undefined;
      try {
        politician = normalizeFilter('politician', input.politician, normalizeSlug);
        const normalizeBill = (
          field: 'billDebated' | 'mentionedBill',
          bill: z.infer<typeof BillScopeSchema> | undefined,
        ): BillReference | undefined => {
          if (!bill) return undefined;
          // A bill scope requires both parts; an omitted part is rejected as an empty value.
          return {
            session: normalizeFilter(`${field}.session`, bill.session ?? '', (value) =>
              normalizeSession(value),
            ),
            code: normalizeFilter(`${field}.code`, bill.code ?? '', normalizeBillCode),
          };
        };
        billDebated = normalizeBill('billDebated', input.billDebated);
        mentionedBill = normalizeBill('mentionedBill', input.mentionedBill);
        dateFrom = normalizeFilter('dateFrom', input.dateFrom, normalizeDate);
        dateTo = normalizeFilter('dateTo', input.dateTo, normalizeDate);
        normalizeFilter('dateFrom', dateFrom, (from) => validateDateRange(from, dateTo));
        if (dateTo === '9999-12-31')
          throw rejectFilter('dateTo', 'Expected a date before 9999-12-31.');
      } catch (error) {
        throw ctx.fail('invalid_speech_filter', ...filterFailure(error));
      }
      if (!politician && !billDebated && !mentionedBill && !dateFrom && !dateTo)
        throw ctx.fail('speech_scope_required');
      const service = getOpenParliamentService();
      const provenance: Source[] = [];
      let politicianName: string | null = null;
      if (politician) {
        const profile = await resolvePolitician(politician, request, provenance);
        if (!profile) throw ctx.fail('speech_entity_not_found');
        politician = profile.slug;
        politicianName = profile.name;
      }
      try {
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
      type Hydration = {
        membership: Membership | null;
        sources: Source[];
        unavailable?: 'Timeout' | 'SourceUnavailable';
      };
      const memberships = new Map<string, Hydration>();
      /** One membership request per distinct URL; optional failures leave affiliation unavailable. */
      const hydrate = async (url: string): Promise<Hydration> => {
        const known = memberships.get(url);
        if (known) return known;
        let hydration: Hydration;
        try {
          request.throwIfAborted();
          const result = await service.getMembership(url, request);
          hydration = { membership: result.data, sources: result.provenance };
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
          hydration = {
            membership: null,
            sources: [],
            unavailable: error.code === JsonRpcErrorCode.Timeout ? 'Timeout' : 'SourceUnavailable',
          };
        }
        memberships.set(url, hydration);
        return hydration;
      };
      /** Party and riding from the membership in force on the speech date, never a current one. */
      const attribute = (speech: Speech, membership: Membership | null) => {
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
        return { ...speech, party, riding };
      };
      const path = (bill: BillReference | undefined) =>
        bill ? `/bills/${bill.session}/${bill.code}/` : null;
      const appliedFilters = {
        politician: politician ?? null,
        politicianName,
        billDebated: path(billDebated),
        mentionedBill: path(mentionedBill),
        dateFrom: dateFrom ?? null,
        dateTo: dateTo ?? null,
        substantiveOnly: input.substantiveOnly,
        contains: input.contains ?? null,
        offset: input.offset,
      };
      const accepted: ReturnType<typeof attribute>[] = [];
      /** The response a page ending at `end` returns. */
      const respond = (end: PageEnd) => {
        const speeches = accepted.slice(0, end.count);
        const notices = [
          ...(limit.notice ? [limit.notice] : []),
          input.substantiveOnly
            ? 'substantiveOnly=true excludes procedural remarks; set substantiveOnly=false to include them.'
            : 'substantiveOnly=false includes procedural and substantive remarks.',
        ];
        if (end.excluded)
          notices.push(
            'Non-House or committee candidates were excluded and are included in scanned and excludedCommittees.',
          );
        if (speeches.some((speech) => speech.party === null || speech.riding === null))
          notices.push(
            'Historical party or riding is unavailable for some returned speeches; nulls never substitute current affiliation.',
          );
        const unavailable = new Set(
          speeches.flatMap((speech) => {
            const reason = speech.membershipUrl
              ? memberships.get(speech.membershipUrl)?.unavailable
              : undefined;
            return reason ? [reason] : [];
          }),
        );
        if (unavailable.size)
          notices.push(
            `Optional historical membership enrichment was unavailable (${[...unavailable].join(', ')}).`,
          );
        if (!speeches.length)
          notices.push(
            !end.exhausted
              ? 'No text matches among the scanned candidates; call canparl_search_speeches with nextOffset and identical filters to continue.'
              : input.offset > 0 && end.scanned === 0
                ? 'This offset is past the last indexed candidate; retry canparl_search_speeches with offset 0 and identical filters.'
                : 'No indexed speeches matched; broaden dates or remove contains and retry canparl_search_speeches. This does not establish that no parliamentary speech occurred.',
          );
        const resume =
          'call canparl_search_speeches with nextOffset and identical filters to continue.';
        if (end.budget === 'exceeded')
          notices.push(
            `The response exceeds the ${RESPONSE_BUDGET}-byte budget with one speech, returned whole${end.exhausted ? '.' : `; ${resume}`}`,
          );
        else if (end.budget === 'stopped')
          notices.push(
            `The ${RESPONSE_BUDGET}-byte response budget ended this page after ${speeches.length} ${speeches.length === 1 ? 'speech' : 'speeches'}; ${resume}`,
          );
        const hydrated = new Set(speeches.flatMap(({ membershipUrl }) => membershipUrl ?? []));
        const result = {
          speeches,
          scanned: end.scanned,
          exhausted: end.exhausted,
          nextOffset: end.nextOffset,
          provenance: [
            ...provenance.slice(0, end.sources),
            ...[...hydrated].flatMap((url) => memberships.get(url)?.sources ?? []),
          ],
        };
        const enriched = {
          appliedFilters,
          shown: speeches.length,
          cap: limit.value,
          truncated: !end.exhausted,
          excludedCommittees: end.excluded,
          notice: notices.join(' '),
        };
        return { result, enriched };
      };
      const bytes = (end: PageEnd) => {
        const { result, enriched } = respond(end);
        return responseBytes(result, enriched);
      };
      let scanned = 0;
      let excluded = 0;
      let exhausted = false;
      let nextOffset: number | null = input.offset;
      let end: PageEnd | undefined;
      /** The page ending right after the last accepted speech, measured to fit the budget. */
      let afterLast: PageEnd | undefined;
      /** Accepted source speeches with the page ends just before and just after each one. */
      const found: { speech: Speech; before: PageEnd; after: PageEnd }[] = [];
      scan: for (let pageNumber = 0; pageNumber < 5 && nextOffset !== null; pageNumber++) {
        request.throwIfAborted();
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
        for (const [index, speech] of page.objects.entries()) {
          request.throwIfOuterAborted();
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
            excluded++;
            scanned++;
            continue;
          }
          if (input.contains && !includesText(speech.content, input.contains)) {
            scanned++;
            continue;
          }
          const before: PageEnd = {
            count: accepted.length,
            scanned,
            excluded,
            sources: provenance.length,
            exhausted: false,
            nextOffset: pageOffset + index,
            budget: 'stopped',
          };
          accepted.push(attribute(speech, null));
          scanned++;
          const last = index === page.objects.length - 1;
          const after: PageEnd = {
            count: accepted.length,
            scanned,
            excluded,
            sources: provenance.length,
            exhausted: last && page.nextOffset === null,
            nextOffset: last ? page.nextOffset : pageOffset + index + 1,
          };
          found.push({ speech, before, after });
          const stopped: PageEnd = { ...after, budget: 'stopped' };
          if (bytes(stopped) > RESPONSE_BUDGET) {
            // Only a first speech may exceed alone; a later one is left for the next call.
            end = !afterLast
              ? { ...after, budget: 'exceeded' }
              : bytes(before) <= RESPONSE_BUDGET
                ? before
                : afterLast;
            break scan;
          }
          afterLast = stopped;
          if (accepted.length === limit.value) {
            end = after;
            break scan;
          }
        }
        exhausted = page.nextOffset === null;
        nextOffset = page.nextOffset;
      }
      end ??= {
        count: accepted.length,
        scanned,
        excluded,
        sources: provenance.length,
        exhausted,
        nextOffset,
      };
      // Candidates scanned after the last accepted speech can still outgrow the budget.
      if (!end.budget && afterLast && bytes(end) > RESPONSE_BUDGET) end = afterLast;
      // Memberships hydrate after the scan, so a slow optional lookup never spends the upstream
      // budget required candidate pages need. Affiliation text can outgrow the scan's measure; the
      // first speech that no longer fits is the one rejected, and the page ends before it.
      for (const [index, { speech, before, after }] of found.slice(0, end.count).entries()) {
        request.throwIfOuterAborted();
        const hydration = speech.membershipUrl ? await hydrate(speech.membershipUrl) : null;
        accepted[index] = attribute(speech, hydration?.membership ?? null);
        if (end.budget === 'exceeded') continue;
        const stopped: PageEnd = { ...after, budget: 'stopped' };
        const final = index === end.count - 1;
        if (bytes(final ? end : stopped) <= RESPONSE_BUDGET) continue;
        if (final && bytes(stopped) <= RESPONSE_BUDGET) {
          end = stopped;
          continue;
        }
        const previous = found[index - 1];
        end = !previous
          ? { ...after, budget: 'exceeded' }
          : bytes(before) <= RESPONSE_BUDGET
            ? before
            : { ...previous.after, budget: 'stopped' };
        break;
      }
      const { result, enriched } = respond(end);
      ctx.enrich(enriched);
      request.throwIfOuterAborted();
      return result;
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
