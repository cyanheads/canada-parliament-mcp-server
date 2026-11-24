/**
 * @fileoverview Bounded House Hansard scan with historical affiliation enrichment.
 * @module mcp-server/tools/definitions/search-speeches.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  BILL_CODE_FORMAT,
  clampCount,
  DATE_FORMAT,
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
  optionalFormat,
  RequiredSessionSchema,
  requiredFormat,
  type Source,
  SourceSchema,
} from '@/domain/schemas.js';
import {
  type BillReference,
  getOpenParliamentService,
  type Membership,
  type Speech,
} from '@/services/openparliament/index.js';
import { formatResult, measuredTrailer } from './_format.js';
import { formerMemberNotice, formerMemberRecovery, resolvePolitician } from './_member-identity.js';

const BillScopeSchema = z
  .object({
    session: RequiredSessionSchema.describe('Required explicit parliament-session for this bill.'),
    code: requiredFormat(BILL_CODE_FORMAT).describe(
      'Required bill code, including a split-bill suffix letter such as C-15A; accepts bill s321, S321, S 321, or S-321.',
    ),
  })
  .strict()
  .describe('Explicit bill identity from canparl_search_bills.');

/** Hansard languages; OpenParliament publishes both on every speech row. */
const LanguageSchema = z.enum(['en', 'fr']);
const LANGUAGE_NAMES = { en: 'English', fr: 'French' } as const;
const SpeechSchema = z
  .object({
    id: z.string().describe('Source speech identifier.'),
    speaker: z
      .string()
      .nullable()
      .describe('Source attribution in the selected language, or null when absent or blank.'),
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
    h1: z
      .string()
      .nullable()
      .describe('Primary heading in the selected language, or null when absent or blank.'),
    h2: z
      .string()
      .nullable()
      .describe('Secondary heading in the selected language, or null when absent or blank.'),
    content: z
      .string()
      .nullable()
      .describe(
        'Complete plain text in the selected language, or null when that language has none; never filled from the other language.',
      ),
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
        .describe('Trimmed local literal text filter applied to the selected language, or null.'),
      language: LanguageSchema.describe(
        'Selected Hansard language of the returned text and of the contains scan.',
      ),
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
      'Former-MP personId disclosure, limit clamp, coverage, continuation, procedural-filter, candidates without selected-language text, and unavailable affiliation guidance.',
    ),
};
/** Find indexed House speeches without treating a bounded negative scan as absence. */
export const searchSpeechesTool = tool('canparl_search_speeches', {
  description:
    'Find indexed House Hansard speeches by speaker, bill debated or mentioned, or date. contains scans at most 100 candidate speeches per call; follow nextOffset without changing filters until exhausted before drawing a negative conclusion.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    politician: OptionalStringSchema.describe(
      "Speaker OpenParliament slug or exact politician path/HTTPS URL (member.slug from canparl_get_member, or an includeFormer canparl_search_members row), or a current MP's official personId. A digit-only value equal to a current personId, or its /politicians/<digits>/ path or profile URL, is read as that personId. Any other digit-only value is an OpenParliament ID; a notice names the former MP whose personId it also is.",
    ),
    billDebated: BillScopeSchema.optional().describe(
      'Bill debated; combined with all other scopes using AND.',
    ),
    mentionedBill: BillScopeSchema.optional().describe(
      'Bill mentioned; combined with all other scopes using AND.',
    ),
    dateFrom: optionalFormat(DATE_FORMAT).describe(
      'Inclusive Ottawa civil date lower bound, YYYY-MM-DD; independently optional.',
    ),
    dateTo: optionalFormat(DATE_FORMAT).describe(
      'Inclusive Ottawa civil date upper bound, YYYY-MM-DD; independently optional.',
    ),
    substantiveOnly: z
      .boolean()
      .default(true)
      .describe(
        'Exclude procedural remarks when true; false includes substantive and procedural remarks.',
      ),
    contains: OptionalStringSchema.describe(
      "Local literal substring of the selected language's plain text; matching ignores case, accents, dash and quote styles, and repeated whitespace. A speech without text in that language never matches. Cannot be the only scope.",
    ),
    language: LanguageSchema.default('en').describe(
      'Hansard language of speaker, h1, h2, and content, and of the text contains scans: en (default) or fr. A field without text in that language is null, never filled from the other; older records carry no French. party and riding stay English. Keep identical when continuing.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(COUNT_CEILING)
      .default(5)
      .describe(
        'Maximum returned matches, 1–10 per call; larger values up to 10000 clamp to 10 with a notice. Candidate pages contain 20 rows.',
      ),
    offset: OffsetSchema.describe(
      'Raw candidate offset; keep every filter identical when continuing.',
    ),
  }),
  output: z.object({
    speeches: z
      .array(SpeechSchema)
      .describe(
        'Matching House speeches in source order with complete prose in the selected language.',
      ),
    scanned: z
      .number()
      .int()
      .nonnegative()
      .describe('Raw candidates visited, including excluded committee records; at most 100.'),
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
        'Original retrieval metadata for scope validation, candidate pages fetched before the page ended, and memberships of returned speeches.',
      ),
  }),
  enrichment,
  enrichmentTrailer: measuredTrailer(enrichment),
  errors: [
    {
      reason: 'speech_scope_required',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'No speaker, bill, or date bound is supplied.',
      recovery:
        "Retry canparl_search_speeches with a politician (member.slug from canparl_get_member, a slug from an includeFormer canparl_search_members row, or a current MP's personId), a bill from canparl_search_bills, or a date bound.",
      retryable: false,
    },
    {
      reason: 'invalid_speech_filter',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'A malformed slug, a bill session with a zero or out-of-range number, a date naming no calendar day, reversed date bounds, or dateTo 9999-12-31.',
      recovery:
        "Retry canparl_search_speeches in the shape the error names: a politician slug (member.slug from canparl_get_member or an includeFormer canparl_search_members row) or a current MP's personId, a bill session and code from canparl_search_bills, and YYYY-MM-DD dates with dateFrom no later than dateTo.",
      retryable: false,
    },
    {
      reason: 'speech_entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      severity: 'notice',
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
          return {
            session: normalizeFilter(`${field}.session`, bill.session, (value) =>
              normalizeSession(value),
            ),
            code: normalizeBillCode(bill.code),
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
      let identityNotice: string | null = null;
      if (politician) {
        const { profile, formerMember } = await resolvePolitician(politician, request, provenance);
        if (!profile)
          throw ctx.fail(
            'speech_entity_not_found',
            undefined,
            formerMember ? formerMemberRecovery('politician') : undefined,
          );
        if (formerMember)
          identityNotice = formerMemberNotice(politician, profile, formerMember, 'politician');
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
      const { language } = input;
      /** The candidate in the selected language; a field without text there stays null. */
      const select = (speech: Speech) => ({
        ...speech,
        speaker: speech.speaker[language],
        h1: speech.h1[language],
        h2: speech.h2[language],
        content: speech.content[language],
      });
      type Selected = ReturnType<typeof select>;
      /** Party and riding from the membership in force on the speech date, never a current one. */
      const attribute = (speech: Selected, membership: Membership | null) => {
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
        language,
        offset: input.offset,
      };
      const accepted: Selected[] = [];
      let scanned = 0;
      let excluded = 0;
      let textless = 0;
      let exhausted = false;
      let nextOffset: number | null = input.offset;
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
          // Selection precedes the text test, so contains reads the returned language.
          const selected = select(speech);
          if (input.contains && !includesText(selected.content, input.contains)) {
            if (selected.content === null) textless++;
            scanned++;
            continue;
          }
          accepted.push(selected);
          scanned++;
          if (accepted.length === limit.value) {
            // A full page ends the scan; continuation resumes at the first unvisited candidate.
            const last = index === page.objects.length - 1;
            exhausted = last && page.nextOffset === null;
            nextOffset = last ? page.nextOffset : pageOffset + index + 1;
            break scan;
          }
        }
        exhausted = page.nextOffset === null;
        nextOffset = page.nextOffset;
      }
      // Memberships hydrate after the scan, and only for returned speeches, so a slow optional
      // lookup never spends the upstream time budget required candidate pages need.
      const speeches: ReturnType<typeof attribute>[] = [];
      for (const speech of accepted) {
        request.throwIfOuterAborted();
        const hydration = speech.membershipUrl ? await hydrate(speech.membershipUrl) : null;
        speeches.push(attribute(speech, hydration?.membership ?? null));
      }
      const notices = [
        ...(identityNotice ? [identityNotice] : []),
        ...(limit.notice ? [limit.notice] : []),
        input.substantiveOnly
          ? 'substantiveOnly=true excludes procedural remarks; set substantiveOnly=false to include them.'
          : 'substantiveOnly=false includes procedural and substantive remarks.',
      ];
      if (excluded)
        notices.push(
          'Non-House or committee candidates were excluded and are included in scanned and excludedCommittees.',
        );
      if (textless)
        notices.push(
          `${textless} scanned ${textless === 1 ? 'candidate' : 'candidates'} had no ${LANGUAGE_NAMES[language]} text and could not match contains.`,
        );
      if (speeches.some((speech) => speech.party === null || speech.riding === null))
        notices.push(
          'Historical party or riding is unavailable for some returned speeches; nulls never substitute current affiliation.',
        );
      const hydrated = new Set(speeches.flatMap(({ membershipUrl }) => membershipUrl ?? []));
      const unavailable = new Set(
        [...hydrated].flatMap((url) => memberships.get(url)?.unavailable ?? []),
      );
      if (unavailable.size)
        notices.push(
          `Optional historical membership enrichment was unavailable (${[...unavailable].join(', ')}).`,
        );
      if (!speeches.length)
        notices.push(
          !exhausted
            ? 'No text matches among the scanned candidates; call canparl_search_speeches with nextOffset and identical filters to continue.'
            : input.offset > 0 && scanned === 0
              ? 'This offset is past the last indexed candidate; retry canparl_search_speeches with offset 0 and identical filters.'
              : 'No indexed speeches matched; broaden dates or remove contains and retry canparl_search_speeches. This does not establish that no parliamentary speech occurred.',
        );
      ctx.enrich({
        appliedFilters,
        shown: speeches.length,
        cap: limit.value,
        truncated: !exhausted,
        excludedCommittees: excluded,
        notice: notices.join(' '),
      });
      request.throwIfOuterAborted();
      return {
        speeches,
        scanned,
        exhausted,
        nextOffset,
        provenance: [
          ...provenance,
          ...[...hydrated].flatMap((url) => memberships.get(url)?.sources ?? []),
        ],
      };
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
