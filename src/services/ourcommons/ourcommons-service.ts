/** @fileoverview Budgeted, cached official House source integration. @module services/ourcommons/ourcommons-service */
import {
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '../../config/server-config.js';
import { normalizeSession } from '../../domain/normalization.js';
import type { RequestContext } from '../../domain/request-context.js';
import type { Source } from '../../domain/schemas.js';
import { parseMembers, parseVoteParticipants, parseVoteSessions, parseVotes } from './parsing.js';
import type {
  Division,
  OurCommonsMember,
  SourceResult,
  VoteParticipant,
  VoteSession,
} from './types.js';

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
    const deadlineAt = Date.now() + Math.min(20_000, request.remainingMs());
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
        deadlineMs: Math.min(20_000, request.remainingMs()),
      },
    ).catch((error: unknown) => {
      request.throwIfAborted();
      throw error;
    });
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
  private async verifySession(session: string, request: RequestContext): Promise<Source[]> {
    const canonical = normalizeSession(session);
    if (canonical !== session)
      throw validationError('Expected a canonical parliamentary session.', {
        reason: 'unsupported_vote_session',
        retryable: false,
      });
    const sessions = await this.getVoteSessions(request);
    if (!sessions.data.some((entry) => entry.session === session))
      throw validationError('Session is not advertised by the official House divisions index.', {
        reason: 'unsupported_vote_session',
        retryable: false,
        session,
      });
    return sessions.provenance;
  }
  /** Obtain complete session metadata; caller owns filtering and pagination. */
  async listVotes(session: string, request: RequestContext): Promise<SourceResult<Division[]>> {
    const provenance = await this.verifySession(session, request);
    const result = await this.load(
      `/Members/en/votes/xml?parlSession=${encodeURIComponent(session)}`,
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
