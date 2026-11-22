import { accessSync, constants } from 'node:fs';
import type { CredentialBackend } from './types';
import { API_KEY_PATTERN } from './types';
import type { CommandRunner } from './runner';

/**
 * OS keychain access through the tools the OS already ships, so the npm package has no native module:
 * - macOS: `/usr/bin/security` by absolute path (always present). Writes go through `security -i` on stdin, so
 *   the key never appears in argv / `ps`.
 * - Linux: `secret-tool` (libsecret, GNOME Keyring / KWallet via Secret Service), looked up only in fixed system
 *   directories (never via $PATH, so a writable directory early in PATH cannot plant a fake that receives the key).
 *   Absent on most servers and containers, or without a D-Bus session → the caller falls back to the 0600 file.
 * - Windows: no built-in CLI can read a secret back from Credential Manager → not supported (file fallback).
 * Every write is verified by reading the value back.
 */
export const KEYCHAIN_SERVICE = 'hadronbox-cli';
const TIMEOUT_MS = 15_000;
const MACOS_ITEM_NOT_FOUND = 44;
export const SECURITY_BIN = '/usr/bin/security';
/** Distribution packages (libsecret-tools / libsecret) install here; NixOS uses the system profile. */
export const SECRET_TOOL_CANDIDATES = [
  '/usr/bin/secret-tool',
  '/bin/secret-tool',
  '/usr/local/bin/secret-tool',
  '/run/current-system/sw/bin/secret-tool',
] as const;

/** The keychain could not be used (tool missing, no D-Bus, locked, timeout). Callers may fall back to the file. */
export class KeychainUnavailableError extends Error {
  constructor(
    readonly backend: CredentialBackend,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'KeychainUnavailableError';
  }
}

export interface Keychain {
  readonly backend: Exclude<CredentialBackend, 'file'>;
  get(profile: string): Promise<string | null>;
  set(profile: string, apiKey: string): Promise<void>;
  delete(profile: string): Promise<boolean>;
}

function assertSafeAccount(profile: string): void {
  // Profile names are validated upstream (PROFILE_NAME_PATTERN); re-check because they are spliced into a
  // `security -i` command line.
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) {
    throw new Error(`invalid keychain account: ${profile}`);
  }
}

async function run(
  runner: CommandRunner,
  backend: Exclude<CredentialBackend, 'file'>,
  file: string,
  args: readonly string[],
  input?: string,
) {
  try {
    return await runner(file, args, input === undefined ? { timeoutMs: TIMEOUT_MS } : { input, timeoutMs: TIMEOUT_MS });
  } catch (error) {
    throw new KeychainUnavailableError(backend, `${file} could not be run`, { cause: error });
  }
}

export class MacosKeychain implements Keychain {
  readonly backend = 'macos-keychain' as const;

  constructor(private readonly runner: CommandRunner) {}

  async get(profile: string): Promise<string | null> {
    assertSafeAccount(profile);
    const result = await run(this.runner, this.backend, SECURITY_BIN, [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      profile,
      '-w',
    ]);
    if (result.exitCode === MACOS_ITEM_NOT_FOUND) return null;
    if (result.exitCode !== 0) {
      throw new KeychainUnavailableError(this.backend, `security exited with ${result.exitCode}`);
    }
    const value = result.stdout.trim();
    return value === '' ? null : value;
  }

  async set(profile: string, apiKey: string): Promise<void> {
    assertSafeAccount(profile);
    if (!API_KEY_PATTERN.test(apiKey)) throw new Error('refusing to store a value that is not an API key');
    const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${profile} -l hadronbox-cli -w ${apiKey}\n`;
    await run(this.runner, this.backend, SECURITY_BIN, ['-i'], command);
    if ((await this.get(profile)) !== apiKey) {
      throw new KeychainUnavailableError(this.backend, 'keychain write could not be verified');
    }
  }

  async delete(profile: string): Promise<boolean> {
    assertSafeAccount(profile);
    const result = await run(this.runner, this.backend, SECURITY_BIN, [
      'delete-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      profile,
    ]);
    if (result.exitCode === MACOS_ITEM_NOT_FOUND) return false;
    if (result.exitCode !== 0) {
      throw new KeychainUnavailableError(this.backend, `security exited with ${result.exitCode}`);
    }
    return true;
  }
}

export class LibsecretKeychain implements Keychain {
  readonly backend = 'libsecret' as const;

  constructor(
    private readonly runner: CommandRunner,
    private readonly binary: string = SECRET_TOOL_CANDIDATES[0],
  ) {}

  private attributes(profile: string): string[] {
    assertSafeAccount(profile);
    return ['service', KEYCHAIN_SERVICE, 'account', profile];
  }

  async get(profile: string): Promise<string | null> {
    const result = await run(this.runner, this.backend, this.binary, ['lookup', ...this.attributes(profile)]);
    // secret-tool exits 1 with empty stderr when nothing matches; any stderr means the service is unusable.
    if (result.exitCode !== 0) {
      if (result.stderr.trim() === '') return null;
      throw new KeychainUnavailableError(this.backend, 'secret-tool lookup failed');
    }
    const value = result.stdout.replace(/\r?\n$/, '');
    return value === '' ? null : value;
  }

  async set(profile: string, apiKey: string): Promise<void> {
    if (!API_KEY_PATTERN.test(apiKey)) throw new Error('refusing to store a value that is not an API key');
    const result = await run(
      this.runner,
      this.backend,
      this.binary,
      ['store', `--label=hadronbox CLI (${profile})`, ...this.attributes(profile)],
      apiKey,
    );
    if (result.exitCode !== 0) {
      throw new KeychainUnavailableError(this.backend, 'secret-tool store failed');
    }
    if ((await this.get(profile)) !== apiKey) {
      throw new KeychainUnavailableError(this.backend, 'keychain write could not be verified');
    }
  }

  async delete(profile: string): Promise<boolean> {
    const existing = await this.get(profile);
    if (existing === null) return false;
    const result = await run(this.runner, this.backend, this.binary, ['clear', ...this.attributes(profile)]);
    if (result.exitCode !== 0) {
      throw new KeychainUnavailableError(this.backend, 'secret-tool clear failed');
    }
    return true;
  }
}

export function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The keychain for this platform, or null when there is no usable one (Windows, or no `secret-tool` in the system
 * directories) → file only.
 */
export function platformKeychain(
  platform: NodeJS.Platform,
  runner: CommandRunner,
  canExecute: (file: string) => boolean = isExecutable,
): Keychain | null {
  if (platform === 'darwin') return new MacosKeychain(runner);
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    const binary = SECRET_TOOL_CANDIDATES.find((candidate) => canExecute(candidate));
    return binary === undefined ? null : new LibsecretKeychain(runner, binary);
  }
  return null;
}
