/** @fileoverview Joined official division metadata and complete ballot aggregation. @module mcp-server/tools/definitions/get-vote.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  normalizeProvince,
  normalizeSession,
  normalizeVocabulary,
  paginate,
  vocabularyKey,
} from '@/domain/normalization.js';
import { extendVocabulary, OFFICIAL_PARTY_ALIASES, PARTIES } from '@/domain/reference-catalog.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  OffsetSchema,
  OptionalStringSchema,
  PaginationSchema,
  SessionInputSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import { getLegisinfoService } from '@/services/legisinfo/index.js';
import { getOurCommonsService } from '@/services/ourcommons/index.js';
import { formatResult, renderValue } from './_format.js';
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
/** Read one division with unfiltered tallies and a filtered ballot page. */
export const getVoteTool = tool('canparl_get_vote', {
  description:
    'Read a recorded House division, its full official tally, party totals, and a page of individual ballots. Party/province filters affect the ballot page only; nonvoters are absent. Omitted session means the verified current official session. Follow nextOffset with identical filters.',
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(400)
      .default(100)
      .describe('Maximum returned ballots, 1–400; default 100.'),
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
            ballot: z
              .enum(['Yea', 'Nay', 'Paired'])
              .describe('Recorded ballot; no inferred nonvoter rows.'),
            url: z.string().describe('Official HTTPS member profile link.'),
          })
          .strict()
          .describe('One recorded official participant ballot.'),
      )
      .describe('Matching ballots ordered by caucus, surname, given name, then personId.'),
    pagination: PaginationSchema.describe('Continuation within matching ballots.'),
    provenance: z.array(SourceSchema).describe('Retrieval metadata for every source request.'),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        session: z.string().describe('Resolved session.'),
        number: z.number().int().positive().describe('Verified division number.'),
        party: z.string().nullable().describe('Canonical caucus filter, or null.'),
        province: z.string().nullable().describe('Canonical province filter, or null.'),
      })
      .strict()
      .describe('Normalized ballot filters and division identity.'),
    tallyMatchesBallots: z
      .boolean()
      .nullable()
      .describe(
        'Whether all three official counts match participants; null if any count is absent.',
      ),
    totalCount: z.number().int().nonnegative().describe('Matching ballot count before pagination.'),
    shown: z.number().int().nonnegative().describe('Returned ballot count.'),
    cap: z.number().int().positive().describe('Requested ballot page limit.'),
    truncated: z.boolean().describe('Whether more matching ballots remain.'),
    notice: z.string().optional().describe('Nonvoter, mismatch, empty, or past-end guidance.'),
  },
  enrichmentTrailer: {
    appliedFilters: { render: (value) => renderValue(value, 'appliedFilters') },
  },
  errors: [
    {
      reason: 'unsupported_vote_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unsupported official division session.',
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
      when: 'Unrecognized caucus or province.',
      recovery:
        'Call canparl_list_reference with topic parties, then retry canparl_get_vote with a canonical caucus and province code or full name.',
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
      const official = getOurCommonsService();
      const summary = await official.listVotes(session, request);
      provenance.push(...summary.provenance);
      const division = summary.data.find((row) => row.number === input.number);
      if (!division) throw ctx.fail('vote_not_found');
      const detail = await official.getVoteParticipants(session, input.number, request);
      provenance.push(...detail.provenance);
      let party: string | null = null;
      let province: string | null = null;
      try {
        if (input.party) {
          const alias = Object.entries(OFFICIAL_PARTY_ALIASES).find(
            ([key]) => vocabularyKey(key) === vocabularyKey(input.party ?? ''),
          )?.[1];
          party = normalizeVocabulary(
            alias ?? input.party,
            extendVocabulary(
              PARTIES,
              detail.data.map((row) => row.party),
            ),
          );
        }
        if (input.province) province = normalizeProvince(input.province);
      } catch (error) {
        if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.ValidationError)
          throw error;
        throw ctx.fail('invalid_ballot_filter', undefined, undefined, { cause: error });
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
          (row) => (!party || row.party === party) && (!province || row.province === province),
        )
        .sort(
          (a, b) =>
            (a.party ?? '').localeCompare(b.party ?? '') ||
            a.lastName.localeCompare(b.lastName) ||
            a.firstName.localeCompare(b.firstName) ||
            a.personId.localeCompare(b.personId),
        );
      const page = paginate(filtered, input.offset, input.limit);
      const tally = { yea: division.yeas, nay: division.nays, paired: division.paired };
      const tallyMatchesBallots =
        tally.yea === null || tally.nay === null || tally.paired === null
          ? null
          : tally.yea === counted.yea &&
            tally.nay === counted.nay &&
            tally.paired === counted.paired;
      ctx.enrich({
        appliedFilters: { session, number: input.number, party, province },
        tallyMatchesBallots,
        shown: page.items.length,
        cap: input.limit,
        truncated: page.pagination.hasMore,
      });
      ctx.enrich.total(page.total);
      const notices = [
        'Nonvoters are not listed; paired ballots are recorded participants, not inferred pairs.',
      ];
      if (tallyMatchesBallots === false)
        notices.push(
          'Official tally and recorded participant counts differ; both are retained unchanged.',
        );
      if (!page.total)
        notices.push(
          'No recorded ballots matched party/province; remove those filters and retry canparl_get_vote. Nonvoters are not listed.',
        );
      if (input.offset > 0 && input.offset >= page.total)
        notices.push('Retry canparl_get_vote with offset 0 and the same filters.');
      ctx.enrich.notice(notices.join(' '));
      request.throwIfOuterAborted();
      return {
        division,
        tally,
        byParty,
        ballotsTotal: detail.data.length,
        ballotsMatched: page.total,
        ballots: page.items.map(
          ({ firstName: _firstName, lastName: _lastName, ...ballot }) => ballot,
        ),
        pagination: page.pagination,
        provenance,
      };
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
