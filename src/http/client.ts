import { CliError, cliError } from '../errors/cli-error';
import { mapApiError } from '../errors/api-error-map';
import { isRecord, type JsonValue } from '../json';
import { USER_AGENT } from '../version';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | undefined;

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Upper bound for a buffered JSON response; the panel API never sends more (lists are paginated). */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Builds an API path with every interpolated value encoded as one path segment:
 * apiPath`/sandboxes/${name}/exec`. Empty, "." and ".." values are rejected (INVALID_PATH_SEGMENT, exit 2), so a
 * machine name like `../api-keys` can never retarget a request (with the user's key) to another endpoint.
 */
export function apiPath(strings: TemplateStringsArray, ...values: readonly (string | number)[]): string {
  let result = strings[0] ?? '';
  values.forEach((value, index) => {
    const text = String(value);
    if (text === '' || text === '.' || text === '..') {
      throw cliError('INVALID_PATH_SEGMENT', { value: text });
    }
    result += encodeURIComponent(text) + (strings[index + 1] ?? '');
  });
  return result;
}

function hasDotSegment(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  return pathname.split('/').some((segment) => {
    const decoded = segment.replace(/%2e/gi, '.');
    return decoded === '.' || decoded === '..';
  });
}

export interface ApiClientOptions {
  /** Normalized base URL (config.normalizeApiUrl). */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
  readonly userAgent?: string;
  /** Debug sink: method, path, status and duration only — never headers or bodies. */
  readonly onDebug?: (line: string) => void;
}

export interface RequestOptions {
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: JsonValue;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface Pagination {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly pagination: Pagination;
  /** Top-level siblings of data/pagination (e.g. `quota` on GET /sandboxes), unvalidated. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Validates/narrows an unknown JSON value; throw (any Error) when the shape is wrong. */
export type Parser<T> = (value: unknown) => T;

export interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

function isPagination(value: unknown): value is Pagination {
  return (
    isRecord(value) &&
    typeof value.page === 'number' &&
    typeof value.limit === 'number' &&
    typeof value.total === 'number' &&
    typeof value.totalPages === 'number'
  );
}

function networkCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') return cause.code;
  return undefined;
}

/** Reads the body as UTF-8 and aborts once it exceeds `limit` bytes (RESPONSE_TOO_LARGE). */
async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  const tooLarge = () => cliError('RESPONSE_TOO_LARGE', { limit: Math.round(limit / (1024 * 1024)) });
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Thin panel API client on the global `fetch` (Node ≥ 20, no dependency):
 * - per-request timeout (default 30 s) → TIMEOUT (exit 7); caller abort → INTERRUPTED (exit 130),
 * - no retries by default (commands that are safe to repeat opt in explicitly later, e.g. for 429),
 * - redirects are not followed (the API key must never be replayed to another origin) → UNEXPECTED_RESPONSE,
 * - success envelope `{ data, meta }` / `{ data, pagination, meta }` is unwrapped,
 * - error bodies `{ statusCode, error, code, message }` are mapped by mapApiError.
 */
export class ApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? USER_AGENT;
  }

  get hasApiKey(): boolean {
    return this.options.apiKey !== undefined;
  }

  url(path: string, query?: Readonly<Record<string, QueryValue>>): string {
    if (!path.startsWith('/')) throw new Error(`API path must start with "/": ${path}`);
    if (hasDotSegment(path)) throw new Error(`API path must not contain "." or ".." segments: ${path}`);
    const url = new URL(`${this.options.baseUrl}${path}`);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** `data` of the success envelope, validated by `parse`. */
  async request<T>(method: HttpMethod, path: string, parse: Parser<T>, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, path, options);
    const data = isRecord(response.body) && 'data' in response.body ? response.body.data : response.body;
    return this.parseOrThrow(parse, data, response.status);
  }

  /** A paginated list (`{ data: [...], pagination }`), each item validated by `parseItem`. */
  async requestPage<T>(path: string, parseItem: Parser<T>, options: RequestOptions = {}): Promise<Page<T>> {
    const response = await this.send('GET', path, options);
    const body = response.body;
    if (!isRecord(body) || !Array.isArray(body.data) || !isPagination(body.pagination)) {
      throw cliError('UNEXPECTED_RESPONSE', { status: response.status });
    }
    const items = body.data;
    const data = items.map((item) => this.parseOrThrow(parseItem, item, response.status));
    const { data: _data, pagination: _pagination, meta: _meta, ...extra } = body;
    return { data, pagination: body.pagination, extra };
  }

  get<T>(path: string, parse: Parser<T>, options?: RequestOptions): Promise<T> {
    return this.request('GET', path, parse, options);
  }

  post<T>(path: string, parse: Parser<T>, options?: RequestOptions): Promise<T> {
    return this.request('POST', path, parse, options);
  }

  delete<T>(path: string, parse: Parser<T>, options?: RequestOptions): Promise<T> {
    return this.request('DELETE', path, parse, options);
  }

  /** Low-level call: returns status + parsed JSON body for 2xx, throws a mapped CliError otherwise. */
  async send(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<RawResponse> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
    };
    if (this.options.apiKey !== undefined) headers.authorization = `Bearer ${this.options.apiKey}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });

    const started = Date.now();
    this.options.onDebug?.(`→ ${method} ${path}`);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
      } catch (error) {
        throw this.transportError(error, timedOut, timeoutMs, url);
      }
      let text: string;
      try {
        text = await readBounded(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        throw this.transportError(error, timedOut, timeoutMs, url);
      }
      this.options.onDebug?.(`← ${response.status} ${method} ${path} (${Date.now() - started} ms)`);

      const parsed = this.parseJson(text, response.headers.get('content-type'));
      if (response.status >= 200 && response.status < 300) {
        if (parsed === undefined && text.trim() !== '') {
          throw cliError('UNEXPECTED_RESPONSE', { status: response.status });
        }
        return { status: response.status, headers: response.headers, body: parsed ?? null };
      }
      if (response.status >= 300 && response.status < 400) {
        throw cliError('UNEXPECTED_RESPONSE', { status: response.status });
      }
      throw mapApiError({ status: response.status, body: parsed, retryAfter: response.headers.get('retry-after') });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private parseJson(text: string, contentType: string | null): unknown {
    if (text.trim() === '') return undefined;
    const looksJson = contentType === null || /\bjson\b/i.test(contentType);
    if (!looksJson) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  private parseOrThrow<T>(parse: Parser<T>, value: unknown, status: number): T {
    try {
      return parse(value);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw cliError('UNEXPECTED_RESPONSE', { status }, { cause: error });
    }
  }

  private transportError(error: unknown, timedOut: boolean, timeoutMs: number, url: string): CliError {
    if (error instanceof CliError) return error;
    if (timedOut) {
      return cliError('TIMEOUT', { seconds: Math.round(timeoutMs / 1000) }, { cause: error });
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return cliError('INTERRUPTED', undefined, { cause: error });
    }
    const code = networkCode(error);
    return cliError(
      'NETWORK_ERROR',
      { host: new URL(url).host },
      code === undefined ? { cause: error } : { cause: error, details: { cause: code } },
    );
  }
}
