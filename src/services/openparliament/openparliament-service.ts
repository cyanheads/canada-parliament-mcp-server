/**
 * @fileoverview Fixed-origin OpenParliament source service with shared pacing and budgets.
 * @module services/openparliament/openparliament-service
 */
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import {
  normalizeBillCode,
  normalizeDate,
  normalizeSession,
  normalizeSlug,
  validateDateRange,
} from '@/domain/normalization.js';
import type { RequestContext } from '@/domain/request-context.js';
import type { SourceResult } from '@/domain/schemas.js';
import {
  API_ORIGIN,
  malformed,
  membershipPath,
  parseBallot,
  parseBill,
  parseJson,
  parseMembership,
  parsePage,
  parsePolitician,
  parsePoliticianProfile,
  parseSpeech,
  parseVote,
  politicianPath,
  record,
} from './parsing.js';
import type {
  Ballot,
  Bill,
  BillInput,
  BillReference,
  Membership,
  PageInput,
  Politician,
  PoliticianInput,
  PoliticianProfile,
  SourcePage,
  Speech,
  SpeechInput,
  Vote,
} from './types.js';

const PROFILE_TTL = 15 * 60_000;
const PAGE_TTL = 2 * 60_000;
const CACHE_LIMIT = 256;
function makePacer() {
  return createPacer({
    name: 'openparliament',
    maxConcurrent: 1,
    minStartGapMs: 2_000,
    maxQueueDepth: 20,
    cooldown: { baseMs: 2_000, maxMs: 10_000 },
  });
}
let sharedPacer: ReturnType<typeof makePacer> | undefined;
function pacer() {
  sharedPacer ??= makePacer();
  return sharedPacer;
}
function pageParams(input: PageInput): Record<string, string> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0
  )
    throw validationError(
      'OpenParliament page requires limit 1–100 and a nonnegative integer offset.',
    );
  return { limit: String(input.limit), offset: String(input.offset) };
}
function sessionToken(value: string): string {
  const session = normalizeSession(value);
  if (!session) throw validationError('A parliamentary session is required.');
  return session;
}
function actorPath(value: string): string {
  return `/politicians/${normalizeSlug(value)}/`;
}
function billPath(value: BillReference): string {
  return `/bills/${sessionToken(value.session)}/${normalizeBillCode(value.code)}/`;
}
function requestUrl(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

/** Complete source access; tool-level identity crosswalks and hydration stay outside. */
export class OpenParliamentService {
  private readonly cache = new Map<
    string,
    { value: unknown; retrievedAt: string; expiresAt: number }
  >();
  constructor(private readonly config: ServerConfig = getServerConfig()) {}

  private async request<T>(
    url: URL,
    ttl: number,
    parse: (value: unknown) => T,
    request: RequestContext,
  ): Promise<SourceResult<T>> {
    request.throwIfAborted();
    const key = url.href;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now())
      return {
        data: parse(structuredClone(cached.value)),
        provenance: [
          { source: 'openparliament', url: key, retrievedAt: cached.retrievedAt, cached: true },
        ],
      };
    this.cache.delete(key);
    const deadlineMs = Math.min(20_000, request.remainingMs());
    const deadlineAt = Date.now() + deadlineMs;
    try {
      return await withRetry(
        ({ signal }) =>
          pacer().run(
            async () => {
              request.throwIfAborted();
              const response = await fetchWithTimeout(
                key,
                Math.min(10_000, Math.max(1, deadlineAt - Date.now())),
                request.context,
                {
                  signal,
                  redirect: 'manual',
                  headers: {
                    Accept: 'application/json',
                    'API-Version': 'v1',
                    'User-Agent': this.config.userAgent,
                  },
                },
              );
              const value = parseJson(await response.text());
              signal.throwIfAborted();
              request.throwIfAborted();
              const data = parse(value);
              signal.throwIfAborted();
              request.throwIfAborted();
              const retrievedAt = new Date().toISOString();
              for (const [entryKey, entry] of this.cache)
                if (entry.expiresAt <= Date.now()) this.cache.delete(entryKey);
              if (this.cache.size >= CACHE_LIMIT) {
                const oldest = this.cache.keys().next().value;
                if (oldest !== undefined) this.cache.delete(oldest);
              }
              this.cache.set(key, { value, retrievedAt, expiresAt: Date.now() + ttl });
              return {
                data,
                provenance: [
                  { source: 'openparliament' as const, url: key, retrievedAt, cached: false },
                ],
              };
            },
            { signal },
          ),
        {
          signal: request.signal,
          context: request.context,
          operation: 'openparliament.request',
          maxRetries: 2,
          baseDelayMs: 2_000,
          maxDelayMs: 10_000,
          deadlineMs,
        },
      );
    } catch (error) {
      request.throwIfAborted();
      throw error;
    }
  }

  private async page<T>(
    url: URL,
    parse: (value: unknown) => T,
    request: RequestContext,
  ): Promise<SourcePage<T>> {
    const result = await this.request(
      url,
      PAGE_TTL,
      (value) => parsePage(value, url, parse),
      request,
    );
    return { ...result.data, provenance: result.provenance };
  }

  /** List current or sparse historical politician rows using documented name filters. */
  listPoliticians(
    input: PoliticianInput,
    request: RequestContext,
  ): Promise<SourcePage<Politician>> {
    const params: Record<string, string> = { ...pageParams(input), include: input.include };
    if (input.name?.trim()) params.name = input.name.trim();
    if (input.familyName?.trim()) params.family_name = input.familyName.trim();
    return this.page(requestUrl('/politicians/', params), parsePolitician, request);
  }
  /**
   * Fetch a profile by an exact returned slug, never a numeric official ID. A numeric OpenParliament
   * ID can answer with a slugged politician's record; that value is no returned identifier, so it is
   * not found rather than a malformed response.
   */
  getPolitician(slug: string, request: RequestContext): Promise<SourceResult<PoliticianProfile>> {
    const requested = normalizeSlug(slug);
    return this.request(
      requestUrl(actorPath(requested)),
      PROFILE_TTL,
      (value) => {
        if (politicianPath(record(value).url) === actorPath(requested))
          return parsePoliticianProfile(value);
        if (/^\d+$/.test(requested))
          throw notFound('OpenParliament has no politician with the requested identifier.', {
            retryable: false,
          });
        return malformed('politician.identity');
      },
      request,
    );
  }
  /** Read one sponsor page; complete-set scans are composed by the bill tool. */
  listBills(input: BillInput, request: RequestContext): Promise<SourcePage<Bill>> {
    const params: Record<string, string> = {
      ...pageParams(input),
      sponsor_politician: actorPath(input.sponsor),
    };
    if (input.session?.trim()) params.session = sessionToken(input.session);
    return this.page(requestUrl('/bills/', params), parseBill, request);
  }
  /** Fetch full source status wording and verify the requested bill identity. */
  getBill(session: string, billCode: string, request: RequestContext): Promise<SourceResult<Bill>> {
    const normalizedSession = sessionToken(session);
    const code = normalizeBillCode(billCode);
    return this.request(
      requestUrl(`/bills/${normalizedSession}/${code}/`),
      PAGE_TTL,
      (value) => {
        const bill = parseBill(value);
        if (bill.session !== normalizedSession || bill.billCode !== code)
          return malformed('bill.identity');
        return bill;
      },
      request,
    );
  }
  /** List ballots without changing OpenParliament's Yes/No vocabulary. */
  listBallots(
    input: PageInput & { politician: string },
    request: RequestContext,
  ): Promise<SourcePage<Ballot>> {
    const path = actorPath(input.politician);
    return this.page(
      requestUrl('/votes/ballots/', { ...pageParams(input), politician: path }),
      (value) => {
        const ballot = parseBallot(value);
        if (new URL(ballot.politicianUrl).pathname !== path) return malformed('ballot.politician');
        return ballot;
      },
      request,
    );
  }
  /** Fetch one vote's date and subject for bounded member activity hydration. */
  getVote(session: string, number: number, request: RequestContext): Promise<SourceResult<Vote>> {
    const normalizedSession = sessionToken(session);
    if (!Number.isSafeInteger(number) || number <= 0)
      throw validationError('A positive vote number is required.');
    return this.request(
      requestUrl(`/votes/${normalizedSession}/${number}/`),
      PAGE_TTL,
      (value) => {
        const vote = parseVote(value);
        if (vote.session !== normalizedSession || vote.number !== number)
          return malformed('vote.identity');
        return vote;
      },
      request,
    );
  }
  /** Fetch one raw candidate page; bounds and membership hydration belong to tools. */
  listSpeeches(input: SpeechInput, request: RequestContext): Promise<SourcePage<Speech>> {
    validateDateRange(input.dateFrom, input.dateTo);
    const params = pageParams(input);
    if (input.politician?.trim()) params.politician = actorPath(input.politician);
    if (input.billDebated) params.bill_debated = billPath(input.billDebated);
    if (input.mentionedBill) params.mentioned_bill = billPath(input.mentionedBill);
    if (input.dateFrom) params.time__gte = normalizeDate(input.dateFrom);
    if (input.dateTo) {
      const date = new Date(`${normalizeDate(input.dateTo)}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + 1);
      const next = date.toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next))
        throw validationError('Speech date upper bound has no representable following day.');
      params.time__lt = next;
    }
    if (input.substantiveOnly) params.procedural = 'false';
    return this.page(requestUrl('/speeches/', params), parseSpeech, request);
  }
  /** Resolve only the historical membership endpoint, never a returned generic URL. */
  getMembership(path: string, request: RequestContext): Promise<SourceResult<Membership>> {
    const canonical = membershipPath(path);
    return this.request(
      requestUrl(canonical),
      PROFILE_TTL,
      (value) => {
        const membership = parseMembership(value);
        if (new URL(membership.url).pathname !== canonical) return malformed('membership.identity');
        return membership;
      },
      request,
    );
  }
  /** Release cached records and queued process-wide upstream work during teardown. */
  dispose(): void {
    this.cache.clear();
    sharedPacer?.dispose();
    sharedPacer = undefined;
  }
}

let service: OpenParliamentService | undefined;
/** Initialize once from application setup. */
export function initOpenParliamentService(config: ServerConfig = getServerConfig()): void {
  service?.dispose();
  service = new OpenParliamentService(config);
}
/** Access the initialized source service. */
export function getOpenParliamentService(): OpenParliamentService {
  if (!service) throw new Error('OpenParliament service is not initialized.');
  return service;
}
/** Dispose the source service from application teardown. */
export function disposeOpenParliamentService(): void {
  service?.dispose();
  service = undefined;
}
