/**
 * @fileoverview Budgeted and paced LEGISinfo transport, successful-response caches, and lifecycle.
 * @module services/legisinfo/legisinfo-service
 */
import {
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import {
  filterFailure,
  normalizeBillCode,
  normalizeFilter,
  normalizeSession,
  rejectSession,
} from '@/domain/normalization.js';
import type { RequestContext } from '@/domain/request-context.js';
import type { SessionInput, Source, SourceResult } from '@/domain/schemas.js';
import {
  billIdentity,
  invalidResponse,
  parseBillDossier,
  parseBillRecords,
  parseBillSummary,
  parseCurrentSession,
  parseSessions,
} from './parsing.js';
import type { BillDossier, BillSummary, LegisinfoSession } from './types.js';

const ORIGIN = 'https://www.parl.ca';
const FIVE_MINUTES = 300_000;
const UNKNOWN_SESSION = { reason: 'unknown_session', retryable: false };
interface CacheEntry {
  data: unknown;
  expiresAt: number;
  source: Source;
}
/** Canonical session token, or a field-named `unknown_session` rejection naming the expected shape. */
function sessionToken(value: Exclude<SessionInput, undefined>): string {
  try {
    return normalizeFilter('session', value, (session) => normalizeSession(session));
  } catch (error) {
    const [message, data, options] = filterFailure(error);
    throw validationError(message, { ...UNKNOWN_SESSION, ...data }, options);
  }
}

/** Official source service; each operation uses its caller's existing request budget. */
export class LegisinfoService {
  private readonly pacer = createPacer({
    name: 'legisinfo',
    maxConcurrent: 2,
    minStartGapMs: 250,
    maxQueueDepth: 20,
  });
  private readonly cache = new Map<string, CacheEntry>();
  private verifiedCurrent: string | undefined;
  private currentSource: Source | undefined;

  constructor(private readonly config: ServerConfig = getServerConfig()) {}

  /** Discover actual supported sessions; no arithmetic or guessed coverage. */
  async getSessions(request: RequestContext): Promise<SourceResult<LegisinfoSession[]>> {
    const result = await this.load('/legisinfo/en/bills', 21_600_000, parseSessions, request);
    if (
      this.verifiedCurrent &&
      !result.data.some((entry) => entry.session === this.verifiedCurrent)
    ) {
      const [parliament, sessionNumber] = this.verifiedCurrent.split('-').map(Number);
      if (!parliament || !sessionNumber) invalidResponse();
      return {
        ...result,
        provenance: [
          ...result.provenance,
          ...(this.currentSource ? [{ ...this.currentSource, cached: true }] : []),
        ],
        data: [
          {
            session: this.verifiedCurrent,
            parliament,
            sessionNumber,
            coverage: parliament < 37 ? 'basic' : 'full',
          },
          ...result.data,
        ],
      };
    }
    return result;
  }

  /** Resolve current only from the live default feed's consistent ongoing identity. */
  async getCurrentSession(request: RequestContext): Promise<SourceResult<string>> {
    const result = await this.load(
      '/legisinfo/en/bills/json',
      FIVE_MINUTES,
      (body) => parseCurrentSession(parseBillRecords(body)),
      request,
    );
    this.verifiedCurrent = result.data;
    this.currentSource = result.provenance[0];
    return result;
  }

  /** Canonicalize a supplied session, or resolve an omitted one as the verified current session. */
  async resolveSession(
    value: SessionInput,
    request: RequestContext,
  ): Promise<SourceResult<string>> {
    if (value === undefined) return await this.getCurrentSession(request);
    return { data: sessionToken(value), provenance: [] };
  }

  /** Retrieve and validate the entire known official session before local filtering. */
  async listBills(session: string, request: RequestContext): Promise<SourceResult<BillSummary[]>> {
    const verified = await this.verifySession(session, request);
    const result = await this.load(
      `/legisinfo/en/bills/json?parlsession=${verified.data}`,
      FIVE_MINUTES,
      (body) => {
        const rows = parseBillRecords(body);
        const identities = new Set<string>();
        return rows.map((row) => {
          const identity = billIdentity(row);
          if (identity.session !== verified.data || identities.has(identity.billCode))
            invalidResponse();
          identities.add(identity.billCode);
          return parseBillSummary(row);
        });
      },
      request,
    );
    return { data: result.data, provenance: [...verified.provenance, ...result.provenance] };
  }

  /** Read one verified official dossier; source 404s remain typed domain failures. */
  async getBill(
    session: string,
    billCode: string,
    request: RequestContext,
  ): Promise<SourceResult<BillDossier>> {
    let code: string;
    try {
      code = normalizeFilter('billCode', billCode, normalizeBillCode);
    } catch (error) {
      const [message, data, options] = filterFailure(error);
      throw validationError(
        message,
        { reason: 'invalid_bill_code', retryable: false, ...data },
        options,
      );
    }
    const verified = await this.verifySession(session, request);
    const result = await this.load(
      `/legisinfo/en/bill/${verified.data}/${code.toLowerCase()}/json`,
      FIVE_MINUTES,
      (body) => parseBillDossier(parseBillRecords(body), verified.data, code),
      request,
      true,
    );
    return { data: result.data, provenance: [...verified.provenance, ...result.provenance] };
  }

  private async verifySession(
    session: string,
    request: RequestContext,
  ): Promise<SourceResult<string>> {
    const token = sessionToken(session);
    const sessions = await this.getSessions(request);
    if (!sessions.data.some((entry) => entry.session === token))
      throw rejectSession(
        'session',
        'official bill',
        sessions.data.map((entry) => entry.session),
        UNKNOWN_SESSION,
      );
    return { data: token, provenance: sessions.provenance };
  }

  private async load<T>(
    path: string,
    ttlMs: number,
    parse: (body: string) => T,
    request: RequestContext,
    billDetail = false,
  ): Promise<SourceResult<T>> {
    request.throwIfAborted();
    const url = new URL(path, ORIGIN).href;
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > Date.now())
      return {
        data: structuredClone(cached.data) as T,
        provenance: [{ ...cached.source, cached: true }],
      };
    if (cached) this.cache.delete(url);
    try {
      const result = await withRetry(
        (attempt) =>
          this.pacer.run(
            async () => {
              request.throwIfAborted();
              const body = await this.fetchText(
                url,
                Date.now() + Math.min(10_000, attempt.remainingMs),
                attempt.signal,
                request,
                billDetail,
              );
              request.throwIfAborted();
              const data = parse(body);
              request.throwIfAborted();
              const source: Source = {
                source: 'legisinfo',
                url,
                retrievedAt: new Date().toISOString(),
                cached: false,
              };
              return { data, source };
            },
            { signal: attempt.signal },
          ),
        {
          operation: 'legisinfo.fetch',
          context: request.context,
          signal: request.signal,
          deadlineMs: Math.min(20_000, request.remainingMs()),
          maxRetries: 2,
          baseDelayMs: 1000,
          maxDelayMs: 5000,
        },
      );
      request.throwIfAborted();
      if (this.cache.size >= 256) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(url, {
        data: structuredClone(result.data),
        source: result.source,
        expiresAt: Date.now() + ttlMs,
      });
      return { data: result.data, provenance: [{ ...result.source }] };
    } catch (error) {
      request.throwIfAborted();
      throw error;
    }
  }

  private async fetchText(
    initial: string,
    deadlineAt: number,
    signal: AbortSignal,
    request: RequestContext,
    billDetail: boolean,
  ): Promise<string> {
    let target = new URL(initial);
    for (let hop = 0; hop <= 3; hop++) {
      try {
        const response = await fetchWithTimeout(
          target.href,
          Math.max(1, deadlineAt - Date.now()),
          request.context,
          {
            signal,
            redirect: 'manual',
            errorBodyLimit: 0,
            errorHeaders: ['location', 'retry-after'],
            expectedStatuses: [301, 302, 303, 307, 308, 404],
            headers: {
              'User-Agent': this.config.userAgent,
              Accept: target.pathname.endsWith('/json') ? 'application/json' : 'text/html',
            },
          },
        );
        return await response.text();
      } catch (error) {
        request.throwIfAborted();
        if (!(error instanceof McpError)) throw error;
        const status = error.data?.status;
        if (status === 403)
          throw serviceUnavailable('LEGISinfo refused the official data request.', {
            reason: 'upstream_blocked',
            source: 'legisinfo',
            status: 403,
            retryable: false,
            recovery: { hint: 'Retry LEGISinfo later for official parliamentary data.' },
          });
        if (status === 404 && billDetail)
          throw notFound('The official bill dossier was not found.', {
            reason: 'bill_not_found',
            retryable: false,
          });
        if (typeof status !== 'number' || ![301, 302, 303, 307, 308].includes(status)) throw error;
        const headers = error.data?.headers;
        const location =
          typeof headers === 'object' && headers !== null && 'location' in headers
            ? headers.location
            : undefined;
        if (typeof location !== 'string')
          throw serviceUnavailable('LEGISinfo returned an unsupported redirect.', {
            reason: 'upstream_response_invalid',
            retryable: false,
          });
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          invalidResponse();
        }
        if (
          billDetail &&
          next.origin === ORIGIN &&
          /^\/ErrorPage\//i.test(next.pathname) &&
          next.searchParams.get('StatusCode') === '404'
        )
          throw notFound('The official bill dossier was not found.', {
            reason: 'bill_not_found',
            retryable: false,
          });
        if (
          hop === 3 ||
          next.origin !== ORIGIN ||
          next.username ||
          next.password ||
          next.hash ||
          next.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '') ||
          next.search !== target.search ||
          next.href === target.href
        )
          throw serviceUnavailable('LEGISinfo returned an unsupported redirect.', {
            reason: 'upstream_response_invalid',
            retryable: false,
          });
        target = next;
      }
    }
    return invalidResponse();
  }

  /** Release queued work and local cache at application teardown. */
  dispose(): void {
    this.pacer.dispose();
    this.cache.clear();
    this.verifiedCurrent = undefined;
    this.currentSource = undefined;
  }
}

let service: LegisinfoService | undefined;
/** Initialize once during application setup. */
export function initLegisinfoService(config: ServerConfig = getServerConfig()): LegisinfoService {
  service?.dispose();
  service = new LegisinfoService(config);
  return service;
}
/** Access the application-owned official bill service. */
export function getLegisinfoService(): LegisinfoService {
  if (!service) throw new Error('LEGISinfo service is not initialized.');
  return service;
}
/** Dispose application-owned service state. */
export function disposeLegisinfoService(): void {
  service?.dispose();
  service = undefined;
}
