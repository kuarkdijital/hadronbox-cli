import {
  assertNoSecretsInArgv,
  terminatorIndex,
  booleanValue,
  leadingPositionals,
  parseArguments,
  peekOptions,
  stringValue,
  type OptionSpecs,
} from './args/parse';
import { COMMANDS } from './commands';
import { GLOBAL_OPTIONS } from './commands/global-options';
import { printHelp, suggestionText } from './commands/help';
import { findCommand, suggestCommand } from './commands/resolve';
import type { CommandContext, CommandSpec, Services } from './commands/types';
import { printVersion } from './commands/version';
import { assertProfileName, loadConfig, type ResolvedConfig } from './config/config';
import type { Env } from './config/paths';
import { resolveApiKey, type ResolvedAuth } from './credentials/auth';
import type { CommandRunner } from './credentials/runner';
import { createCredentialStore } from './credentials/store';
import type { CredentialStore } from './credentials/types';
import { cliError, toCliError, toRemoteSetupError } from './errors/cli-error';
import { ExitCode } from './errors/exit-codes';
import { ApiClient, type FetchLike } from './http/client';
import { DEFAULT_LANG, isLang, type Lang, type Localized } from './i18n';
import { Output, shouldUseColor, type Writer } from './output';
import type { Prompter } from './prompt';

export interface MainIO {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly stdinIsTTY?: boolean;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly fetch?: FetchLike;
  readonly runner?: CommandRunner;
  readonly commands?: readonly CommandSpec[];
  /** Terminal questions (bin: raw-mode TTY on process.stdin/stderr). */
  readonly prompter?: Prompter;
  /** Reads a piped stdin completely (bin: process.stdin). */
  readonly readStdin?: () => Promise<string>;
}

const noPrompter: Prompter = {
  confirm: () => Promise.reject(new Error('no prompter configured')),
  secret: () => Promise.reject(new Error('no prompter configured')),
};

/** `--lang` > `HADRONBOX_LANG` > tr. An invalid env value is ignored here and reported by resolveLang. */
function envLang(env: Env): Lang | undefined {
  const value = env.HADRONBOX_LANG;
  return isLang(value) ? value : undefined;
}

function assertEnvLang(env: Env): void {
  const value = env.HADRONBOX_LANG;
  if (value !== undefined && value !== '' && !isLang(value)) {
    throw cliError('INVALID_ENV_VALUE', { name: 'HADRONBOX_LANG', value, allowed: 'tr, en' });
  }
}

function memo<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= factory();
    return cached;
  };
}

function createServices(io: MainIO, out: Output, profileFlag: string | undefined, debug: boolean): Services {
  const warn = (message: Localized) => out.warn(message[out.lang]);
  const config = memo<ResolvedConfig>(() =>
    loadConfig({ platform: io.platform, env: io.env, homedir: io.homedir }, profileFlag, warn),
  );
  const credentials = memo<CredentialStore>(async () => {
    const resolved = await config();
    return createCredentialStore({
      platform: io.platform,
      env: io.env,
      credentialsFile: resolved.paths.credentialsFile,
      runner: io.runner,
      onWarning: warn,
    });
  });
  const auth = memo<ResolvedAuth>(async () => {
    const resolved = await config();
    return resolveApiKey(io.env, await credentials(), resolved.profile, {
      apiUrl: resolved.apiUrl,
      credentialOrigin: resolved.file.profiles[resolved.profile]?.credentialOrigin,
    });
  });
  return {
    config,
    credentials,
    auth,
    async api(options = {}) {
      const resolved = await config();
      const apiKey = options.apiKey ?? (options.auth === false ? undefined : (await auth()).apiKey);
      return new ApiClient({
        baseUrl: resolved.apiUrl,
        apiKey,
        fetch: io.fetch,
        onDebug: debug ? (line) => out.debug(line) : undefined,
      });
    },
  };
}

interface Resolution {
  readonly path: readonly CommandSpec[];
  readonly skipIndexes: ReadonlySet<number>;
}

/** Walks positionals (before `--`) down the command tree: `hb machines rm x` → [machines, rm]. */
function resolveCommandPath(argv: readonly string[], commands: readonly CommandSpec[], lang: Lang): Resolution {
  const path: CommandSpec[] = [];
  const skipIndexes = new Set<number>();
  let level: readonly CommandSpec[] = commands;
  for (const positional of leadingPositionals(argv, GLOBAL_OPTIONS)) {
    if (level.length === 0) break;
    const next = findCommand(level, positional.value);
    if (next === undefined) {
      // Unknown word: at the root (or under a group without its own action) it is an unknown command;
      // under a runnable command it is that command's argument.
      const parent = path[path.length - 1];
      if (parent === undefined || parent.run === undefined) {
        const typed = [...path.map((c) => c.name), positional.value].join(' ');
        throw cliError('UNKNOWN_COMMAND', {
          command: typed,
          suggestion: suggestionText(lang, suggestCommand(level, positional.value)),
        });
      }
      break;
    }
    path.push(next);
    skipIndexes.add(positional.index);
    level = next.subcommands ?? [];
  }
  return { path, skipIndexes };
}

