/**
 * @fileoverview Verified crosswalk from an official personId's roster row to one OpenParliament
 * profile, shared by `canparl_get_member` and every tool input that accepts an OpenParliament slug.
 * @module mcp-server/tools/definitions/_member-identity
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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
 * Resolve a normalized slug filter to its verified profile. A digit-only value equal to a current
 * official personId goes through {@link crosswalkProfile}, the roster read before any OpenParliament
 * request; every other value, numeric OpenParliament IDs included, is a slug. Former members'
 * personIds stay slugs too: some equal another politician's numeric OpenParliament ID. Null when
 * OpenParliament has no such politician or no unique profile verifies; roster and other source
 * failures propagate.
 */
export async function resolvePolitician(
  slug: string,
  request: RequestContext,
  provenance: Source[],
): Promise<PoliticianProfile | null> {
  let official: OurCommonsMember | undefined;
  if (PERSON_ID.test(slug)) {
    const roster = await getOurCommonsService().listMembers(request);
    provenance.push(...roster.provenance);
    official = roster.data.find((row) => row.personId === slug);
  }
  try {
    if (official) return await crosswalkProfile(official, request, provenance);
    const result = await getOpenParliamentService().getPolitician(slug, request);
    provenance.push(...result.provenance);
    return result.data;
  } catch (error) {
    request.throwIfAborted();
    if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) return null;
    throw error;
  }
}
