/**
 * @fileoverview Verified crosswalk from an official personId's roster row to one OpenParliament
 * profile, shared by `canparl_get_member` and every tool input that accepts an OpenParliament slug,
 * and the disclosure when a digit-only slug value is also a former MP's personId.
 * @module mcp-server/tools/definitions/_member-identity
 */
import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { PERSON_ID, stripAccents, vocabularyKey } from '@/domain/normalization.js';
import type { RequestContext } from '@/domain/request-context.js';
import type { Source } from '@/domain/schemas.js';
import {
  getOpenParliamentService,
  type PoliticianProfile,
} from '@/services/openparliament/index.js';
import {
  getOurCommonsService,
  type OurCommonsMember,
  type RosterMember,
} from '@/services/ourcommons/index.js';

function foldAccents(value: string): string {
  return stripAccents(value).normalize('NFC');
}

/** Only interior single-letter initials are optional; full given names remain distinct. */
function identityName(value: string): string {
  const words = vocabularyKey(foldAccents(value)).split(' ');
  return words
    .filter((word, index) => {
      if (index === 0 || index === words.length - 1) return true;
      const initial = word.endsWith('.') ? word.slice(0, -1) : word;
      return !/^[a-z]$/.test(initial);
    })
    .join(' ');
}

/**
 * Verify one profile by recorded name or published alias and official personId; existing exact
 * name/profile matches take precedence. An empty exact name page permits surname and different
 * accent-folded surname pages. Every page and the union
 * must be complete with at most three unique candidates; source failures propagate. Never
 * requests `/politicians/{personId}/`. The row is a current member's or, for a former member, the
 * all-Parliaments roster row; the rules are the same.
 */
export async function crosswalkProfile(
  official: RosterMember,
  request: RequestContext,
  provenance: Source[],
): Promise<PoliticianProfile | null> {
  const service = getOpenParliamentService();
  const candidates = await service.listPoliticians(
    { include: 'all', name: official.name, limit: 4, offset: 0 },
    request,
  );
  provenance.push(...candidates.provenance);
  if (candidates.nextOffset !== null || candidates.objects.length > 3) return null;
  const name = identityName(official.name);
  const exact = candidates.objects.filter(
    (row) => vocabularyKey(row.name) === vocabularyKey(official.name),
  );
  // Preserve existing exact-name successes and their request count before considering variants.
  const named =
    exact.length > 0 ? exact : candidates.objects.filter((row) => identityName(row.name) === name);
  const identifiers = new Set(named.map((row) => row.slug));
  if (candidates.objects.length === 0) {
    const surnames = new Set([official.lastName, foldAccents(official.lastName)]);
    for (const familyName of surnames) {
      const page = await service.listPoliticians(
        { include: 'all', familyName, limit: 4, offset: 0 },
        request,
      );
      provenance.push(...page.provenance);
      if (page.nextOffset !== null || page.objects.length > 3) return null;
      for (const row of page.objects) identifiers.add(row.slug);
      if (identifiers.size > 3) return null;
    }
  }
  const matches: PoliticianProfile[] = [];
  const exactMatches: PoliticianProfile[] = [];
  for (const slug of identifiers) {
    const result = await service.getPolitician(slug, request);
    provenance.push(...result.provenance);
    if (
      [result.data.name, ...result.data.alternateNames].some(
        (value) => identityName(value) === name,
      ) &&
      result.data.personIds?.includes(official.personId)
    ) {
      matches.push(result.data);
      if (exact.length > 0 && vocabularyKey(result.data.name) === vocabularyKey(official.name))
        exactMatches.push(result.data);
    }
  }
  const verified = exactMatches.length > 0 ? exactMatches : matches;
  return verified.length === 1 ? (verified[0] ?? null) : null;
}

/**
 * Ceiling on the optional all-Parliaments roster read, every retry included, so a slow or stalled
 * roster costs the primary answer at most this much of the call's upstream budget.
 */
const FORMER_MEMBER_READ_MS = 5_000;

/**
 * A child context whose upstream work also stops at `budgetMs`; caller cancellation and the outer
 * call deadline still come from `request`. Dispose it to clear its timer.
 */
function boundedRequest(
  request: RequestContext,
  budgetMs: number,
): RequestContext & { dispose(): void } {
  const own = new AbortController();
  const timer = setTimeout(
    () => own.abort(timeout('The optional all-Parliaments roster read exceeded its budget.')),
    budgetMs,
  );
  const signal = AbortSignal.any([request.signal, own.signal]);
  const deadlineAt = Math.min(request.deadlineAt, Date.now() + budgetMs);
  return {
    context: request.context,
    callerSignal: request.callerSignal,
    outerSignal: request.outerSignal,
    signal,
    deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    throwIfOuterAborted: () => request.throwIfOuterAborted(),
    throwIfAborted: () => {
      request.throwIfOuterAborted();
      signal.throwIfAborted();
    },
    dispose: () => clearTimeout(timer),
  };
}

