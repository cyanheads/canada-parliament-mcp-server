/**
 * @fileoverview Verified member identity and independently bounded source activity.
 * @module mcp-server/tools/definitions/get-member.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  BILL_CODE_FORMAT,
  clampCount,
  filterFailure,
  normalizeBillCode,
  normalizeFilter,
  normalizeSession,
  normalizeSlug,
  PERSON_ID,
  PERSON_ID_FORMAT,
  paginate,
  rejectFilter,
} from '@/domain/normalization.js';
import { BALLOTS, OFFICIAL_BALLOT_ALIASES } from '@/domain/reference-catalog.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  BilingualTextSchema,
  COUNT_CEILING,
  OffsetSchema,
  OptionalStringSchema,
  optionalFormat,
  SessionInputSchema,
  type Source,
  SourceSchema,
} from '@/domain/schemas.js';
import {
  getOpenParliamentService,
  type PoliticianProfile,
  type Vote,
} from '@/services/openparliament/index.js';
import {
  getOurCommonsService,
  type MemberVote,
  type OurCommonsMember,
  type RecordedBallot,
  type RosterMember,
} from '@/services/ourcommons/index.js';
import { formatResult, renderValue } from './_format.js';
import {
  crosswalkProfile,
  findFormerMember,
  formerMemberNotice,
  formerMemberRecovery,
} from './_member-identity.js';
import { MemberSummarySchema } from './search-members.tool.js';

const nullableText = () => z.string().nullable();
/**
 * Per-call activity caps. An OpenParliament row costs up to one paced hydration request, so bills
 * and OpenParliament ballots stay small; official ballots page a feed already read whole.
 */
const SPONSORED_BILLS_CAP = 5;
const OPENPARLIAMENT_VOTES_CAP = 10;
const OFFICIAL_VOTES_CAP = 100;
const BallotSchema = z
  .enum(['Yes', 'No', 'Paired', "Didn't vote"])
  .describe(
    "Ballot in OpenParliament's vocabulary: official Yea and Nay read Yes and No; Didn't vote occurs only on OpenParliament rows.",
  );
/** Official Yea/Nay in OpenParliament's Yes/No, the inverse of the certain filter aliases; Paired is shared. */
function openParliamentBallot(official: RecordedBallot) {
  return BallotSchema.parse(
    Object.keys(OFFICIAL_BALLOT_ALIASES).find(
      (alias) => OFFICIAL_BALLOT_ALIASES[alias] === official,
    ) ?? official,
  );
}
const recovery =
  'Retry canparl_get_member with the returned identifier, or use canparl_search_bills/canparl_search_votes for official records.';
const FailureSchema = z
  .object({
    code: z.string().describe('Framework error code name.'),
    reason: z.string().describe('Safe fixed failure classification.'),
    recovery: z.string().describe('Caller recovery guidance.'),
    retryable: z.boolean().describe('Whether retry may succeed.'),
  })
  .strict()
  .describe('Public optional-section failure metadata.');
type Failure = z.infer<typeof FailureSchema>;
function voteIdentity(url: string): { session: string; number: number } {
  const match = /^\/votes\/([1-9]\d*-[1-9]\d*)\/([1-9]\d*)\/$/.exec(new URL(url).pathname);
  if (!match?.[1] || !match[2])
    throw serviceUnavailable('Source ballot vote identity is invalid.', { retryable: false });
  return { session: match[1], number: Number(match[2]) };
}
function failure(error: unknown): Failure {
  const code = error instanceof McpError ? error.code : JsonRpcErrorCode.InternalError;
  return {
    code: JsonRpcErrorCode[code] ?? 'InternalError',
    reason: code === JsonRpcErrorCode.Timeout ? 'enrichment_timeout' : 'enrichment_unavailable',
    recovery,
    retryable:
      error instanceof McpError && typeof error.data?.retryable === 'boolean'
        ? error.data.retryable
        : [
            JsonRpcErrorCode.Timeout,
            JsonRpcErrorCode.ServiceUnavailable,
            JsonRpcErrorCode.RateLimited,
          ].includes(code),
  };
}
function unavailableFailure(reason: string): Failure {
  return { code: 'ServiceUnavailable', reason, recovery, retryable: false };
}
const SponsoredBillSchema = z
  .object({
    session: z.string().describe('Source bill session.'),
    billCode: z.string().describe('Source bill code.'),
    title: BilingualTextSchema.describe('Source bill title translations.'),
    status: nullableText().describe('OpenParliament status wording, or null.'),
    url: z.string().describe('Absolute HTTPS bill URL.'),
  })
  .strict()
  .describe('Hydrated sponsored bill.');
