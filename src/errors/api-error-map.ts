import { localize, type Localized } from '../i18n';
import { isRecord, type JsonObject, type JsonValue } from '../json';
import { sanitizeServerText } from '../redact';
import { CliError, cliError } from './cli-error';
import { ExitCode } from './exit-codes';
import { API_ERROR_MESSAGES, GENERIC_PLAN_LIMIT } from './messages';

/** Panel API error body. */
export interface ApiErrorBody {
  readonly statusCode?: number;
  readonly error?: string;
  readonly code?: string;
  readonly message?: string;
  readonly details?: JsonValue;
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  return false;
}

/** Picks the known fields out of an arbitrary JSON body; returns null when it is not an error object. */
export function parseApiErrorBody(value: unknown): ApiErrorBody | null {
  if (!isRecord(value)) return null;
  const body: {
    statusCode?: number;
    error?: string;
    code?: string;
    message?: string;
    details?: JsonValue;
  } = {};
  if (typeof value.statusCode === 'number') body.statusCode = value.statusCode;
  if (typeof value.error === 'string') body.error = value.error;
  if (typeof value.code === 'string' && CODE_PATTERN.test(value.code)) body.code = value.code;
  if (typeof value.message === 'string') body.message = value.message;
  // Nest validation errors may carry `message: string[]`.
  if (Array.isArray(value.message) && value.message.every((m): m is string => typeof m === 'string')) {
    body.message = value.message.join('; ');
  }
  if (value.details !== undefined && isJsonValue(value.details)) body.details = value.details;
  return body;
}

/** HTTP status → CLI exit code (README "Çıkış kodları"). */
export function exitCodeForStatus(status: number): number {
  if (status === 426) return ExitCode.CLI_UPGRADE;
  if (status === 400 || status === 422) return ExitCode.USAGE;
  if (status === 401 || status === 403) return ExitCode.AUTH;
  if (status === 402) return ExitCode.PLAN_LIMIT;
  if (status === 404 || status === 410) return ExitCode.NOT_FOUND;
  if (status === 409) return ExitCode.INVALID_STATE;
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) {
    return ExitCode.NETWORK;
  }
  return ExitCode.GENERAL;
}

/** Code-based exit codes win over the status so the contract holds even if an endpoint picks an odd status. */
export function exitCodeForApiCode(code: string): number | undefined {
  if (code === 'VALIDATION') return ExitCode.USAGE;
  if (code.startsWith('PLAN_LIMIT_') || code === 'PLAN_UPGRADE_REQUIRED') return ExitCode.PLAN_LIMIT;
  if (code === 'INVALID_STATE') return ExitCode.INVALID_STATE;
  if (code.endsWith('_NOT_FOUND') || code === 'UNKNOWN_SANDBOX') return ExitCode.NOT_FOUND;
  if (
    code === 'INVALID_API_KEY' ||
    code === 'SESSION_REQUIRED' ||
    code === 'SESSION_INVALID' ||
    code === 'TOKEN_INVALID' ||
    code === 'EMAIL_NOT_VERIFIED' ||
    code === 'NOT_A_MEMBER' ||
    code === 'FORBIDDEN_ROLE'
  ) {
    return ExitCode.AUTH;
  }
  return undefined;
}

/** `Retry-After` in seconds (delta-seconds or HTTP date); undefined when absent or unparseable. */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

export interface ApiErrorInput {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter?: string | null;
}

/** Maps a non-2xx panel API response to a CliError with a stable code, localized message and exit code. */
export function mapApiError(input: ApiErrorInput): CliError {
  const { status } = input;
  const body = parseApiErrorBody(input.body);
  const code = body?.code;
  const serverMessage = body?.message ? sanitizeServerText(body.message) : undefined;
  const retryAfterSeconds = parseRetryAfter(input.retryAfter);

  const details: JsonObject = { httpStatus: status };
  if (code !== undefined) details.apiCode = code;
  if (retryAfterSeconds !== undefined) details.retryAfterSeconds = retryAfterSeconds;
  if (body?.details !== undefined) details.apiDetails = body.details;

  const withStatus = (error: CliError): CliError =>
    new CliError({
      code: error.code,
      exitCode: error.exitCode,
      message: error.localized,
      details,
      httpStatus: status,
    });

  if (status === 426 || code === 'CLI_UPGRADE_REQUIRED') {
    return withStatus(cliError('CLI_UPGRADE_REQUIRED'));
  }
  if (status === 429) {
    const retryAfter = retryAfterSeconds ?? 30;
    return withStatus(cliError('RATE_LIMITED', { retryAfter }));
  }
  if (status === 502 || status === 503 || status === 504 || code === 'AUTH_BUSY') {
    return withStatus(cliError('SERVICE_UNAVAILABLE'));
  }

  if (code !== undefined) {
    const known = API_ERROR_MESSAGES[code];
    let message: Localized;
    if (known) {
      message = localize(known, { detail: serverMessage ?? '-' });
    } else if (code.startsWith('PLAN_LIMIT_')) {
      message = GENERIC_PLAN_LIMIT;
    } else if (serverMessage) {
      message = { tr: serverMessage, en: serverMessage };
    } else {
      message = cliError('HTTP_ERROR', { status }).localized;
    }
    return new CliError({
      code,
      exitCode: exitCodeForApiCode(code) ?? exitCodeForStatus(status),
      message,
      details,
      httpStatus: status,
    });
  }

  // No stable code in the body (proxy error page, old server, …).
  if (status === 401) return withStatus(cliError('INVALID_API_KEY'));
  if (status >= 500) return withStatus(cliError('SERVER_ERROR', { status }));
  const generic = cliError('HTTP_ERROR', { status });
  return new CliError({
    code: generic.code,
    exitCode: exitCodeForStatus(status),
    message: generic.localized,
    details,
    httpStatus: status,
  });
}