/**
 * The former MP whose official personId equals `digits`, a slug value already known not to be a
 * current personId and read as an OpenParliament ID. Null without a request for a non-numeric value
 * or a profile whose `parl_mp_id` lists the digits; otherwise one all-Parliaments roster read, shared
 * through the service cache with `canparl_get_member`'s former-personId lookup. Best effort: any
 * failure of that read, its {@link FORMER_MEMBER_READ_MS} ceiling included, and a matching row that
 * still reads as sitting return null. Caller cancellation, the outer call deadline, and non-McpError
 * failures propagate.
 */
export async function findFormerMember(
  digits: string,
  profile: PoliticianProfile | null,
  request: RequestContext,
  provenance: Source[],
): Promise<RosterMember | null> {
  if (!PERSON_ID.test(digits) || profile?.personIds?.includes(digits)) return null;
  const bounded = boundedRequest(request, FORMER_MEMBER_READ_MS);
  try {
    const roster = await getOurCommonsService().listAllMembers(bounded);
    provenance.push(...roster.provenance);
    // A row without an end date contradicts the current roster just read: two cached reads disagree.
    return roster.data.find((row) => row.personId === digits && row.to !== null) ?? null;
  } catch (error) {
    request.throwIfOuterAborted();
    if (error instanceof McpError) return null;
    throw error;
  } finally {
    bounded.dispose();
  }
}

/** Slug input a disclosure names; `canparl_get_member`'s own `slug` routes to its personId alone. */
export type SlugField = 'politician' | 'sponsor' | 'slug';
const followSlug = (field: SlugField) =>
  field === 'slug'
    ? ''
    : ` and pass its member.slug as ${field}; a null member.slug means OpenParliament holds no verified profile`;

/**
 * Notice for an answer read through a numeric OpenParliament ID that is also a former MP's
 * personId. Names both people; the roster records no gender, so the text uses no pronoun.
 */
export function formerMemberNotice(
  digits: string,
  profile: PoliticianProfile,
  former: RosterMember,
  field: SlugField,
): string {
  return `${digits} was read as OpenParliament's ${profile.name}; it is also the official personId of former MP ${former.name}. For that member, call canparl_get_member with personId ${digits}${followSlug(field)}.`;
}

/**
 * Throw-site recovery for a not-found failure whose digit-only value is a former MP's personId:
 * fixed prose, so no source value enters the error text.
 */
export function formerMemberRecovery(field: SlugField): { recovery: { hint: string } } {
  return {
    recovery: {
      hint: `The ${field} value matches no OpenParliament profile, but its digits are a former MP's official personId; call canparl_get_member with those digits as personId${followSlug(field)}.`,
    },
  };
}

/** A slug filter's verified profile, and the former MP whose official personId it also is. */
export interface PoliticianResolution {
  /** From {@link findFormerMember}; null for a current personId or a non-numeric slug. */
  formerMember: RosterMember | null;
  /** Null when OpenParliament has no such politician or no unique profile verifies. */
  profile: PoliticianProfile | null;
}

/**
 * Resolve a normalized slug filter to its verified profile. A digit-only value equal to a current
 * official personId goes through {@link crosswalkProfile}, the roster read before any OpenParliament
 * request; every other value, numeric OpenParliament IDs included, is a slug. Former members'
 * personIds stay slugs too, since some equal another politician's numeric OpenParliament ID;
 * {@link findFormerMember} then names the former member, found or not. Roster and other source
 * failures propagate.
 */
export async function resolvePolitician(
  slug: string,
  request: RequestContext,
  provenance: Source[],
): Promise<PoliticianResolution> {
  let official: OurCommonsMember | undefined;
  if (PERSON_ID.test(slug)) {
    const roster = await getOurCommonsService().listMembers(request);
    provenance.push(...roster.provenance);
    official = roster.data.find((row) => row.personId === slug);
  }
  let profile: PoliticianProfile | null = null;
  try {
    if (official) profile = await crosswalkProfile(official, request, provenance);
    else {
      const result = await getOpenParliamentService().getPolitician(slug, request);
      provenance.push(...result.provenance);
      profile = result.data;
    }
  } catch (error) {
    request.throwIfAborted();
    if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.NotFound) throw error;
  }
  return {
    profile,
    formerMember: official ? null : await findFormerMember(slug, profile, request, provenance),
  };
}
