/** @fileoverview Budgeted, cached official House source integration. @module services/ourcommons/ourcommons-service */
import {
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { quoteValues, rejectFilter, rejectSession } from '@/domain/normalization.js';
import type { RequestContext } from '@/domain/request-context.js';
import type { Source, SourceResult } from '@/domain/schemas.js';
import {
  parseMembers,
  parseMemberVotes,
  parseRoster,
  parseRosterParliaments,
  parseVoteParticipants,
  parseVoteSessions,
  parseVotes,
} from './parsing.js';
import type {
  Division,
  MemberVote,
  OurCommonsMember,
  RosterMember,
  VoteParticipant,
  VoteSession,
} from './types.js';

/**
 * A roster the picker offers, which the source answers with an empty 200 only when something is
 * wrong upstream: an unknown `p` returns the same empty root, so emptiness never means no members.
 */
function populatedRoster(xml: string): RosterMember[] {
  const rows = parseRoster(xml);
  if (!rows.length)
    throw serviceUnavailable('An official House roster the source offers came back empty.', {
      reason: 'roster_unavailable',
      retryable: true,
    });
  return rows;
}

interface CacheEntry {
  data: unknown;
  expiresAt: number;
  source: Source;
}
/** Owns the House source's shared pacer and successful parsed response cache. */
export class OurCommonsService {
  private readonly pacer = createPacer({
    name: 'ourcommons',
    maxConcurrent: 2,
    minStartGapMs: 250,
    maxQueueDepth: 20,
  });
  private readonly cache = new Map<string, CacheEntry>();
  constructor(private readonly config: ServerConfig = getServerConfig()) {}

  private async load<T>(
    path: string,
    parse: (text: string) => T,
    request: RequestContext,
    ttl = 300_000,
    html = false,
  ): Promise<SourceResult<T>> {
    request.throwIfAborted();
    const url = new URL(path, 'https://www.ourcommons.ca').href;
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > Date.now())
      return {
        data: structuredClone(cached.data) as T,
        provenance: [{ ...cached.source, cached: true }],
      };
    if (cached) this.cache.delete(url);
    const deadlineMs = Math.min(20_000, request.remainingMs());
    const deadlineAt = Date.now() + deadlineMs;
    const result = await withRetry(
      (attempt) =>
        this.pacer.run(
          async (signal) => {
            request.throwIfAborted();
            const response = await fetchWithTimeout(
              url,
              Math.min(10_000, Math.max(1, deadlineAt - Date.now())),
              request.context,
              {
                signal,
                redirect: 'manual',
                errorBodyLimit: 0,
                headers: {
                  'User-Agent': this.config.userAgent,
                  Accept: html ? 'text/html' : 'application/xml',
                },
              },
            );
            const body = await response.text();
            signal.throwIfAborted();
            request.throwIfAborted();
            const data = parse(body);
            signal.throwIfAborted();
            request.throwIfAborted();
            return {
              data,
              source: {
                source: 'ourcommons' as const,
                url,
                retrievedAt: new Date().toISOString(),
                cached: false,
              },
            };
          },
          { signal: attempt.signal },
        ),
      {
        context: request.context,
        signal: request.signal,
        operation: 'OurCommons.fetch',
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        deadlineMs,
      },
    ).catch((error: unknown) => {
      request.throwIfAborted();
      if (error instanceof McpError && error.data?.status === 403)
        throw serviceUnavailable('OurCommons refused the official data request.', {
          reason: 'upstream_blocked',
          source: 'ourcommons',
          status: 403,
          retryable: false,
          recovery: { hint: 'Retry OurCommons later for official parliamentary data.' },
        });
      throw error;
    });
    for (const [key, entry] of this.cache)
      if (entry.expiresAt <= Date.now()) this.cache.delete(key);
    if (this.cache.size >= 256) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, {
      data: structuredClone(result.data),
      source: result.source,
      expiresAt: Date.now() + ttl,
    });
    return { data: result.data, provenance: [{ ...result.source }] };
  }

  /** Obtain only sessions actually advertised by the divisions picker. */
  getVoteSessions(request: RequestContext): Promise<SourceResult<VoteSession[]>> {
    return this.load('/Members/en/votes', parseVoteSessions, request, 21_600_000, true);
  }
  /** Obtain the entire current roster without per-person network requests. */
  listMembers(request: RequestContext): Promise<SourceResult<OurCommonsMember[]>> {
    return this.load('/Members/en/search/xml', parseMembers, request);
  }
  /** Obtain the Parliaments the Members search picker offers; the roster ignores any other `p`. */
  getRosterParliaments(request: RequestContext): Promise<SourceResult<number[]>> {
    return this.load('/Members/en/search', parseRosterParliaments, request, 21_600_000, true);
  }
  /**
   * Obtain everyone who sat in one Parliament, one row each with the caucus and riding last held
   * there. A Parliament the picker does not offer is a `parliament` filter rejection listing the
   * offered ones, before any roster request.
   */
  async listParliamentMembers(
    parliament: number,
    request: RequestContext,
  ): Promise<SourceResult<RosterMember[]>> {
    const picker = await this.getRosterParliaments(request);
    if (!picker.data.includes(parliament)) {
      const offered = picker.data.map(String);
      throw rejectFilter(
        'parliament',
        `Expected a Parliament the official House roster offers: ${quoteValues(offered)}.`,
        { allowed: offered },
      );
    }
    const result = await this.load(
      `/Members/en/search/xml?p=${parliament}`,
      populatedRoster,
      request,
    );
    return { data: result.data, provenance: [...picker.provenance, ...result.provenance] };
  }
  /** Obtain everyone in any offered Parliament, one row each from their latest Parliament. */
  listAllMembers(request: RequestContext): Promise<SourceResult<RosterMember[]>> {
    return this.load('/Members/en/search/xml?p=*', populatedRoster, request);
  }
  /** Verify a session against the divisions picker; a rejection names the caller's `field`. */
  private async verifySession(
    session: string,
    request: RequestContext,
    field = 'session',
  ): Promise<Source[]> {
    const failure = { reason: 'unsupported_vote_session', retryable: false };
    if (!/^[1-9]\d*-[1-9]\d*$/.test(session))
      throw rejectFilter(
        field,
        'Expected a canonical parliament-session token such as 45-1.',
        failure,
      );
    const sessions = await this.getVoteSessions(request);
    if (!sessions.data.some((entry) => entry.session === session))
      throw rejectSession(
        field,
        'official House division',
        sessions.data.map((entry) => entry.session),
        failure,
      );
    return sessions.provenance;
  }
  /** Obtain complete session metadata; caller owns filtering and pagination. */
  async listVotes(session: string, request: RequestContext): Promise<SourceResult<Division[]>> {
    const provenance = await this.verifySession(session, request);
    const result = await this.load(
      `/Members/en/votes/xml?s=${encodeURIComponent(session)}`,
      (text) => parseVotes(text, session),
      request,
    );
    return { data: result.data, provenance: [...provenance, ...result.provenance] };
  }
  /** Obtain a division's ballots, verifying the full identity on every record. */
  async getVoteParticipants(
    session: string,
    number: number,
    request: RequestContext,
  ): Promise<SourceResult<VoteParticipant[]>> {
    const provenance = await this.verifySession(session, request);
    if (!Number.isSafeInteger(number) || number < 1)
      throw validationError('Division number must be a positive integer.');
    try {
      const result = await this.load(
        `/Members/en/votes/${session.replace('-', '/')}/${number}/xml`,
        (text) => {
          const rows = parseVoteParticipants(text, session, number);
          if (!rows.length)
            throw serviceUnavailable('Official division participant detail is unavailable.', {
              reason: 'vote_detail_unavailable',
              retryable: true,
            });
          return rows;
        },
        request,
      );
      return { data: result.data, provenance: [...provenance, ...result.provenance] };
    } catch (error) {
      request.throwIfAborted();
      if (error instanceof McpError && error.data?.status === 404)
        throw notFound('Official House division detail was not found.', {
          reason: 'vote_not_found',
          retryable: false,
          session,
          number,
        });
      throw error;
    }
  }
  /**
   * Obtain one member's recorded ballots in a session in one request. A supplied session is
   * verified against the divisions picker, its rejection naming `votesSession`, the
   * `canparl_get_member` input that carries it; without one the feed answers with the member's
   * latest session. An empty feed cannot tell a session the member did not sit in from an unknown
   * person ID.
   */
  async listMemberVotes(
    personId: string,
    session: string | undefined,
    request: RequestContext,
  ): Promise<SourceResult<MemberVote[]>> {
    if (!/^[1-9]\d*$/.test(personId))
      throw validationError('Person ID must be a positive decimal integer.');
    const provenance =
      session === undefined ? [] : await this.verifySession(session, request, 'votesSession');
    const query = session === undefined ? '' : `?s=${encodeURIComponent(session)}`;
    const result = await this.load(
      `/Members/en/${personId}/votes/xml${query}`,
      (text) => parseMemberVotes(text, personId, session),
      request,
    );
    return { data: result.data, provenance: [...provenance, ...result.provenance] };
  }
  /** Release queued work and cached data at shutdown. */
  dispose(): void {
    this.pacer.dispose();
    this.cache.clear();
  }
}
let service: OurCommonsService | undefined;
/** Initialize the process-wide service during application setup. */
export function initOurCommonsService(config: ServerConfig = getServerConfig()): void {
  service?.dispose();
  service = new OurCommonsService(config);
}
/** Access the initialized House source service. */
export function getOurCommonsService(): OurCommonsService {
  if (!service)
    throw new Error(
      'OurCommons service is not initialized; call initOurCommonsService during setup.',
    );
  return service;
}
/** Dispose the process-wide service during application teardown. */
export function disposeOurCommonsService(): void {
  service?.dispose();
  service = undefined;
}