/** `--json` anywhere before `--`, also when its value is malformed (`--json=1`), selects JSON error output. */
function wantsJson(argv: readonly string[]): boolean {
  const end = terminatorIndex(argv, GLOBAL_OPTIONS);
  const checked = end === -1 ? argv : argv.slice(0, end);
  return checked.some((arg) => arg === '--json' || arg.startsWith('--json='));
}

/**
 * One CLI run. Owns the single Output instance, so every exit path — normal errors, SIGINT, uncaught exceptions —
 * reports through the same error contract (one JSON document on stdout with --json, two stderr lines otherwise).
 */
export class Cli {
  readonly out: Output;
  readonly lang: Lang;
  private readonly commands: readonly CommandSpec[];
  private readonly debug: boolean;
  private passthrough = false;
  private remoteStarted = false;

  constructor(private readonly io: MainIO) {
    this.commands = io.commands ?? COMMANDS;
    const peek = peekOptions(io.argv, GLOBAL_OPTIONS);
    const peekLang = stringValue(peek, 'lang');
    this.lang = (isLang(peekLang) ? peekLang : undefined) ?? envLang(io.env) ?? DEFAULT_LANG;
    this.debug = booleanValue(peek, 'debug') || io.env.HADRONBOX_DEBUG === '1';
    this.out = new Output({
      stdout: io.stdout,
      stderr: io.stderr,
      json: booleanValue(peek, 'json') || wantsJson(io.argv),
      debug: this.debug,
      lang: this.lang,
      color: shouldUseColor(io.env, io.stderr, booleanValue(peek, 'no-color')),
    });
  }

  /** Reports any failure through the error contract and returns its exit code. Never throws. */
  fail(error: unknown): number {
    let cliErr = toCliError(error);
    if (this.passthrough) cliErr = toRemoteSetupError(cliErr, this.remoteStarted);
    try {
      this.out.error(cliErr);
    } catch {
      // stdout/stderr are gone (closed pipe); the exit code still carries the result.
    }
    return cliErr.exitCode;
  }

  /** SIGINT before a command installed its own handler. */
  interrupt(): number {
    return this.fail(cliError('INTERRUPTED'));
  }

  /** Runs the command line and returns the process exit code. Never throws. */
  async run(): Promise<number> {
    const { io, out, lang } = this;
    try {
      assertNoSecretsInArgv(io.argv, GLOBAL_OPTIONS);
      assertEnvLang(io.env);
      const { path, skipIndexes } = resolveCommandPath(io.argv, this.commands, lang);
      const command = path[path.length - 1];
      const specs: OptionSpecs = { ...GLOBAL_OPTIONS, ...(command?.options ?? {}) };
      const args = parseArguments(io.argv, specs, {
        skipIndexes,
        maxPositionals: command?.maxPositionals,
      });
      const profileFlag = stringValue(args.values, 'profile');
      if (profileFlag !== undefined) assertProfileName(profileFlag);
      const helpCtx = { out, lang, registry: this.commands };

      if (booleanValue(args.values, 'version')) {
        printVersion({ out });
        return ExitCode.OK;
      }
      if (booleanValue(args.values, 'help') || command === undefined) {
        if (command === undefined) {
          const stray = args.positionals[0] ?? args.rest[0];
          if (stray !== undefined) throw cliError('UNEXPECTED_ARGUMENT', { argument: stray });
        }
        printHelp(helpCtx, path);
        return ExitCode.OK;
      }
      if (command.run === undefined) {
        throw cliError('MISSING_COMMAND', { command: path.map((c) => c.name).join(' ') });
      }

      const interactive =
        io.stdinIsTTY === true &&
        io.stderr.isTTY === true &&
        (io.env.CI === undefined || io.env.CI === '' || io.env.CI === 'false');
      const ctx: CommandContext = {
        args,
        out,
        lang,
        env: io.env,
        services: createServices(io, out, profileFlag, this.debug),
        interactive,
        registry: this.commands,
        stdinIsTTY: io.stdinIsTTY === true,
        readStdin: io.readStdin ?? (() => Promise.resolve('')),
        prompt: io.prompter ?? noPrompter,
        markRemoteStarted: () => {
          this.remoteStarted = true;
        },
      };
      this.passthrough = command.passthroughExit === true;
      const code = await command.run(ctx);
      return code ?? ExitCode.OK;
    } catch (error) {
      return this.fail(error);
    }
  }
}

/** Runs the CLI and returns the process exit code (see {@link Cli}). */
export function main(io: MainIO): Promise<number> {
  return new Cli(io).run();
}
