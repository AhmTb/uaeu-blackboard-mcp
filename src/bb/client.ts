import type { Config } from '../config.js';
import { setTimeout as delay } from 'node:timers/promises';
import { cookieHeaderFor, readState, writeState, type SessionState } from '../state.js';
import path from 'node:path';
import { blackboardHost, fetchResource, type Resource } from './resources.js';

export class BlackboardError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly path: string;

  constructor(message: string, status: number, path: string, body: unknown) {
    super(message);
    this.name = 'BlackboardError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class NotAuthenticatedError extends BlackboardError {
  constructor(path: string, body: unknown) {
    super('Blackboard session is missing or expired. Run `uaeu-blackboard-mcp login` again.', 401, path, body);
    this.name = 'NotAuthenticatedError';
  }
}

export class PermissionError extends BlackboardError {
  constructor(path: string, body: unknown) {
    super('Your Blackboard account is not permitted to perform this action.', 403, path, body);
    this.name = 'PermissionError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Return the Response instead of parsed JSON (file downloads). */
  raw?: boolean;
  /** Accept a non-2xx response instead of throwing. */
  allowStatus?: number[];
  /** Opt-in, bounded in-memory cache. Writes invalidate every cached read. */
  cacheTtlMs?: number;
}

interface PagedResponse<T> {
  results?: T[];
  paging?: { nextPage?: string | null };
}

const RETRYABLE = new Set([429, 502, 503, 504]);

export class BlackboardClient {
  readonly config: Config;
  private state: SessionState;
  private requestCount = 0;
  private lastKeepAlive = 0;
  private cacheEpoch = 0;
  private cacheHits = 0;
  private sharedReads = 0;
  private readonly cache = new Map<string, { expires: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(config: Config, state: SessionState) {
    this.config = config;
    this.state = state;
  }

  get mode(): 'internal' | 'public' | 'oauth' {
    return this.state.apiMode ?? 'internal';
  }

  get user() {
    return this.state.user;
  }

  /** GET a course resource; cookies remain domain/path scoped on every redirect. */
  readResource(url: string, blackboardOnly = false): Promise<Resource> {
    return fetchResource(url, {
      baseUrl: this.config.baseUrl, timeoutMs: this.config.timeoutMs,
      blackboardOnly, cookieFor: target => {
        if (blackboardHost(new URL(target),this.config.baseUrl)) return cookieHeaderFor(this.state,target);
        if (blackboardOnly) return '';
        const linked=readState({...this.config,sessionFile:path.join(this.config.stateDir,'linked-session.json')});
        return linked ? cookieHeaderFor(linked,target) : '';
      },
    });
  }

  /** `/learn/api/v1` for browser sessions, `/learn/api/public/v1` for OAuth. */
  private apiRoot(): string {
    return this.mode === 'public' || this.mode === 'oauth'
      ? '/learn/api/public/v1'
      : '/learn/api/v1';
  }

  /**
   * Blackboard's write protection uses a per-session token that the Ultra client
   * sends as `x-blackboard-xsrf`. It is embedded in the BbRouter cookie value
   * (`...,xsrf:<uuid>,...`), so no extra bootstrap request is needed.
   */
  private xsrfToken(): string | undefined {
    const router = this.state.cookies.find((cookie) => cookie.name === 'BbRouter');
    const match = router?.value.match(/(?:^|,)xsrf:([^,;]+)/);
    return match?.[1];
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const suffix = /^https?:\/\//i.test(path) || path.startsWith('/learn/')
      ? path : `${this.apiRoot()}${path}`;
    const url = new URL(suffix, this.config.baseUrl);
    if (url.origin !== new URL(this.config.baseUrl).origin || !url.pathname.startsWith('/learn/api/')) {
      throw new Error('Blackboard requests and pagination must stay on the configured API origin.');
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.sort();
    return url.href;
  }

  private absorbCookies(response: Response): void {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (!setCookies.length) return;

    let changed = false;
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      if (!pair) continue;
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const existing = this.state.cookies.find((cookie) => cookie.name === name);
      if (existing) {
        if (existing.value !== value) {
          existing.value = value;
          changed = true;
        }
      } else {
        this.state.cookies.push({
          name,
          value,
          domain: new URL(this.config.baseUrl).hostname,
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        });
        changed = true;
      }
    }

    if (changed) {
      this.state.updatedAt = new Date().toISOString();
      try {
        writeState(this.config, this.state);
      } catch {
        // A read-only home directory must not break API calls.
      }
    }
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const url = this.url(path, options.query);
    if (method !== 'GET') {
      this.invalidateReads();
      try {
        return await this.execute<T>(path, url, options);
      } finally {
        // Also invalidate reads started while a write was in progress.
        this.invalidateReads();
      }
    }
    if (options.raw || options.allowStatus || options.body !== undefined || options.form) {
      return this.execute<T>(path, url, options);
    }
    const epoch = this.cacheEpoch;
    const key = JSON.stringify([epoch, url, options.timeoutMs ?? this.config.timeoutMs,
      Object.entries(options.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
    const ttl = options.cacheTtlMs ?? 0;
    const cached = this.cache.get(key);
    if (ttl > 0 && cached && cached.expires > Date.now()) {
      this.cacheHits += 1;
      return structuredClone(cached.value) as T;
    }
    if (cached) this.cache.delete(key);
    let pending = this.inFlight.get(key);
    if (pending) {
      this.sharedReads += 1;
    } else {
      pending = this.execute<T>(path, url, options);
      this.inFlight.set(key, pending);
    }
    try {
      const value = await pending;
      if (ttl > 0 && epoch === this.cacheEpoch) {
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expires: Date.now() + ttl, value });
      }
      return structuredClone(value) as T;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  private invalidateReads(): void {
    this.cacheEpoch += 1;
    this.cache.clear();
  }

  private async execute<T>(path: string, url: string, options: RequestOptions): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      accept: 'application/json, */*;q=0.8',
      cookie: cookieHeaderFor(this.state, url),
      'user-agent': 'uaeu-blackboard-mcp/0.1 (+https://github.com/)',
      ...options.headers,
    };

    let body: string | FormData | undefined;
    if (options.form) {
      body = options.form;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    // A lost response does not mean a submission/message failed on Blackboard.
    const attempts = method === 'GET' ? 3 : 1;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        headers.cookie = cookieHeaderFor(this.state, url);
        if (method !== 'GET') {
          const xsrf = this.xsrfToken();
          if (xsrf) headers['x-blackboard-xsrf'] = xsrf;
        }
        this.requestCount += 1;
        const response = await fetch(url, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal,
        });

        this.absorbCookies(response);

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new NotAuthenticatedError(path, { location: response.headers.get('location') });
        }

        if (options.allowStatus?.includes(response.status)) {
          return options.raw ? response as T : (await this.parse(response, path)) as T;
        }

        if (response.status === 401) {
          throw new NotAuthenticatedError(path, await this.safeBody(response));
        }
        if (response.status === 403) {
          throw new PermissionError(path, await this.safeBody(response));
        }
        if (response.status === 404) {
          throw new BlackboardError(`Not found: ${path}`, 404, path, await this.safeBody(response));
        }
        if (!response.ok) {
          const retryHeader = response.headers.get('retry-after');
          const seconds = retryHeader === null ? NaN : Number(retryHeader);
          const retryAfter = retryHeader === null ? NaN
            : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryHeader) - Date.now();
          const backoff = Number.isFinite(retryAfter)
            ? Math.max(0, retryAfter) : 250 * 2 ** attempt + Math.random() * 100;
          if (RETRYABLE.has(response.status) && attempt < attempts - 1) {
            if (backoff < deadline - Date.now()) {
              await response.body?.cancel();
              await delay(backoff, undefined, { signal });
              continue;
            }
          }
          throw new BlackboardError(
            `Blackboard returned HTTP ${response.status} for ${method} ${path}`,
            response.status,
            path,
            await this.safeBody(response),
          );
        }

        if (options.raw) return response as T;
        return (await this.parse(response, path)) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof BlackboardError) {
          if (error.status === 401 || error.status === 403) this.invalidateReads();
          throw error;
        }
        if (signal.aborted) break;
        if (attempt < attempts - 1) {
          try {
            await delay(250 * 2 ** attempt + Math.random() * 100, undefined, { signal });
          } catch { break; }
          continue;
        }
      }
    }

    const reason = signal.aborted ? `timed out after ${timeoutMs}ms`
      : lastError instanceof Error ? lastError.message : 'connection failed';
    throw new BlackboardError(
      `${method} ${path}: ${reason}.${method === 'GET' ? ''
        : ' Write outcome is unknown; check Blackboard before retrying. This write was not retried.'}`,
      0, path, undefined,
    );
  }

  private async parse(response: Response, path: string): Promise<unknown> {
    if (response.status === 204) return undefined;
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (!text) return undefined;
    if (contentType.includes('json')) {
      try {
        return JSON.parse(text);
      } catch {
        throw new BlackboardError('Blackboard returned invalid JSON. Retry the read or check the server response.',
          response.status, path, undefined);
      }
    }
    if (contentType.includes('text/html') || /^\s*(?:<!doctype html|<html)/i.test(text)) {
      throw new NotAuthenticatedError(path, undefined);
    }
    return text;
  }

  private async safeBody(response: Response): Promise<unknown> {
    try {
      const text = await response.text();
      if (!text) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return text.slice(0, 1000);
      }
    } catch {
      return undefined;
    }
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  put<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PUT', body });
  }

  delete<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  /** Follow `paging.nextPage` until exhausted. */
  async getAll<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T[]> {
    const results: T[] = [];
    let next: string | undefined = path;
    let pages = 0;
    const seen = new Set<string>();

    while (next) {
      if (pages >= 100) throw new Error('Blackboard pagination exceeded 100 pages; narrow the query.');
      const pageOptions = pages === 0
        ? { ...options, query: { limit: this.config.pageSize, ...options.query } }
        : { ...options, query: undefined };
      const pageUrl = this.url(next, pageOptions.query);
      if (seen.has(pageUrl)) throw new Error('Blackboard pagination repeated a page; results would be incomplete.');
      seen.add(pageUrl);
      const page = await this.get<PagedResponse<T> | T[]>(pageUrl, pageOptions);
      if (Array.isArray(page)) {
        results.push(...page);
        break;
      }
      if (!page || !Array.isArray(page.results)) {
        throw new Error('Blackboard returned an invalid list response; results would be incomplete.');
      }
      results.push(...page.results);
      next = page.paging?.nextPage ?? undefined;
      pages += 1;
      if (!page.paging?.nextPage) break;
    }

    return results;
  }

  /**
   * Reset Blackboard's inactivity timer. Cheap, and keeps a working session alive
   * while the MCP server sits idle between prompts.
   */
  async keepAlive(): Promise<void> {
    if (this.mode !== 'internal') return;
    if (Date.now() - this.lastKeepAlive < 4 * 60 * 1000) return;
    this.lastKeepAlive = Date.now();
    try {
      await this.get('/utilities/keepBbSessionActive');
    } catch {
      // Keep-alive is best-effort; a real request will surface auth failures.
    }
  }

  stats(): { mode: string; requests: number; cookieCount: number; cacheHits: number; sharedReads: number } {
    return {
      mode: this.mode,
      requests: this.requestCount,
      cookieCount: this.state.cookies.length,
      cacheHits: this.cacheHits,
      sharedReads: this.sharedReads,
    };
  }
}