const MemberVoteSchema = z
  .object({
    session: z.string().describe('Division session.'),
    number: z.number().int().describe('Division number within the session.'),
    date: nullableText().describe('Division date YYYY-MM-DD, or null.'),
    subject: nullableText().describe('Source division subject, or null.'),
    ballot: BallotSchema,
    url: z
      .string()
      .describe(
        'Absolute HTTPS division URL: the official division page or the OpenParliament vote.',
      ),
    source: z
      .enum(['ourcommons', 'openparliament'])
      .describe(
        'Ballot source: the official member-votes feed, or OpenParliament for a member without one official personId.',
      ),
    officialBallot: z
      .enum(BALLOTS)
      .nullable()
      .describe('Official recorded ballot Yea, Nay, or Paired; null on OpenParliament rows.'),
    billCode: nullableText().describe(
      'Bill code the official feed links to the division, or null; always null on OpenParliament rows.',
    ),
    result: nullableText().describe(
      'Division result in source vocabulary (official Agreed To, Negatived, or Tie; OpenParliament Passed, Failed, or Tie), or null.',
    ),
    yeas: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Division yea tally from the row's source, or null when the source omits it."),
    nays: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Division nay tally from the row's source, or null when the source omits it."),
    paired: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Division paired tally from the row's source, or null when the source omits it."),
    documentType: nullableText().describe(
      'Official document category, such as Ways and means, as the member-votes feed names it, or null; always null on OpenParliament rows.',
    ),
  })
  .strict()
  .describe('Member ballot with its division and tallies.');
function activitySchema<T extends z.ZodType, N extends z.ZodType>(item: T, total: N) {
  return z
    .object({
      status: z
        .enum(['available', 'unavailable', 'not_requested'])
        .describe('Availability; unavailable never means empty history.'),
      items: z.array(item).describe('Complete returned page, or no rows when unavailable.'),
      offset: z.number().int().describe('Requested activity offset.'),
      limit: z
        .number()
        .int()
        .describe('Effective workload limit after the per-call cap; zero disables activity.'),
      total,
      nextOffset: z.number().int().nullable().describe('Next activity offset, or null.'),
      hasMore: z.boolean().describe('Whether more activity remains.'),
      failure: FailureSchema.nullable().describe('Failure metadata only when unavailable.'),
    })
    .strict()
    .describe('Independently pageable activity section.');
}
interface Activity<T, Total extends number | null = null> {
  failure: Failure | null;
  hasMore: boolean;
  items: T[];
  limit: number;
  nextOffset: number | null;
  offset: number;
  status: 'available' | 'unavailable' | 'not_requested';
  total: Total;
}
function section<T>(offset: number, limit: number, unavailable: Failure | null): Activity<T> {
  return {
    status: limit === 0 ? 'not_requested' : 'unavailable',
    items: [],
    offset,
    limit,
    total: null,
    nextOffset: null,
    hasMore: false,
    failure: limit === 0 ? null : unavailable,
  };
}
function available<T, Total extends number | null>(
  items: T[],
  offset: number,
  limit: number,
  nextOffset: number | null,
  total: Total,
): Activity<T, Total> {
  return {
    status: 'available',
    items,
    offset,
    limit,
    total,
    nextOffset,
    hasMore: nextOffset !== null,
    failure: null,
  };
}

