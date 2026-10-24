/** @fileoverview Joined official division metadata and complete ballot aggregation. @module mcp-server/tools/definitions/get-vote.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  clampCount,
  filterFailure,
  normalizeFilter,
  normalizeProvince,
  normalizeSession,
  normalizeVocabulary,
  paginate,
  rejectFilter,
} from '@/domain/normalization.js';
import {
  BALLOTS,
  extendVocabulary,
  OFFICIAL_BALLOT_ALIASES,
  OFFICIAL_PARTY_ALIASES,
  PARTIES,
} from '@/domain/reference-catalog.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  COUNT_CEILING,
  OffsetSchema,
  OptionalStringSchema,
  PaginationSchema,
  SessionInputSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import { getLegisinfoService } from '@/services/legisinfo/index.js';
import { getOurCommonsService } from '@/services/ourcommons/index.js';
import { formatResult, measuredTrailer, RESPONSE_BUDGET, responseBytes } from './_format.js';
import { PERSON_ID } from './_member-identity.js';
import { DivisionSchema } from './search-votes.tool.js';

const PartyTallySchema = z
  .object({
    party: z.string().nullable().describe('Source caucus, or null for unknown.'),
    yea: z.number().int().nonnegative().describe('Recorded Yea ballots.'),
    nay: z.number().int().nonnegative().describe('Recorded Nay ballots.'),
    paired: z.number().int().nonnegative().describe('Recorded Paired ballots; never doubled.'),
    total: z.number().int().nonnegative().describe('Total recorded ballots for this caucus.'),
  })
  .strict()
  .describe('Unfiltered recorded ballots for one source caucus.');
/** Per-call ballot page cap. */
const BALLOT_CAP = 400;
const enrichment = {
  appliedFilters: z
    .object({
      session: z.string().describe('Resolved session.'),
      number: z.number().int().positive().describe('Verified division number.'),
      party: z.string().nullable().describe('Canonical caucus filter, or null.'),
      province: z.string().nullable().describe('Canonical province filter, or null.'),
      ballot: z.string().nullable().describe('Canonical recorded-ballot filter, or null.'),
      personId: z.string().nullable().describe('Official person ID filter, or null.'),
    })
    .strict()
    .describe('Normalized ballot filters and division identity.'),
  tallyMatchesBallots: z
    .boolean()
    .nullable()
    .describe('Whether all three official counts match participants; null if any count is absent.'),
  totalCount: z.number().int().nonnegative().describe('Matching ballot count before pagination.'),
  shown: z.number().int().nonnegative().describe('Returned ballot count.'),
  cap: z.number().int().positive().describe('Effective ballot page limit after the per-call cap.'),
  truncated: z
    .boolean()
    .describe('Whether more matching ballots remain, including after a response-budget stop.'),
  notice: z
    .string()
    .optional()
    .describe('Limit clamp, nonvoter, mismatch, empty, past-end, or response-budget guidance.'),
};
/** Read one division with unfiltered tallies and a filtered ballot page. */
export const getVoteTool = tool('canparl_get_vote', {
  description:
    'Read a recorded House division, its full official tally, party totals, and a page of individual ballots. Ballot, personId, party, and province filters affect the ballot page only; nonvoters are absent. Omitted session means the verified current official session. Follow nextOffset with identical filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    session: SessionInputSchema,
    number: z
      .number()
      .int()
      .positive()
      .describe('Division number returned by canparl_search_votes or canparl_get_bill.'),
    party: OptionalStringSchema.describe(
      'Canonical official caucus or certain Bloc/Green alias; historical observed caucuses are accepted.',
    ),
    province: OptionalStringSchema.describe(
      'English province/territory name or one of the 13 postal codes.',
    ),
    ballot: OptionalStringSchema.describe(
      'Recorded ballot Yea, Nay, or Paired, case-insensitive; Yes and No are accepted as Yea and Nay.',
    ),
    personId: OptionalStringSchema.describe(
      "Decimal official person ID from canparl_search_members detailLookup or a ballot row; matches this division's recorded participants, including members no longer seated.",
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(COUNT_CEILING)
      .default(30)
      .describe(
        'Maximum returned ballots, 1–400 per call, default 30; larger values up to 10000 clamp to 400 with a notice. A page ends early at the 24000-byte response budget; follow nextOffset.',
      ),
    offset: OffsetSchema,
  }),
  output: z.object({
    division: DivisionSchema.describe('Verified full-session division metadata.'),
    tally: z
      .object({
        yea: z.number().int().nonnegative().nullable().describe('Official yea count, or null.'),
        nay: z.number().int().nonnegative().nullable().describe('Official nay count, or null.'),
        paired: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .describe('Official paired count, or null.'),
      })
      .strict()
      .describe('Official counts independent of local filters.'),
    byParty: z
      .array(PartyTallySchema)
      .describe('Complete unfiltered participant aggregation by source caucus.'),
    ballotsTotal: z.number().int().nonnegative().describe('Complete recorded participant count.'),
    ballotsMatched: z
      .number()
      .int()
      .nonnegative()
      .describe('Exact matching count before pagination.'),
    ballots: z
      .array(
        z
          .object({
            personId: z.string().describe('Official person identifier.'),
            name: z.string().describe('Official participant name.'),
            party: z.string().nullable().describe('Source caucus, or null.'),
            riding: z.string().nullable().describe('Source constituency, or null.'),
            province: z.string().nullable().describe('Source province, or null.'),
            ballot: z.enum(BALLOTS).describe('Recorded ballot; no inferred nonvoter rows.'),
            url: z.string().describe('Official HTTPS member profile link.'),
          })
          .strict()
          .describe('One recorded official participant ballot.'),
      )
      .describe('Matching ballots ordered by caucus, surname, given name, then personId.'),
    pagination: PaginationSchema.describe(
      'Continuation within matching ballots; nextOffset is offset plus ballots returned.',
    ),
    provenance: z.array(SourceSchema).describe('Retrieval metadata for every source request.'),
  }),
  enrichment,
  enrichmentTrailer: measuredTrailer(enrichment),
  errors: [
    {
      reason: 'unsupported_vote_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Malformed or unsupported official division session.',
      recovery:
        'Call canparl_list_reference with topic sessions and choose a session supporting House divisions.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'vote_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Division absent from session feed or explicit detail 404.',
      recovery: 'Call canparl_search_votes in the same session and use a returned number.',
      retryable: false,
    },
    {
      reason: 'invalid_ballot_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unrecognized caucus, province, or ballot value, or a personId that is not decimal.',
      recovery:
        'Retry canparl_get_vote with a caucus from canparl_list_reference topic parties, a province code or full name, ballot Yea, Nay, or Paired, and a decimal personId from canparl_search_members.',
      retryable: false,
    },
    {
      reason: 'vote_detail_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A listed division has empty participant detail.',
      recovery:
        'Retry canparl_get_vote later, or inspect its official summary with canparl_search_votes.',
      retryable: true,
      thrownBy: 'service',
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
      const limit = clampCount('limit', input.limit, BALLOT_CAP);
      let requested: string | undefined;
      try {
        requested = normalizeFilter('session', input.session, (value) => normalizeSession(value));
      } catch (error) {
        throw ctx.fail('unsupported_vote_session', ...filterFailure(error));
      }
      let ballot: string | null;
      try {
        ballot =
          normalizeFilter('ballot', input.ballot, (value) =>
            normalizeVocabulary(value, BALLOTS, OFFICIAL_BALLOT_ALIASES),
          ) ?? null;
        if (input.personId !== undefined && !PERSON_ID.test(input.personId))
          throw rejectFilter(
            'personId',
            'Expected a decimal official person ID, as in a canparl_search_members detailLookup or a canparl_get_vote ballot row.',
          );
      } catch (error) {
        throw ctx.fail('invalid_ballot_filter', ...filterFailure(error));
      }
      const personId = input.personId ?? null;
      const resolved = await getLegisinfoService().resolveSession(requested, request);
      const session = resolved.data;
      const provenance = [...resolved.provenance];
      const official = getOurCommonsService();
      const summary = await official.listVotes(session, request);
      provenance.push(...summary.provenance);
      const division = summary.data.find((row) => row.number === input.number);
      if (!division) throw ctx.fail('vote_not_found');
      const detail = await official.getVoteParticipants(session, input.number, request);
      provenance.push(...detail.provenance);
      let party: string | null;
      let province: string | null;
      try {
        const parties = extendVocabulary(
          PARTIES,
          detail.data.map((row) => row.party),
        );
        party =
          normalizeFilter('party', input.party, (value) =>
            normalizeVocabulary(value, parties, OFFICIAL_PARTY_ALIASES),
          ) ?? null;
        province = normalizeFilter('province', input.province, normalizeProvince) ?? null;
      } catch (error) {
        throw ctx.fail('invalid_ballot_filter', ...filterFailure(error));
      }
      const groups = new Map<string | null, z.infer<typeof PartyTallySchema>>();
      const counted = { yea: 0, nay: 0, paired: 0 };
      for (const row of detail.data) {
        const group = groups.get(row.party) ?? {
          party: row.party,
          yea: 0,
          nay: 0,
          paired: 0,
          total: 0,
        };
        const key = row.ballot === 'Yea' ? 'yea' : row.ballot === 'Nay' ? 'nay' : 'paired';
        group[key]++;
        group.total++;
        counted[key]++;
        groups.set(row.party, group);
      }
      const byParty = [...groups.values()].sort((a, b) =>
        (a.party ?? '').localeCompare(b.party ?? ''),
      );
      const filtered = detail.data
        .filter(
          (row) =>
            (!ballot || row.ballot === ballot) &&
            (!personId || row.personId === personId) &&
            (!party || row.party === party) &&
            (!province || row.province === province),
        )
        .sort(
          (a, b) =>
            (a.party ?? '').localeCompare(b.party ?? '') ||
            a.lastName.localeCompare(b.lastName) ||
            a.firstName.localeCompare(b.firstName) ||
            a.personId.localeCompare(b.personId),
        );
      const tally = { yea: division.yeas, nay: division.nays, paired: division.paired };
      const tallyMatchesBallots =
        tally.yea === null || tally.nay === null || tally.paired === null
          ? null
          : tally.yea === counted.yea &&
            tally.nay === counted.nay &&
            tally.paired === counted.paired;
      const notices = [
        ...(limit.notice ? [limit.notice] : []),
        'Nonvoters are not listed; paired ballots are recorded participants, not inferred pairs.',
      ];
      if (tallyMatchesBallots === false)
        notices.push(
          'Official tally and recorded participant counts differ; both are retained unchanged.',
        );
      if (!filtered.length)
        notices.push(
          'No recorded ballots matched ballot/personId/party/province; remove those filters and retry canparl_get_vote.',
        );
      else if (input.offset > 0 && input.offset >= filtered.length)
        notices.push('Retry canparl_get_vote with offset 0 and the same filters.');
      const available = Math.max(0, Math.min(limit.value, filtered.length - input.offset));
      /** The page of `count` ballots; fewer than `available` is a response-budget stop. */
      const respond = (count: number) => {
        const page = paginate(filtered, input.offset, count);
        const result = {
          division,
          tally,
          byParty,
          ballotsTotal: detail.data.length,
          ballotsMatched: page.total,
          ballots: page.items.map(({ firstName: _firstName, lastName: _lastName, ...row }) => row),
          pagination: { ...page.pagination, limit: limit.value },
          provenance,
        };
        const enriched = {
          appliedFilters: { session, number: input.number, party, province, ballot, personId },
          tallyMatchesBallots,
          totalCount: page.total,
          shown: page.items.length,
          cap: limit.value,
          truncated: page.pagination.hasMore,
          notice: [
            ...notices,
            ...(count < available
              ? [
                  `The ${RESPONSE_BUDGET}-byte response budget ended this page after ${count} ${count === 1 ? 'ballot' : 'ballots'}; call canparl_get_vote with nextOffset and identical filters to continue.`,
                ]
              : []),
          ].join(' '),
        };
        return { result, enriched };
      };
      const fits = (count: number) => {
        const { result, enriched } = respond(count);
        return responseBytes(result, enriched) <= RESPONSE_BUDGET;
      };
      // Page size grows with every ballot, so the largest stopped page that fits is a bisection.
      let count = available;
      if (count > 1 && !fits(count)) {
        let low = 1;
        let high = count - 1;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(middle)) low = middle;
          else high = middle - 1;
        }
        count = low;
      }
      const { result, enriched } = respond(count);
      ctx.enrich(enriched);
      request.throwIfOuterAborted();
      return result;
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
