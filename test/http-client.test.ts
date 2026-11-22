import { describe, expect, it } from 'vitest';
import { ApiClient, type FetchLike } from '../src/http/client';
import { isRecord } from '../src/json';
import { CLI_VERSION } from '../src/version';
import { TEST_KEY, jsonResponse } from './helpers';

interface Captured {
  url: string;
  init: RequestInit;
}

function client(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  extra: { apiKey?: string; timeoutMs?: number } = {},
) {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { api: new ApiClient({ baseUrl: 'https://api.example.tr', fetch: fetchImpl, ...extra }), calls };
}

const parseEmail = (value: unknown): { email: string } => {
  if (isRecord(value) && typeof value.email === 'string') return { email: value.email };
  throw new Error('bad shape');
};

describe('ApiClient', () => {
  it('sends User-Agent hadronbox-cli/<ver> (<os>), Bearer key, JSON accept; unwraps the envelope', async () => {
    const { api, calls } = client(
      () => jsonResponse(200, { data: { email: 'sen@ornek.com' }, meta: { timestamp: 'x' } }),
      {
        apiKey: TEST_KEY,
      },
    );
    await expect(api.get('/me', parseEmail)).resolves.toEqual({ email: 'sen@ornek.com' });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe('https://api.example.tr/me');
    expect(headers['user-agent']).toBe(`hadronbox-cli/${CLI_VERSION} (${process.platform})`);
    expect(headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(headers.accept).toBe('application/json');
    expect(calls[0]?.init.redirect).toBe('manual');
  });

  it('omits Authorization without a key; encodes query and JSON body', async () => {
    const { api, calls } = client(() => jsonResponse(201, { data: { email: 'a@b.c' } }));
    await api.post('/x', parseEmail, { body: { name: 'web' }, query: { page: 2, search: 'a b', skip: undefined } });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]?.init.body).toBe('{"name":"web"}');
    expect(calls[0]?.url).toBe('https://api.example.tr/x?page=2&search=a+b');
  });

  it('parses paginated lists', async () => {
    const { api } = client(() =>
      jsonResponse(200, {
        data: [{ email: 'a@b.c' }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        quota: { used: 1, limit: 2 },
        meta: {},
      }),
    );
    await expect(api.requestPage('/list', parseEmail)).resolves.toEqual({
      data: [{ email: 'a@b.c' }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      extra: { quota: { used: 1, limit: 2 } },
    });
  });

  it('maps API error bodies', async () => {
    const { api } = client(() =>
      jsonResponse(402, { statusCode: 402, error: 'Payment Required', code: 'PLAN_LIMIT_MACHINES', message: 'limit' }),
    );
    await expect(api.get('/me', parseEmail)).rejects.toMatchObject({ code: 'PLAN_LIMIT_MACHINES', exitCode: 5 });
  });

  it('passes Retry-After through on 429 and does not retry', async () => {
    const { api, calls } = client(() =>
      jsonResponse(429, { statusCode: 429, message: 'slow down' }, { 'retry-after': '7' }),
    );
    await expect(api.get('/me', parseEmail)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      exitCode: 7,
      details: { retryAfterSeconds: 7 },
    });
    expect(calls).toHaveLength(1);
  });

  it('does not follow redirects', async () => {
    const { api } = client(() => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }));
    await expect(api.get('/me', parseEmail)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE', exitCode: 1 });
  });

  it('wrong success shape or non-JSON success → UNEXPECTED_RESPONSE', async () => {
    await expect(
      client(() => jsonResponse(200, { data: { nope: 1 } })).api.get('/me', parseEmail),
    ).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
    await expect(
      client(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })).api.get(
        '/me',
        parseEmail,
      ),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('network failure → NETWORK_ERROR (7) with host and cause code', async () => {
    const { api } = client(() => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    });
    const error = await api.get('/me', parseEmail).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', exitCode: 7, details: { cause: 'ECONNREFUSED' } });
    expect((error as Error).message).toContain('api.example.tr');
  });

  it('timeout → TIMEOUT (7)', async () => {
    const { api } = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      { timeoutMs: 20 },
    );
    await expect(api.get('/me', parseEmail)).rejects.toMatchObject({ code: 'TIMEOUT', exitCode: 7 });
  });

  it('caller abort → INTERRUPTED (130)', async () => {
    const controller = new AbortController();
    const { api } = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = api.get('/me', parseEmail, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'INTERRUPTED', exitCode: 130 });
  });

  it('debug lines never contain the key', async () => {
    const lines: string[] = [];
    const api = new ApiClient({
      baseUrl: 'https://api.example.tr',
      apiKey: TEST_KEY,
      fetch: async () => jsonResponse(200, { data: { email: 'a@b.c' } }),
      onDebug: (line) => lines.push(line),
    });
    await api.get('/me', parseEmail);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('hb_live_');
  });
});
