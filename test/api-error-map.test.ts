import { describe, expect, it } from 'vitest';
import { exitCodeForStatus, mapApiError, parseApiErrorBody, parseRetryAfter } from '../src/errors/api-error-map';
import { ExitCode } from '../src/errors/exit-codes';
import { TEST_KEY } from './helpers';

const body = (statusCode: number, code: string, message = 'server says') => ({
  statusCode,
  error: 'Err',
  code,
  message,
});

describe('mapApiError', () => {
  it.each([
    [400, 'VALIDATION', ExitCode.USAGE],
    [401, 'INVALID_API_KEY', ExitCode.AUTH],
    [403, 'SESSION_REQUIRED', ExitCode.AUTH],
    [403, 'EMAIL_NOT_VERIFIED', ExitCode.AUTH],
    [403, 'FORBIDDEN_ROLE', ExitCode.AUTH],
    [402, 'PLAN_LIMIT_MACHINES', ExitCode.PLAN_LIMIT],
    [402, 'PLAN_UPGRADE_REQUIRED', ExitCode.PLAN_LIMIT],
    [404, 'SANDBOX_NOT_FOUND', ExitCode.NOT_FOUND],
    [409, 'INVALID_STATE', ExitCode.INVALID_STATE],
    [409, 'NAME_TAKEN', ExitCode.INVALID_STATE],
  ])('%i %s → exit %i, code kept', (status, code, exit) => {
    const error = mapApiError({ status, body: body(status, code) });
    expect(error.code).toBe(code);
    expect(error.exitCode).toBe(exit);
    expect(error.httpStatus).toBe(status);
    expect(error.details).toMatchObject({ httpStatus: status, apiCode: code });
  });

  it('uses CLI copy, not the server message, for known codes (tr default + en)', () => {
    const error = mapApiError({ status: 402, body: body(402, 'PLAN_LIMIT_MACHINES', 'Machine limit reached') });
    expect(error.messageIn('tr')).toBe('Makine kotan doldu. Daha fazlası için Pro’ya yükselt.');
    expect(error.messageIn('en')).toBe('You have reached your machine limit. Upgrade to Pro for more.');
  });

  it('code beats status for the exit code', () => {
    expect(mapApiError({ status: 400, body: body(400, 'INVALID_STATE') }).exitCode).toBe(ExitCode.INVALID_STATE);
    expect(mapApiError({ status: 400, body: body(400, 'SNAPSHOT_NOT_FOUND') }).exitCode).toBe(ExitCode.NOT_FOUND);
  });

  it('includes the server text in VALIDATION messages (joined Nest arrays)', () => {
    const error = mapApiError({
      status: 400,
      body: { statusCode: 400, code: 'VALIDATION', message: ['name too long', 'size invalid'] },
    });
    expect(error.messageIn('tr')).toBe('İstek doğrulanamadı: name too long; size invalid');
  });

  it('future PLAN_LIMIT_* codes get generic plan copy and exit 5', () => {
    const error = mapApiError({ status: 402, body: body(402, 'PLAN_LIMIT_PORTS') });
    expect(error.code).toBe('PLAN_LIMIT_PORTS');
    expect(error.exitCode).toBe(ExitCode.PLAN_LIMIT);
    expect(error.messageIn('tr')).toContain('Planının sınırına ulaştın');
  });

  it('unknown codes show the sanitized server message and never leak a key', () => {
    const error = mapApiError({ status: 418, body: body(418, 'TEAPOT', `bad ${TEST_KEY}\nline`) });
    expect(error.code).toBe('TEAPOT');
    expect(error.exitCode).toBe(ExitCode.GENERAL);
    expect(error.messageIn('tr')).toBe('bad hb_live_••••a1a1 line');
  });

  it('429 → RATE_LIMITED, exit 7, Retry-After surfaced', () => {
    const error = mapApiError({ status: 429, body: body(429, 'TOO_MANY_REQUESTS'), retryAfter: '12' });
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.exitCode).toBe(ExitCode.NETWORK);
    expect(error.messageIn('tr')).toBe('Çok fazla istek gönderildi. 12 sn sonra tekrar dene.');
    expect(error.details).toMatchObject({ retryAfterSeconds: 12, apiCode: 'TOO_MANY_REQUESTS' });
  });

  it.each([502, 503, 504])('%i → SERVICE_UNAVAILABLE, exit 7', (status) => {
    const error = mapApiError({ status, body: '<html>bad gateway</html>' });
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.exitCode).toBe(ExitCode.NETWORK);
  });

  it('AUTH_BUSY (503 from login queue) → SERVICE_UNAVAILABLE', () => {
    expect(mapApiError({ status: 503, body: body(503, 'AUTH_BUSY') }).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('426 or CLI_UPGRADE_REQUIRED → upgrade message', () => {
    expect(mapApiError({ status: 426, body: null })).toMatchObject({ code: 'CLI_UPGRADE_REQUIRED', exitCode: 8 });
    expect(mapApiError({ status: 400, body: body(400, 'CLI_UPGRADE_REQUIRED') })).toMatchObject({ exitCode: 8 });
  });

  it('bodies without a code fall back by status', () => {
    expect(mapApiError({ status: 401, body: null }).code).toBe('INVALID_API_KEY');
    expect(mapApiError({ status: 500, body: null })).toMatchObject({ code: 'SERVER_ERROR', exitCode: 1 });
    expect(mapApiError({ status: 404, body: 'nope' })).toMatchObject({ code: 'HTTP_ERROR', exitCode: 4 });
    expect(mapApiError({ status: 409, body: {} })).toMatchObject({ code: 'HTTP_ERROR', exitCode: 6 });
  });
});

describe('helpers', () => {
  it('parseApiErrorBody ignores malformed fields', () => {
    expect(parseApiErrorBody({ code: 'lower_case', message: 5, details: { a: 1 } })).toEqual({ details: { a: 1 } });
    expect(parseApiErrorBody('x')).toBeNull();
  });

  it('exitCodeForStatus', () => {
    expect([400, 401, 402, 403, 404, 408, 409, 410, 422, 426, 429, 500, 503].map(exitCodeForStatus)).toEqual([
      2, 3, 5, 3, 4, 7, 6, 4, 2, 8, 7, 1, 7,
    ]);
  });

  it('parseRetryAfter handles seconds and HTTP dates', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
