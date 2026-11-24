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
import {
  createPacer,
  fetchWithTimeout,
  type RetryAttempt,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
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
import { type BillTextRequest, exportLinkScanner, parseBillText } from './bill-text.js';
import {
  billIdentity,
  invalidResponse,
  parseBillDossier,
  parseBillRecords,
  parseBillSummary,
  parseCurrentSession,
  parseSessions,
} from './parsing.js';
import type {
  BillDossier,
  BillSummary,
  BillText,
  BillTextDocument,
  BillTextLanguage,
  LegisinfoSession,
} from './types.js';

const ORIGIN = 'https://www.parl.ca';
const FIVE_MINUTES = 300_000;
const FIFTEEN_MINUTES = 900_000;
/**
 * Ceiling on the heap bytes cached bill texts retain, as `retainedBytes` estimates them. Cached
 * 45-1 C-15 and 42-1 C-86, the largest texts sampled (estimates 2.2 and 2.9 MiB), measure 1.10 to
 * 1.15 times their estimate on Bun 1.4 and Node 26, a smaller text up to 1.27 times, so a full cache
 * holds about ten texts of C-86's size and retains at most about 41 MiB. A document larger than the
 * whole ceiling is served uncached.
 */
const BILL_TEXT_CACHE_BYTES = 32 * 1024 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
const UNKNOWN_SESSION = { reason: 'unknown_session', retryable: false };
interface CacheEntry {
  data: unknown;
  expiresAt: number;
  source: Source;
}
/** A located bill version, with its parsed text when that fits the cache ceiling. */
interface BillTextEntry {
  bytes: number;
  document: BillTextDocument | null;
  expiresAt: number;
  /** The DocumentViewer page, then the XML when `document` is cached. */
  sources: Source[];
  xmlUrl: string;
}
/** One manual-redirect request: the 2xx response, the redirect it names, or a 404. */
type Hop =
  | { kind: 'ok'; response: Response }
  | { kind: 'redirect'; location: URL }
  | { kind: 'missing'; error: McpError };
/** Canonical session token, or a field-named `unknown_session` rejection naming the expected shape. */
function sessionToken(value: Exclude<SessionInput, undefined>): string {
  try {
    return normalizeFilter('session', value, (session) => normalizeSession(session));
  } catch (error) {
    const [message, data, options] = filterFailure(error);
    throw validationError(message, { ...UNKNOWN_SESSION, ...data }, options);
  }
}
/** Canonical bill code, or a field-named `invalid_bill_code` rejection naming the expected shape. */
function billCodeToken(value: string): string {
  try {
    return normalizeFilter('billCode', value, normalizeBillCode);
  } catch (error) {
    const [message, data, options] = filterFailure(error);
    throw validationError(
      message,
      { reason: 'invalid_bill_code', retryable: false, ...data },
      options,
    );
  }
}
function unsupportedRedirect(): McpError {
  return serviceUnavailable('LEGISinfo returned an unsupported redirect.', {
    reason: 'upstream_response_invalid',
    retryable: false,
  });
}
function billNotFound(): McpError {
  return notFound('The official bill dossier was not found.', {
    reason: 'bill_not_found',
    retryable: false,
  });
}
function textUnavailable(message: string): never {
  throw notFound(message, { reason: 'bill_text_unavailable', retryable: false });
}
function noViewerPage(): never {
  return textUnavailable('The official document viewer has no page for this publication.');
}
/** `www.parl.ca`'s error page, optionally only the one carrying `StatusCode` (null: none). */
function isErrorPage(url: URL, statusCodes?: (string | null)[]): boolean {
  return (
    url.origin === ORIGIN &&
    /^\/ErrorPage\//i.test(url.pathname) &&
    (statusCodes === undefined || statusCodes.includes(url.searchParams.get('StatusCode')))
  );
}
const SLUG = /^[a-z][a-z0-9-]*$/i;
/**
 * Accept the DocumentViewer's one redirect only to the requested session and bill's page under
 * `/documentviewer/{language}/`: `/documentviewer/en/45-1/bill/S-2/first-reading`. A redirect to
 * the viewer's error page (no status, or 404) means no page for that publication.
 */
function viewerPage(location: URL, expected: BillTextRequest): URL {
  if (isErrorPage(location, [null, '404'])) noViewerPage();
  const [root, language, session, kind, code, stage, ...rest] = location.pathname
    .split('/')
    .slice(1);
  if (
    location.origin !== ORIGIN ||
    location.username ||
    location.password ||
    location.search ||
    location.hash ||
    root?.toLowerCase() !== 'documentviewer' ||
    language !== expected.language ||
    session !== expected.session ||
    code?.toUpperCase() !== expected.billCode ||
    !SLUG.test(kind ?? '') ||
    !SLUG.test(stage ?? '') ||
    rest.length
  )
    throw unsupportedRedirect();
  return location;
}
/**
 * Resolve a page's XML export `href` to a same-origin `/Content/Bills/…_E.xml` (`_F.xml` for
 * French). No link, or a table-of-contents cover (`…-TOC-e.xml`), means the version has no
 * text export; any other target is an invalid page.
 */
function exportXmlUrl(href: string | null, page: URL, language: BillTextLanguage): string {
  if (href === null) return textUnavailable('The publication has no XML export of its text.');
  let target: URL;
  try {
    target = new URL(href, page);
  } catch {
    return invalidResponse();
  }
  if (
    target.origin !== ORIGIN ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !target.pathname.startsWith('/Content/Bills/')
  )
    return invalidResponse();
  if (/-TOC-[ef]\.xml$/i.test(target.pathname))
    textUnavailable(
      "The publication's XML export is a table-of-contents cover, not the bill text.",
    );
  if (!target.pathname.endsWith(language === 'en' ? '_E.xml' : '_F.xml')) invalidResponse();
  return target.href;
}
/**
 * Read a page only until its XML export link is decided, then cancel the rest of the body. Every
 * DocumentViewer page decides before it ends (PDF-only and table-of-contents versions reach the
 * publication content), so a page that ends undecided is a maintenance or challenge page or a body
 * cut short: a transient failure, never a version without text.
 */
async function readExportLink(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  const scan = exportLinkScanner();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      const link = scan(decoder.decode());
      if (link === undefined)
        throw serviceUnavailable(
          'LEGISinfo returned a page that ends before its publication content.',
        );
      return link;
    }
    let link: string | null | undefined;
    try {
      link = scan(decoder.decode(value, { stream: true }));
    } catch (error) {
      // A page the scanner rejects is decided as well.
      await reader.cancel();
      throw error;
    }
    if (link !== undefined) {
      await reader.cancel();
      return link;
    }
  }
}
/** Bytes per character of a flat string: two once any character is outside Latin-1. */
function charBytes(value: string): number {
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) > 0xff) return 2;
  return 1;
}
/**
 * Estimated heap bytes a JSON-shaped value retains once its strings are flat copies: a string's
 * header plus its characters; an object's or array's header plus one slot per entry. Cached bill
 * texts measure 1.08 to 1.27 times this estimate on Bun 1.4 and Node 26.
 */
