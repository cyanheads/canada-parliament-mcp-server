/**
 * @fileoverview Verified member identity and independently bounded source activity.
 * @module mcp-server/tools/definitions/get-member.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { normalizeSlug, vocabularyKey } from '@/domain/normalization.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  BilingualTextSchema,
  OffsetSchema,
  OptionalStringSchema,
  type Source,
  SourceSchema,
} from '@/domain/schemas.js';
import {
  getOpenParliamentService,
  type PoliticianProfile,
} from '@/services/openparliament/index.js';
import { getOurCommonsService, type OurCommonsMember } from '@/services/ourcommons/index.js';
import { formatResult, renderValue } from './_format.js';
import { MemberSummarySchema } from './search-members.tool.js';

const nullableText = () => z.string().nullable();
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
    session: z.string().describe('Vote session.'),
    number: z.number().int().describe('Vote number.'),
    date: nullableText().describe('Source vote date, or null.'),
    subject: nullableText().describe('Source vote subject, or null.'),
    ballot: z
      .enum(['Yes', 'No', 'Paired', "Didn't vote"])
      .describe('OpenParliament ballot vocabulary.'),
    url: z.string().describe('Absolute HTTPS vote URL.'),
  })
  .strict()
  .describe('Hydrated member ballot.');
function activitySchema<T extends z.ZodType>(item: T) {
  return z
    .object({
      status: z
        .enum(['available', 'unavailable', 'not_requested'])
        .describe('Availability; unavailable never means empty history.'),
      items: z
        .array(item)
        .describe('Complete hydrated returned page, or no rows when unavailable.'),
      offset: z.number().int().describe('Requested activity offset.'),
      limit: z.number().int().describe('Requested workload limit; zero disables activity.'),
      total: z.null().describe('Source does not supply a total.'),
      nextOffset: z.number().int().nullable().describe('Source continuation, or null.'),
      hasMore: z.boolean().describe('Whether the source supplies a continuation.'),
      failure: FailureSchema.nullable().describe('Failure metadata only when unavailable.'),
    })
    .strict()
    .describe('Independently pageable activity section.');
}
interface Activity<T> {
  failure: Failure | null;
  hasMore: boolean;
  items: T[];
  limit: number;
  nextOffset: number | null;
  offset: number;
  status: 'available' | 'unavailable' | 'not_requested';
  total: null;
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

/** Read a verified public profile without projecting current attributes into history. */
export const getMemberTool = tool('canparl_get_member', {
  description:
    'Read one House MP by a returned OpenParliament slug or official current personId. Pass exactly one identifier from canparl_search_members detailLookup. Official profiles survive unavailable OpenParliament enrichment. Sponsored bills and recent ballots are independently pageable; set their limits to zero for profile-only lookup.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    slug: OptionalStringSchema.describe(
      'Returned OpenParliament slug, politician path, or HTTPS OpenParliament profile URL; never a guessed name.',
    ),
    personId: OptionalStringSchema.describe(
      'Decimal official current person ID; distinct from an OpenParliament slug.',
    ),
    sponsoredBills: z
      .number()
      .int()
      .min(0)
      .max(5)
      .default(5)
      .describe('Sponsored bill rows to hydrate, 0–5; zero disables.'),
    billsOffset: OffsetSchema.describe('Zero-based sponsored bill page offset.'),
    recentVotes: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(10)
      .describe('Ballot rows to hydrate, 0–10; zero disables.'),
    votesOffset: OffsetSchema.describe('Zero-based ballot page offset.'),
  }),
  output: z.object({
    member: MemberSummarySchema.extend({
      gender: nullableText().describe('Source gender, or null.'),
      imageUrl: nullableText().describe('HTTPS portrait reference, or null.'),
      links: z
        .array(
          z
            .object({
              url: z.string().describe('Actual HTTPS link destination.'),
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
    sponsoredBills: activitySchema(SponsoredBillSchema),
    recentVotes: activitySchema(MemberVoteSchema),
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
        slug: nullableText().describe('Normalized requested slug.'),
        personId: nullableText().describe('Requested official ID.'),
        sponsoredBills: z.number().int().describe('Requested bill workload cap.'),
        billsOffset: z.number().int().describe('Requested bill offset.'),
        recentVotes: z.number().int().describe('Requested ballot workload cap.'),
        votesOffset: z.number().int().describe('Requested ballot offset.'),
      })
      .strict()
      .describe('Normalized lookup and independent activity controls.'),
    shown: z
      .object({
        sponsoredBills: z.number().int().describe('Hydrated returned bills.'),
        recentVotes: z.number().int().describe('Hydrated returned ballots.'),
      })
      .strict()
      .describe('Returned activity counts.'),
    cap: z
      .object({
        sponsoredBills: z.number().int().describe('Bill workload cap.'),
        recentVotes: z.number().int().describe('Ballot workload cap.'),
      })
      .strict()
      .describe('Requested bounded workloads.'),
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
    notice: z.string().optional().describe('Coverage and recovery guidance.'),
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
      when: 'Neither, both, or malformed identifiers supplied.',
      recovery:
        'Call canparl_search_members and pass exactly one identifier from a result detailLookup to canparl_get_member.',
      retryable: false,
    },
    {
      reason: 'member_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Slug missing or official person ID absent from current roster.',
      recovery:
        'Call canparl_search_members with includeFormer true and a surname or full name, then pass a returned slug to canparl_get_member.',
      retryable: false,
    },
  ],
  async handler(input, ctx) {
    const request = createRequestContext(ctx);
    try {
      if (!!input.slug === !!input.personId || (input.personId && !/^\d+$/.test(input.personId)))
        throw ctx.fail('invalid_member_identifier');
      let slug: string | undefined;
      try {
        slug = input.slug ? normalizeSlug(input.slug) : undefined;
      } catch {
        throw ctx.fail('invalid_member_identifier');
      }
      const service = getOpenParliamentService();
      const provenance: Source[] = [];
      const unavailable: { section: string; failure: Failure }[] = [];
      let official: OurCommonsMember | undefined;
      let profile: PoliticianProfile | undefined;
      let verifiedCurrent: boolean | null = null;
      let crosswalkFailure: Failure | null = null;
      if (input.personId) {
        const roster = await getOurCommonsService().listMembers(request);
        provenance.push(...roster.provenance);
        official = roster.data.find((row) => row.personId === input.personId);
        if (!official) throw ctx.fail('member_not_found');
        verifiedCurrent = true;
        try {
          const candidates = await service.listPoliticians(
            { include: 'all', name: official.name, limit: 4, offset: 0 },
            request,
          );
          provenance.push(...candidates.provenance);
          if (candidates.nextOffset !== null || candidates.objects.length > 3)
            throw serviceUnavailable('Member identity crosswalk is not uniquely bounded.', {
              retryable: false,
            });
          const officialName = official.name;
          const exact = candidates.objects.filter(
            (row) => vocabularyKey(row.name) === vocabularyKey(officialName),
          );
          const matches: PoliticianProfile[] = [];
          for (const candidate of exact) {
            const result = await service.getPolitician(candidate.slug, request);
            provenance.push(...result.provenance);
            if (
              vocabularyKey(result.data.name) === vocabularyKey(official.name) &&
              result.data.personIds?.includes(input.personId)
            )
              matches.push(result.data);
          }
          if (matches.length !== 1)
            throw serviceUnavailable('No unique verified member identity crosswalk is available.', {
              retryable: false,
            });
          profile = matches[0];
        } catch (error) {
          request.throwIfOuterAborted();
          crosswalkFailure = failure(error);
          unavailable.push({ section: 'openParliament', failure: crosswalkFailure });
        }
      } else if (slug) {
        try {
          const result = await service.getPolitician(slug, request);
          profile = result.data;
          provenance.push(...result.provenance);
        } catch (error) {
          request.throwIfAborted();
          if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)
            throw ctx.fail('member_not_found', undefined, undefined, { cause: error });
          throw error;
        }
        if (profile.personIds?.length) {
          try {
            const roster = await getOurCommonsService().listMembers(request);
            provenance.push(...roster.provenance);
            const matches = roster.data.filter((row) => profile?.personIds?.includes(row.personId));
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
            failure: {
              code: 'ServiceUnavailable',
              reason: 'official_identity_unavailable',
              recovery,
              retryable: false,
            },
          });
        }
      }
      const fallbackFailure = crosswalkFailure ?? {
        code: 'ServiceUnavailable',
        reason: 'identity_unavailable',
        recovery,
        retryable: false,
      };
      let sponsoredBills = section<z.infer<typeof SponsoredBillSchema>>(
        input.billsOffset,
        input.sponsoredBills,
        fallbackFailure,
      );
      let recentVotes = section<z.infer<typeof MemberVoteSchema>>(
        input.votesOffset,
        input.recentVotes,
        fallbackFailure,
      );
      if (profile && input.sponsoredBills) {
        try {
          request.throwIfAborted();
          const page = await service.listBills(
            { sponsor: profile.slug, limit: input.sponsoredBills, offset: input.billsOffset },
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
          sponsoredBills = {
            status: 'available',
            items,
            offset: input.billsOffset,
            limit: input.sponsoredBills,
            total: null,
            nextOffset: page.nextOffset,
            hasMore: page.nextOffset !== null,
            failure: null,
          };
        } catch (error) {
          request.throwIfOuterAborted();
          sponsoredBills = section(input.billsOffset, input.sponsoredBills, failure(error));
        }
      }
      if (profile && input.recentVotes) {
        try {
          request.throwIfAborted();
          const page = await service.listBallots(
            { politician: profile.slug, limit: input.recentVotes, offset: input.votesOffset },
            request,
          );
          provenance.push(...page.provenance);
          const details = new Map<string, Awaited<ReturnType<typeof service.getVote>>['data']>();
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
            });
          }
          recentVotes = {
            status: 'available',
            items,
            offset: input.votesOffset,
            limit: input.recentVotes,
            total: null,
            nextOffset: page.nextOffset,
            hasMore: page.nextOffset !== null,
            failure: null,
          };
        } catch (error) {
          request.throwIfOuterAborted();
          recentVotes = section(input.votesOffset, input.recentVotes, failure(error));
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
          failure: {
            code: 'ServiceUnavailable',
            reason: 'membership_history_unavailable',
            recovery,
            retryable: false,
          },
        });
      const personId =
        official?.personId ??
        (profile?.personIds?.length === 1 ? (profile.personIds[0] ?? null) : null);
      const identity = official ?? profile;
      if (!identity) throw ctx.fail('member_not_found');
      let detailLookup: { personId: string } | { slug: string };
      if (official) detailLookup = { personId: official.personId };
      else if (profile) detailLookup = { slug: profile.slug };
      else throw ctx.fail('member_not_found');
      const member = {
        personId,
        slug: profile?.slug ?? null,
        name: identity.name,
        party: official ? official.party : (profile?.party ?? null),
        riding: official ? official.riding : (profile?.riding ?? null),
        province: official ? official.province : (profile?.province ?? null),
        current: verifiedCurrent,
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
          personId: input.personId ?? null,
          sponsoredBills: input.sponsoredBills,
          billsOffset: input.billsOffset,
          recentVotes: input.recentVotes,
          votesOffset: input.votesOffset,
        },
        shown: {
          sponsoredBills: sponsoredBills.items.length,
          recentVotes: recentVotes.items.length,
        },
        cap: { sponsoredBills: input.sponsoredBills, recentVotes: input.recentVotes },
        truncated: { sponsoredBills: sponsoredBills.hasMore, recentVotes: recentVotes.hasMore },
        unavailable,
      });
      const notices = [];
      if (!profile)
        notices.push(
          'No verified OpenParliament match is available; retain the official profile and use canparl_search_members with includeFormer true to inspect named candidates.',
        );
      if (unavailable.length)
        notices.push(
          'Some optional enrichment is unavailable; inspect unavailable and section failure metadata before drawing historical conclusions.',
        );
      if (
        [sponsoredBills, recentVotes].some(
          (value) => value.status === 'available' && !value.items.length,
        )
      )
        notices.push(
          'No activity was returned by this OpenParliament page; use canparl_search_bills or canparl_search_votes to inspect official records.',
        );
      if (
        (sponsoredBills.status === 'available' &&
          !sponsoredBills.items.length &&
          input.billsOffset) ||
        (recentVotes.status === 'available' && !recentVotes.items.length && input.votesOffset)
      )
        notices.push(
          'Retry canparl_get_member with billsOffset 0 or votesOffset 0 for that section.',
        );
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