/** Read a verified public profile without projecting current attributes into history. */
export const getMemberTool = tool('canparl_get_member', {
  description:
    "Read one House MP by a returned OpenParliament slug or official personId, current or former (36th Parliament onward). Pass exactly one identifier from canparl_search_members detailLookup. Official profiles survive unavailable OpenParliament enrichment. Recent ballots come newest first, each with its division's tallies. When the member has one official personId they come from the official House member-votes feed, up to 100 per call with the exact count in total, filterable by votesSession (default: the member's latest session) and votesBillCode; otherwise from OpenParliament, up to 10 per call. Sponsored bills and recent ballots are independently pageable; set their limits to zero for profile-only lookup.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    slug: OptionalStringSchema.describe(
      'Returned OpenParliament slug, politician path, or HTTPS OpenParliament profile URL; never a guessed name. A digit-only value equal to a current official personId, or its /politicians/<digits>/ path or profile URL, is read as that personId. Any other digit-only value is an OpenParliament ID; a notice names the former MP whose personId it also is.',
    ),
    personId: optionalFormat(PERSON_ID_FORMAT).describe(
      "Decimal official person ID, distinct from an OpenParliament slug: a current member's, or a former member's from the 36th Parliament onward, such as a canparl_search_members parliament row or a canparl_get_vote ballot. A former member's profile carries their latest Parliament's caucus and riding.",
    ),
    sponsoredBills: z
      .number()
      .int()
      .min(0)
      .max(COUNT_CEILING)
      .default(SPONSORED_BILLS_CAP)
      .describe(
        'Sponsored bill rows to hydrate, 0–5 per call; zero disables, and larger values up to 10000 hydrate 5 with a notice.',
      ),
    billsOffset: OffsetSchema.describe('Zero-based sponsored bill page offset.'),
    recentVotes: z
      .number()
      .int()
      .min(0)
      .max(COUNT_CEILING)
      .default(OPENPARLIAMENT_VOTES_CAP)
      .describe(
        'Ballot rows to return, default 10: 0–100 per call from the official feed, or 0–10 from OpenParliament for a member without one official personId; zero disables, and larger values up to 10000 return the cap with a notice.',
      ),
    votesOffset: OffsetSchema.describe('Zero-based ballot page offset.'),
    votesSession: SessionInputSchema.describe(
      "Official ballot session such as 44-1; omitted means the member's latest session in the feed. Needs one official personId.",
    ),
    votesBillCode: optionalFormat(BILL_CODE_FORMAT).describe(
      'Keep official ballots on this bill, including a split-bill suffix such as C-15A; accepts c15, C 15, or bill C-15. Needs one official personId.',
    ),
  }),
  output: z.object({
    member: MemberSummarySchema.extend({
      gender: nullableText().describe('Source gender, or null.'),
      imageUrl: nullableText().describe('HTTPS portrait reference, or null.'),
      links: z
        .array(
          z
            .object({
              url: z
                .string()
                .describe(
                  'Absolute http or https URL as published, or a relative value resolved against https://openparliament.ca; never fetched, and only https values render as links.',
                ),
              note: nullableText().describe('Source link annotation, or null.'),
            })
            .strict()
            .describe('Public profile link.'),
        )
        .describe('Source profile links, excluding contact fields.'),
    })
      .strict()
      .describe('Public member profile.'),
    memberships: z
      .array(
        z
          .object({
            url: z.string().describe('HTTPS historical membership URL.'),
            party: z
              .object({
                name: nullableText().describe('Historical party name.'),
                shortName: nullableText().describe('Historical party short name.'),
              })
              .strict()
              .describe('Source-specific historical affiliation.'),
            riding: nullableText().describe('Historical riding.'),
            province: nullableText().describe('Historical province.'),
            startDate: nullableText().describe('Source start date.'),
            endDate: nullableText().describe('Source end date.'),
            label: nullableText().describe('Source membership label.'),
          })
          .strict()
          .describe('Dated source membership.'),
      )
      .nullable()
      .describe('Source membership history, or null if unavailable.'),
    sponsoredBills: activitySchema(
      SponsoredBillSchema,
      z
        .null()
        .describe('Always null: OpenParliament bill pages carry no count; follow nextOffset.'),
    ),
    recentVotes: activitySchema(
      MemberVoteSchema,
      z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .describe(
          "Exact count of the member's official ballots in the session after votesBillCode, before paging; null for OpenParliament ballots, whose pages carry no count (follow nextOffset), and for unavailable or not-requested sections.",
        ),
    ),
    openParliament: z
      .object({
        status: z.enum(['available', 'unavailable']).describe('Profile enrichment availability.'),
        reason: nullableText().describe('Safe unavailability reason, or null.'),
      })
      .strict()
      .describe('OpenParliament identity outcome.'),
    provenance: z.array(SourceSchema).describe('All successful source retrieval metadata.'),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        slug: nullableText().describe('Normalized requested OpenParliament slug, or null.'),
        personId: nullableText().describe(
          'Requested official ID, including a digit-only slug read as a current personId, or null.',
        ),
        sponsoredBills: z
          .number()
          .int()
          .describe('Effective bill workload after the per-call cap.'),
        billsOffset: z.number().int().describe('Requested bill offset.'),
        recentVotes: z.number().int().describe('Effective ballot workload after the per-call cap.'),
        votesOffset: z.number().int().describe('Requested ballot offset.'),
        votesSession: nullableText().describe(
          'Requested official ballot session, else the session the official ballots carry, or null.',
        ),
        votesBillCode: nullableText().describe('Canonical official ballot bill filter, or null.'),
      })
      .strict()
      .describe('Normalized lookup and independent activity controls.'),
    shown: z
      .object({
        sponsoredBills: z.number().int().describe('Hydrated returned bills.'),
        recentVotes: z.number().int().describe('Returned ballots.'),
      })
      .strict()
      .describe('Returned activity counts.'),
    cap: z
      .object({
        sponsoredBills: z.number().int().describe('Effective bill workload cap.'),
        recentVotes: z.number().int().describe('Effective ballot workload cap.'),
      })
      .strict()
      .describe('Bounded workloads after the per-call caps.'),
    truncated: z
      .object({
        sponsoredBills: z.boolean().describe('More sponsored bills remain.'),
        recentVotes: z.boolean().describe('More ballots remain.'),
      })
      .strict()
      .describe('Independent source continuations.'),
    unavailable: z
      .array(
        z
          .object({
            section: z
              .string()
              .describe('Unavailable profile, history, currentness, or activity section.'),
            failure: FailureSchema,
          })
          .strict()
          .describe('Optional enrichment failure.'),
      )
      .describe('Explicit unavailable enrichment outcomes.'),
    notice: z
      .string()
      .optional()
      .describe('Former-MP personId disclosure, workload clamp, coverage, and recovery guidance.'),
  },
  enrichmentTrailer: {
    appliedFilters: { render: (value) => renderValue(value, 'appliedFilters') },
    shown: { render: (value) => renderValue(value, 'shown') },
    cap: { render: (value) => renderValue(value, 'cap') },
    truncated: { render: (value) => renderValue(value, 'truncated') },
    unavailable: { render: (value) => renderValue(value, 'unavailable') },
  },
  errors: [
    {
      reason: 'invalid_member_identifier',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'Neither or both identifiers supplied, or a slug that is not an OpenParliament politician reference.',
      recovery:
        'Call canparl_search_members and pass exactly one identifier from a result detailLookup to canparl_get_member.',
      retryable: false,
    },
    {
      reason: 'member_not_found',
      code: JsonRpcErrorCode.NotFound,
      severity: 'notice',
      when: 'Slug missing or answered by another profile, or official person ID in neither the current roster nor the all-Parliaments roster.',
      recovery:
        'Call canparl_search_members with includeFormer true and a surname or full name, then pass a returned slug to canparl_get_member.',
      retryable: false,
    },
    {
      reason: 'unsupported_vote_session',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'votesSession with a zero or out-of-range number, or absent from the official division picker.',
      recovery:
        'Call canparl_list_reference with topic sessions and pass a session supporting House divisions as votesSession, or omit it.',
      retryable: false,
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
    {
      reason: 'roster_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The official all-Parliaments roster came back empty while resolving a former personId.',
      recovery:
        'Retry canparl_get_member later, or call canparl_search_members with includeFormer true and pass a returned slug.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const request = createRequestContext(ctx);
    try {
      let slug: string | undefined;
      try {
        if (!!input.slug === !!input.personId)
          throw rejectFilter(
            'slug|personId',
            'Expected exactly one of slug or personId, copied from a canparl_search_members detailLookup.',
          );
        slug = normalizeFilter('slug', input.slug, normalizeSlug);
      } catch (error) {
        throw ctx.fail('invalid_member_identifier', ...filterFailure(error));
      }
      let votesSession: string | undefined;
      try {
        votesSession = normalizeFilter('votesSession', input.votesSession, (value) =>
          normalizeSession(value),
        );
      } catch (error) {
        throw ctx.fail('unsupported_vote_session', ...filterFailure(error));
      }
      const votesBillCode =
        input.votesBillCode === undefined ? undefined : normalizeBillCode(input.votesBillCode);
      const billLimit = clampCount('sponsoredBills', input.sponsoredBills, SPONSORED_BILLS_CAP);
      const service = getOpenParliamentService();
      const provenance: Source[] = [];
      const unavailable: { section: string; failure: Failure }[] = [];
      let roster: OurCommonsMember[] | undefined;
      const currentRoster = async () => {
        if (!roster) {
          const result = await getOurCommonsService().listMembers(request);
          provenance.push(...result.provenance);
          roster = result.data;
        }
        return roster;
      };
      let requestedPersonId = input.personId;
      if (
        slug &&
        PERSON_ID.test(slug) &&
        (await currentRoster()).some((row) => row.personId === slug)
      ) {
        requestedPersonId = slug;
        slug = undefined;
      }
      let official: RosterMember | undefined;
      let profile: PoliticianProfile | undefined;
      let verifiedCurrent: boolean | null = null;
      let crosswalkFailure: Failure | null = null;
      let identityNotice: string | undefined;
      if (requestedPersonId) {
        official = (await currentRoster()).find((row) => row.personId === requestedPersonId);
        verifiedCurrent = !!official;
        if (!official) {
          // A former member's row from their latest Parliament; slug inputs never reach this read.
          const everyone = await getOurCommonsService().listAllMembers(request);
          provenance.push(...everyone.provenance);
          official = everyone.data.find((row) => row.personId === requestedPersonId);
          if (!official) throw ctx.fail('member_not_found');
        }
        try {
          profile = (await crosswalkProfile(official, request, provenance)) ?? undefined;
          if (!profile) crosswalkFailure = unavailableFailure('enrichment_unavailable');
        } catch (error) {
          request.throwIfOuterAborted();
          crosswalkFailure = failure(error);
        }
        if (crosswalkFailure)
          unavailable.push({ section: 'openParliament', failure: crosswalkFailure });
      } else if (slug) {
        try {
          const result = await service.getPolitician(slug, request);
          profile = result.data;
          provenance.push(...result.provenance);
        } catch (error) {
          request.throwIfAborted();
          if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.NotFound) throw error;
          const former = await findFormerMember(slug, null, request, provenance);
          throw ctx.fail(
            'member_not_found',
            undefined,
            former ? formerMemberRecovery('slug') : undefined,
            { cause: error },
          );
        }
        // The former MP's row only names them; it never supplies this profile's personId or ballots.
        const former = await findFormerMember(slug, profile, request, provenance);
        if (former) identityNotice = formerMemberNotice(slug, profile, former, 'slug');
        if (profile.personIds?.length) {
          try {
            const matches = (await currentRoster()).filter((row) =>
              profile?.personIds?.includes(row.personId),
            );
            if (matches.length > 1)
              throw serviceUnavailable('Member current roster identity is ambiguous.', {
                retryable: false,
              });
            official = matches[0];
            verifiedCurrent = !!official;
          } catch (error) {
            request.throwIfOuterAborted();
            unavailable.push({ section: 'currentness', failure: failure(error) });
          }
        } else {
          unavailable.push({
            section: 'currentness',
            failure: unavailableFailure('official_identity_unavailable'),
          });
        }
      }
      const fallbackFailure = crosswalkFailure ?? unavailableFailure('identity_unavailable');
      const personId =
        official?.personId ??
        (profile?.personIds?.length === 1 ? (profile.personIds[0] ?? null) : null);
      // The ballot source, and with it the cap, is known once identity resolves.
      const voteLimit = clampCount(
        'recentVotes',
        input.recentVotes,
        personId ? OFFICIAL_VOTES_CAP : OPENPARLIAMENT_VOTES_CAP,
      );
      let sponsoredBills = section<z.infer<typeof SponsoredBillSchema>>(
        input.billsOffset,
        billLimit.value,
        fallbackFailure,
      );
      let recentVotes: Activity<z.infer<typeof MemberVoteSchema>, number | null> = section(
        input.votesOffset,
        voteLimit.value,
        fallbackFailure,
      );
      let officialBallots: MemberVote[] = [];
      if (personId && voteLimit.value) {
        try {
          const result = await getOurCommonsService().listMemberVotes(
            personId,
            votesSession,
            request,
          );
          provenance.push(...result.provenance);
          officialBallots = result.data;
          const page = paginate(
            officialBallots
              .filter((row) => !votesBillCode || row.billCode === votesBillCode)
              .sort(
                (a, b) => (b.dateTime ?? '').localeCompare(a.dateTime ?? '') || b.number - a.number,
              ),
            input.votesOffset,
            voteLimit.value,
          );
          recentVotes = available(
            page.items.map((row) => ({
              session: row.session,
              number: row.number,
              date: row.dateTime?.slice(0, 10) ?? null,
              subject: row.subject,
              ballot: openParliamentBallot(row.ballot),
              url: row.url,
              source: 'ourcommons' as const,
              officialBallot: row.ballot,
              billCode: row.billCode,
              result: row.result,
              yeas: row.yeas,
              nays: row.nays,
              paired: row.paired,
              documentType: row.documentType,
            })),
            input.votesOffset,
            voteLimit.value,
            page.pagination.nextOffset,
            page.total,
          );
        } catch (error) {
          request.throwIfOuterAborted();
          if (error instanceof McpError && error.data?.reason === 'unsupported_vote_session')
            throw error;
          recentVotes = section(input.votesOffset, voteLimit.value, failure(error));
        }
      }
      const officialFiltersUnusable =
        !personId &&
        voteLimit.value > 0 &&
        (votesSession !== undefined || votesBillCode !== undefined);
      if (officialFiltersUnusable)
        recentVotes = section(
          input.votesOffset,
          voteLimit.value,
          unavailableFailure('official_identity_unavailable'),
        );
      if (profile && billLimit.value) {
        try {
          request.throwIfAborted();
          const page = await service.listBills(
            { sponsor: profile.slug, limit: billLimit.value, offset: input.billsOffset },
            request,
          );
          provenance.push(...page.provenance);
          const items = [];
          for (const row of page.objects) {
            const detail = await service.getBill(row.session, row.billCode, request);
            provenance.push(...detail.provenance);
            const { session, billCode, title, status, url } = detail.data;
            items.push({ session, billCode, title, status, url });
          }
          sponsoredBills = available(
            items,
            input.billsOffset,
            billLimit.value,
            page.nextOffset,
            null,
          );
        } catch (error) {
          request.throwIfOuterAborted();
          sponsoredBills = section(input.billsOffset, billLimit.value, failure(error));
        }
      }
      if (profile && !personId && !officialFiltersUnusable && voteLimit.value) {
        try {
          request.throwIfAborted();
          const page = await service.listBallots(
            { politician: profile.slug, limit: voteLimit.value, offset: input.votesOffset },
            request,
          );
          provenance.push(...page.provenance);
          const details = new Map<string, Vote>();
          const items = [];
          for (const row of page.objects) {
            let detail = details.get(row.voteUrl);
            if (!detail) {
              const identity = voteIdentity(row.voteUrl);
              const result = await service.getVote(identity.session, identity.number, request);
              provenance.push(...result.provenance);
              detail = result.data;
              details.set(row.voteUrl, detail);
            }
            items.push({
              session: detail.session,
              number: detail.number,
              date: detail.date,
              subject: detail.subject,
              ballot: row.ballot,
              url: detail.url,
              source: 'openparliament' as const,
              officialBallot: null,
              billCode: null,
              result: detail.result,
              yeas: detail.yeas,
              nays: detail.nays,
              paired: detail.paired,
              documentType: null,
            });
          }
          recentVotes = available(items, input.votesOffset, voteLimit.value, page.nextOffset, null);
        } catch (error) {
          request.throwIfOuterAborted();
          recentVotes = section(input.votesOffset, voteLimit.value, failure(error));
        }
      }
      for (const [name, value] of [
        ['sponsoredBills', sponsoredBills],
        ['recentVotes', recentVotes],
      ] as const)
        if (value.failure) unavailable.push({ section: name, failure: value.failure });
      if (profile && profile.memberships === null)
        unavailable.push({
          section: 'memberships',
          failure: unavailableFailure('membership_history_unavailable'),
        });
      const identity = official ?? profile;
      if (!identity) throw ctx.fail('member_not_found');
      const detailLookup =
        'personId' in identity ? { personId: identity.personId } : { slug: identity.slug };
      const member = {
        personId,
        slug: profile?.slug ?? null,
        name: identity.name,
        party: official ? official.party : (profile?.party ?? null),
        riding: official ? official.riding : (profile?.riding ?? null),
        province: official ? official.province : (profile?.province ?? null),
        current: verifiedCurrent,
        from: official?.from ?? null,
        to: official?.to ?? null,
        url: identity.url,
        detailLookup,
        gender: profile?.gender ?? null,
        imageUrl: profile?.imageUrl ?? null,
        links: profile?.links ?? [],
      };
      const memberships =
        profile?.memberships?.map(({ politicianUrl: _politician, ...membership }) => membership) ??
        null;
      ctx.enrich({
        appliedFilters: {
          slug: slug ?? null,
          personId: requestedPersonId ?? null,
          sponsoredBills: billLimit.value,
          billsOffset: input.billsOffset,
          recentVotes: voteLimit.value,
          votesOffset: input.votesOffset,
          votesSession: votesSession ?? officialBallots[0]?.session ?? null,
          votesBillCode: votesBillCode ?? null,
        },
        shown: {
          sponsoredBills: sponsoredBills.items.length,
          recentVotes: recentVotes.items.length,
        },
        cap: { sponsoredBills: billLimit.value, recentVotes: voteLimit.value },
        truncated: { sponsoredBills: sponsoredBills.hasMore, recentVotes: recentVotes.hasMore },
        unavailable,
      });
      const notices = [identityNotice, billLimit.notice, voteLimit.notice].filter(
        (notice) => notice !== undefined,
      );
      if (!profile)
        notices.push(
          'No verified OpenParliament match is available; retain the official profile and use canparl_search_members with includeFormer true to inspect named candidates.',
        );
      if (unavailable.length)
        notices.push(
          'Some optional enrichment is unavailable; inspect unavailable and section failure metadata before drawing historical conclusions.',
        );
      if (officialFiltersUnusable)
        notices.push(
          'votesSession and votesBillCode filter official ballots, which need one official personId; this member has none, so remove them to read OpenParliament ballots.',
        );
      const empty = (value: Activity<unknown, number | null>) =>
        value.status === 'available' && !value.items.length;
      // An OpenParliament page carries no count, so only its empty first page shows an empty section.
      if (empty(sponsoredBills))
        notices.push(
          input.billsOffset
            ? 'Retry canparl_get_member with billsOffset 0 for sponsored bills.'
            : 'No sponsored bills were returned by this OpenParliament page; use canparl_search_bills to inspect official bill records.',
        );
      if (empty(recentVotes))
        notices.push(
          recentVotes.total === 0
            ? "No official ballots matched; the member-votes feed covers one session, the member's latest unless votesSession names another, so change votesSession or remove votesBillCode and retry canparl_get_member, or use canparl_search_votes."
            : input.votesOffset
              ? 'Retry canparl_get_member with votesOffset 0 for ballots.'
              : 'No ballots were returned by this OpenParliament page; use canparl_search_votes to inspect official divisions.',
        );
      // ctx.enrich.notice is last-wins, so every notice joins this one call.
      if (notices.length) ctx.enrich.notice(notices.join(' '));
      request.throwIfOuterAborted();
      return {
        member,
        memberships,
        sponsoredBills,
        recentVotes,
        openParliament: {
          status: profile ? ('available' as const) : ('unavailable' as const),
          reason: profile ? null : fallbackFailure.reason,
        },
        provenance,
      };
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