function retainedBytes(value: unknown): number {
  if (typeof value === 'string') return 24 + value.length * charBytes(value);
  if (value === null || typeof value !== 'object') return 8;
  const entries = Array.isArray(value) ? value : Object.values(value);
  let total = 32;
  for (const entry of entries) total += 8 + retainedBytes(entry);
  return total;
}
/**
 * Located bill texts under a ceiling on the heap bytes they retain, as `retainedBytes` estimates
 * them; least recently used evicted first, expired entries pruned on insert. A text larger than the
 * whole ceiling keeps only its location. The stored copy is a structured clone: on Bun a parsed
 * text's strings keep the whole XML body alive (a parsed 42-1 C-86 retains 7.9 MiB, its clone
 * 3.4 MiB).
 */
export class BillTextCache {
  /** Least recently used first. */
  private readonly entries = new Map<string, BillTextEntry>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** An unexpired entry, marked most recently used. */
  get(key: string): BillTextEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) {
      this.bytes -= entry.bytes;
      return undefined;
    }
    this.entries.set(key, entry);
    return entry;
  }

  /** Store a located text until `expiresAt`, replacing any entry under `key`. */
  set(
    key: string,
    located: {
      document: BillTextDocument;
      expiresAt: number;
      page: Source;
      xml: Source;
      xmlUrl: string;
    },
  ): void {
    const now = Date.now();
    for (const [stale, entry] of this.entries)
      if (stale === key || entry.expiresAt <= now) {
        this.entries.delete(stale);
        this.bytes -= entry.bytes;
      }
    const { document, expiresAt, page, xml, xmlUrl } = located;
    const fits = retainedBytes(document) <= this.maxBytes;
    const entry: Omit<BillTextEntry, 'bytes'> = {
      document: fits ? structuredClone(document) : null,
      expiresAt,
      sources: fits ? [{ ...page }, { ...xml }] : [{ ...page }],
      xmlUrl,
    };
    const bytes = retainedBytes(entry);
    for (const [oldest, evicted] of this.entries) {
      if (this.bytes + bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= evicted.bytes;
    }
    this.entries.set(key, { ...entry, bytes });
    this.bytes += bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
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
  private readonly billTexts: BillTextCache;
  private readonly config: ServerConfig;
  private verifiedCurrent: string | undefined;
  private currentSource: Source | undefined;

  constructor(
    config: ServerConfig = getServerConfig(),
    billTexts = new BillTextCache(BILL_TEXT_CACHE_BYTES),
  ) {
    this.config = config;
    this.billTexts = billTexts;
  }

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
    const code = billCodeToken(billCode);
    const verified = await this.verifySession(session, request);
    const result = await this.load(
      `/legisinfo/en/bill/${verified.data}/${code.toLowerCase()}/json`,
      FIVE_MINUTES,
      (body) => parseBillDossier(parseBillRecords(body), verified.data, code, verified.index),
      request,
      true,
    );
    return { data: result.data, provenance: [...verified.provenance, ...result.provenance] };
  }

  /**
   * Read one publication's text from its official XML. The caller has verified the session and
   * that `publicationId` is one of the bill's publications. The DocumentViewer request is built
   * from the ID; its page is read only until its XML export link, which must be a same-origin
   * `/Content/Bills/…_E.xml` (`_F.xml` for French); the XML must be complete and name the
   * requested language, bill, and session. Parsed texts are cached 15 minutes under a retained-byte
   * ceiling, keyed by session, bill, publication, and language; a text larger than the ceiling is
   * served uncached, its XML location still cached. Throws NotFound `bill_text_unavailable` when
   * the version has no text export, `upstream_response_invalid` on an identity mismatch or an
   * unexpected page or redirect, and `upstream_blocked` on a 403.
   */
  async getBillText(
    session: string,
    billCode: string,
    publicationId: number,
    language: BillTextLanguage,
    request: RequestContext,
  ): Promise<SourceResult<BillText>> {
    const expected = {
      session: sessionToken(session),
      billCode: billCodeToken(billCode),
      language,
    };
    request.throwIfAborted();
    const url = `${ORIGIN}/DocumentViewer/${language}/${publicationId}`;
    const key = `${expected.session}/${expected.billCode}/${publicationId}/${language}`;
    const cached = this.billTexts.get(key);
    if (cached?.document)
      return {
        data: { ...structuredClone(cached.document), publicationId, url, xmlUrl: cached.xmlUrl },
        provenance: cached.sources.map((source) => ({ ...source, cached: true })),
      };
    const located = cached
      ? { xmlUrl: cached.xmlUrl, source: cached.sources[0] as Source }
      : await this.locateBillXml(url, expected, request);
    const read = await this.readBillXml(located.xmlUrl, expected, request);
    request.throwIfAborted();
    this.billTexts.set(key, {
      xmlUrl: located.xmlUrl,
      page: located.source,
      xml: read.source,
      document: read.data,
      expiresAt: cached?.expiresAt ?? Date.now() + FIFTEEN_MINUTES,
    });
    return {
      data: { ...read.data, publicationId, url, xmlUrl: located.xmlUrl },
      provenance: [{ ...located.source, cached: cached !== undefined }, read.source],
    };
  }

  /** The XML export a DocumentViewer page links: one redirect, then the page head only. */
  private async locateBillXml(
    url: string,
    expected: BillTextRequest,
    request: RequestContext,
  ): Promise<{ xmlUrl: string; source: Source }> {
    return await this.retrying(request, 'legisinfo.bill_text_page', (attempt) =>
      this.pacer.run(
        async () => {
          request.throwIfAborted();
          const deadlineAt = Date.now() + Math.min(10_000, attempt.remainingMs);
          let page = new URL(url);
          let result = await this.hop(page, deadlineAt, attempt.signal, request, 'text/html');
          if (result.kind === 'redirect') {
            page = viewerPage(result.location, expected);
            result = await this.hop(page, deadlineAt, attempt.signal, request, 'text/html');
            if (result.kind === 'redirect') {
              if (isErrorPage(result.location, [null, '404'])) noViewerPage();
              throw unsupportedRedirect();
            }
          }
          if (result.kind === 'missing') noViewerPage();
          const href = await readExportLink(result.response);
          request.throwIfAborted();
          return {
            xmlUrl: exportXmlUrl(href, page, expected.language),
            source: {
              source: 'legisinfo' as const,
              url,
              retrievedAt: new Date().toISOString(),
              cached: false,
            },
          };
        },
        { signal: attempt.signal },
      ),
    );
  }

  /** Fetch and convert one bill XML; a body cut short is retried, never returned. */
  private async readBillXml(
    xmlUrl: string,
    expected: BillTextRequest,
    request: RequestContext,
  ): Promise<{ data: BillTextDocument; source: Source }> {
    return await this.retrying(request, 'legisinfo.bill_text_xml', async (attempt) => {
      const body = await this.pacer.run(
        async () => {
          request.throwIfAborted();
          const result = await this.hop(
            new URL(xmlUrl),
            Date.now() + Math.min(10_000, attempt.remainingMs),
            attempt.signal,
            request,
            'application/xml, text/xml',
          );
          if (
            result.kind === 'missing' ||
            (result.kind === 'redirect' && isErrorPage(result.location, ['404']))
          )
            textUnavailable("The publication's XML text was not found.");
          if (result.kind === 'redirect') throw unsupportedRedirect();
          return await result.response.text();
        },
        { signal: attempt.signal },
      );
      request.throwIfAborted();
      const data = parseBillText(body, expected);
      request.throwIfAborted();
      return {
        data,
        source: {
          source: 'legisinfo' as const,
          url: xmlUrl,
          retrievedAt: new Date().toISOString(),
          cached: false,
        },
      };
    });
  }

  /** The canonical session token, verified against the official session index it returns. */
  private async verifySession(
    session: string,
    request: RequestContext,
  ): Promise<SourceResult<string> & { index: LegisinfoSession[] }> {
    const token = sessionToken(session);
    const sessions = await this.getSessions(request);
    if (!sessions.data.some((entry) => entry.session === token))
      throw rejectSession(
        'session',
        'official bill',
        sessions.data.map((entry) => entry.session),
        UNKNOWN_SESSION,
      );
    return { data: token, provenance: sessions.provenance, index: sessions.data };
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
    const result = await this.retrying(request, 'legisinfo.fetch', (attempt) =>
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
    );
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
  }

  /**
   * One operation under the caller's budget: retried twice on transient failures within
   * `min(20 s, remaining)`; caller cancellation and the call deadline always win.
   */
  private async retrying<T>(
    request: RequestContext,
    operation: string,
    run: (attempt: RetryAttempt) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await withRetry(run, {
        operation,
        context: request.context,
        signal: request.signal,
        deadlineMs: Math.min(20_000, request.remainingMs()),
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
      });
      request.throwIfAborted();
      return result;
    } catch (error) {
      request.throwIfAborted();
      throw error;
    }
  }

  /** Request `target` without following redirects; a 403 is a non-retryable source refusal. */
  private async hop(
    target: URL,
    deadlineAt: number,
    signal: AbortSignal,
    request: RequestContext,
    accept: string,
  ): Promise<Hop> {
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
          expectedStatuses: [...REDIRECTS, 404],
          headers: { 'User-Agent': this.config.userAgent, Accept: accept },
        },
      );
      return { kind: 'ok', response };
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
      if (status === 404) return { kind: 'missing', error };
      if (typeof status !== 'number' || !REDIRECTS.includes(status)) throw error;
      const headers = error.data?.headers;
      const location =
        typeof headers === 'object' && headers !== null && 'location' in headers
          ? headers.location
          : undefined;
      if (typeof location !== 'string') throw unsupportedRedirect();
      try {
        return { kind: 'redirect', location: new URL(location, target) };
      } catch {
        return invalidResponse();
      }
    }
  }

  /** Read a feed or page, following only same-origin canonical redirects (at most three). */
  private async fetchText(
    initial: string,
    deadlineAt: number,
    signal: AbortSignal,
    request: RequestContext,
    billDetail: boolean,
  ): Promise<string> {
    let target = new URL(initial);
    for (let hop = 0; hop <= 3; hop++) {
      const accept = target.pathname.endsWith('/json') ? 'application/json' : 'text/html';
      const result = await this.hop(target, deadlineAt, signal, request, accept);
      if (result.kind === 'ok') {
        try {
          return await result.response.text();
        } catch (error) {
          request.throwIfAborted();
          throw error;
        }
      }
      if (result.kind === 'missing') throw billDetail ? billNotFound() : result.error;
      const next = result.location;
      if (billDetail && isErrorPage(next, ['404'])) throw billNotFound();
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
        throw unsupportedRedirect();
      target = next;
    }
    return invalidResponse();
  }

  /** Release queued work and local caches at application teardown. */
  dispose(): void {
    this.pacer.dispose();
    this.cache.clear();
    this.billTexts.clear();
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
