import type { OptionSpecs, ParsedArgs } from '../args/parse';
import type { Env } from '../config/paths';
import type { ResolvedConfig } from '../config/config';
import type { CredentialStore } from '../credentials/types';
import type { ResolvedAuth } from '../credentials/auth';
import type { ApiClient } from '../http/client';
import type { Lang, Localized } from '../i18n';
import type { Output } from '../output';
import type { Prompter } from '../prompt';

/** Lazily created services; a command only pays for (and can only fail on) what it uses. */
export interface Services {
  config(): Promise<ResolvedConfig>;
  credentials(): Promise<CredentialStore>;
  auth(): Promise<ResolvedAuth>;
  /**
   * API client for the active profile. `auth: false` for unauthenticated endpoints; `apiKey` uses that key instead
   * of the resolved one (login verifies a new key before storing it).
   */
  api(options?: { auth?: boolean; apiKey?: string }): Promise<ApiClient>;
}

export interface CommandContext {
  readonly args: ParsedArgs;
  readonly out: Output;
  readonly lang: Lang;
  readonly env: Env;
  readonly services: Services;
  /** True when prompts are allowed (stdin and stderr are TTYs and CI is not set). */
  readonly interactive: boolean;
  readonly registry: readonly CommandSpec[];
  /** Whether stdin is a terminal (false: piped/redirected input can be read with readStdin). */
  readonly stdinIsTTY: boolean;
  /** Reads all of stdin (only call when it is piped). */
  readStdin(): Promise<string>;
  /** Terminal questions; only call when `interactive` is true. */
  readonly prompt: Prompter;
  /** exec/sh: the remote process is running from now on (see CommandSpec.passthroughExit). */
  markRemoteStarted(): void;
}

export interface CommandSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: Localized;
  /** Usage line after `hb `, e.g. "machines rm <ad> [--yes]". */
  readonly usage: string;
  /** At least one example per command. */
  readonly examples: readonly string[];
  /** Extra line(s) shown under the examples in `--help` (not an example). */
  readonly notes?: Localized;
  readonly options?: OptionSpecs;
  readonly maxPositionals?: number;
  readonly subcommands?: readonly CommandSpec[];
  readonly hidden?: boolean;
  /**
   * Commands that exit with a remote command's code (`exec`, `sh`). Every CliError they throw exits 125
   * (see toRemoteSetupError); call `ctx.markRemoteStarted()` once the remote process runs so later
   * failures carry `remoteStarted: true` (`reason: session_lost`, or `timeout` for TIMEOUT). When the remote process
   * finished, return its code via remoteExitCode() instead of throwing.
   */
  readonly passthroughExit?: boolean;
  /** Returns the exit code (default 0). Throw CliError for failures. */
  readonly run?: (ctx: CommandContext) => Promise<number | void>;
}
