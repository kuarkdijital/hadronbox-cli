import { localize, type Lang, type Localized, type MessageParams } from '../i18n';
import type { JsonObject } from '../json';
import { CLI_ERRORS, type CliErrorCode } from './messages';
import { ExitCode } from './exit-codes';

export interface CliErrorInit {
  /** Stable UPPER_SNAKE code: a CLI code from CLI_ERRORS or a panel API error code. */
  readonly code: string;
  readonly exitCode: number;
  /** Already interpolated message in both languages. */
  readonly message: Localized;
  /** JSON-safe extra data for `--json` output (never secrets). */
  readonly details?: JsonObject;
  readonly httpStatus?: number;
  readonly cause?: unknown;
}

/** Every failure the CLI reports goes through this type; main() turns it into output + exit code. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly localized: Localized;
  readonly details: JsonObject | undefined;
  readonly httpStatus: number | undefined;

  constructor(init: CliErrorInit) {
    super(init.message.en, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'CliError';
    this.code = init.code;
    this.exitCode = init.exitCode;
    this.localized = init.message;
    this.details = init.details;
    this.httpStatus = init.httpStatus;
  }

  messageIn(lang: Lang): string {
    return this.localized[lang];
  }
}

/** Builds a CLI-owned error from the catalog. */
export function cliError(
  code: CliErrorCode,
  params?: MessageParams,
  extra: { details?: JsonObject; cause?: unknown } = {},
): CliError {
  const spec = CLI_ERRORS[code];
  return new CliError({
    code,
    exitCode: spec.exit,
    message: localize(spec, params),
    details: extra.details,
    cause: extra.cause,
  });
}

/** Anything thrown that is not a CliError is an internal bug: report INTERNAL (exit 1), keep the cause for --debug. */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  return cliError('INTERNAL', undefined, { cause: error });
}

/** Why a passthrough command (exec/sh) failed on the CLI side (`details.reason` in --json). */
export type RemoteFailureReason = 'not_started' | 'timeout' | 'session_lost';

/**
 * Commands that pass the remote exit code through (`exec`, `sh`) report every CLI-side failure with
 * 125 so it never collides with a remote code. The error code and message stay; the JSON details add the class it
 * would have had elsewhere (`cliExitCode`), whether the remote process had already started (`remoteStarted`) and a
 * `reason`: `not_started`, `timeout` (exec --timeout, code TIMEOUT) or `session_lost` (connection dropped after the
 * start). INTERRUPTED keeps 130.
 */
export function toRemoteSetupError(error: CliError, remoteStarted = false): CliError {
  if (error.exitCode === ExitCode.INTERRUPTED || error.exitCode === ExitCode.REMOTE_NOT_STARTED) return error;
  const reason: RemoteFailureReason =
    error.code === 'TIMEOUT' ? 'timeout' : remoteStarted ? 'session_lost' : 'not_started';
  return new CliError({
    code: error.code,
    exitCode: ExitCode.REMOTE_NOT_STARTED,
    message: error.localized,
    details: { ...(error.details ?? {}), cliExitCode: error.exitCode, remoteStarted, reason },
    httpStatus: error.httpStatus,
    cause: error.cause,
  });
}
