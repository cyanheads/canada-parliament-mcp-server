/**
 * @fileoverview Verified crosswalk from an official current personId to one OpenParliament profile,
 * shared by every tool input that accepts an OpenParliament slug.
 * @module mcp-server/tools/definitions/_member-identity
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { vocabularyKey } from '@/domain/normalization.js';
import type { RequestContext } from '@/domain/request-context.js';
import type { Source } from '@/domain/schemas.js';
import {
  getOpenParliamentService,
  type PoliticianProfile,
} from '@/services/openparliament/index.js';
import { getOurCommonsService, type OurCommonsMember } from '@/services/ourcommons/index.js';

/** Decimal official personId; a digit-only slug input may be one. */
export const PERSON_ID = /^\d+$/;

/**
 * The one OpenParliament profile verified for a current member: exact normalized full-name
 * candidates from a single bounded name page (at most three), each required to list the official
 * personId. Null when the page has a continuation or a fourth row, or no unique profile verifies;
 * source failures propagate. Never requests `/politicians/{personId}/`.
 */
export async function crosswalkProfile(
  official: OurCommonsMember,
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
  const name = vocabularyKey(official.name);
  const matches: PoliticianProfile[] = [];
  for (const candidate of candidates.objects.filter((row) => vocabularyKey(row.name) === name)) {
    const result = await service.getPolitician(candidate.slug, request);
    provenance.push(...result.provenance);
    if (
      vocabularyKey(result.data.name) === name &&
      result.data.personIds?.includes(official.personId)
    )
      matches.push(result.data);
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Resolve a normalized slug filter to its verified profile. A digit-only value equal to a current
 * official personId goes through {@link crosswalkProfile}, the roster read before any OpenParliament
 * request; every other value, numeric OpenParliament IDs included, is a slug. Null when
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
