import { cliError } from '../errors/cli-error';
import { isRecord } from '../json';
import { maskUrlCredentials } from '../redact';
import { configPaths, type ConfigPaths, type Env, type PlatformInfo } from './paths';
import path from 'node:path';
import { ensurePrivateDir, readPrivateFile, writePrivateFile, type WarningSink } from './secure-file';

export const DEFAULT_API_URL = 'https://api.hadronbox.tr';
export const DEFAULT_PROFILE = 'default';
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Non-secret per-profile settings. Credentials never live in this file. */
export interface ProfileSettings {
  readonly apiUrl?: string;
  /**
   * Origin (`https://host[:port]`) the stored key of this profile was verified against by `hb login`. The
   * stored key is only ever sent to this origin; it is a binding, not a routing setting (that is `apiUrl`).
   */
  readonly credentialOrigin?: string;
}

export interface ConfigFile {
  readonly version: 1;
  readonly activeProfile?: string;
  readonly profiles: Readonly<Record<string, ProfileSettings>>;
}

export const EMPTY_CONFIG: ConfigFile = { version: 1, profiles: {} };

export function assertProfileName(name: string): string {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw cliError('INVALID_PROFILE', { profile: name });
  }
  return name;
}

function parseConfig(raw: string, file: string): ConfigFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw cliError('CONFIG_INVALID', { path: file }, { cause: error });
  }
  if (!isRecord(data) || data.version !== 1) {
    throw cliError('CONFIG_INVALID', { path: file });
  }
  const profiles: Record<string, ProfileSettings> = {};
  if (data.profiles !== undefined) {
    if (!isRecord(data.profiles)) throw cliError('CONFIG_INVALID', { path: file });
    for (const [name, value] of Object.entries(data.profiles)) {
      if (!PROFILE_NAME_PATTERN.test(name) || !isRecord(value)) throw cliError('CONFIG_INVALID', { path: file });
      if (value.apiUrl !== undefined && typeof value.apiUrl !== 'string') {
        throw cliError('CONFIG_INVALID', { path: file });
      }
      if (value.credentialOrigin !== undefined && typeof value.credentialOrigin !== 'string') {
        throw cliError('CONFIG_INVALID', { path: file });
      }
      profiles[name] = {
        ...(value.apiUrl === undefined ? {} : { apiUrl: value.apiUrl }),
        ...(value.credentialOrigin === undefined ? {} : { credentialOrigin: value.credentialOrigin }),
      };
    }
  }
  const current = data.activeProfile;
  if (current !== undefined && (typeof current !== 'string' || !PROFILE_NAME_PATTERN.test(current))) {
    throw cliError('CONFIG_INVALID', { path: file });
  }
  return current === undefined ? { version: 1, profiles } : { version: 1, activeProfile: current, profiles };
}

/**
 * Reads the profile file; a missing file is an empty config. A corrupt one is CONFIG_INVALID (exit 1); one in a
 * directory or file owned by someone else, or a symlinked file, is INSECURE_PATH (exit 1).
 */
export async function readConfigFile(file: string, onWarning?: WarningSink): Promise<ConfigFile> {
  if (!(await ensurePrivateDir(path.dirname(file), onWarning))) return EMPTY_CONFIG;
  const raw = await readPrivateFile(file, 'config', onWarning);
  return raw === null ? EMPTY_CONFIG : parseConfig(raw, file);
}

export async function writeConfigFile(file: string, config: ConfigFile, onWarning?: WarningSink): Promise<void> {
  for (const [name, settings] of Object.entries(config.profiles)) {
    assertProfileName(name);
    if (settings.apiUrl !== undefined) normalizeApiUrl(settings.apiUrl);
    if (settings.credentialOrigin !== undefined) normalizeApiUrl(settings.credentialOrigin);
  }
  if (config.activeProfile !== undefined) assertProfileName(config.activeProfile);
  await writePrivateFile(file, `${JSON.stringify(config, null, 2)}\n`, onWarning);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates and normalizes an API base URL: https only (http allowed for loopback development), no credentials,
 * query or fragment; trailing slashes removed. The API key is only ever sent to a URL that passed this check.
 */
export function normalizeApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch (error) {
    throw cliError('INVALID_API_URL', { url: maskUrlCredentials(raw) });
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw cliError('INVALID_API_URL', { url: maskUrlCredentials(raw) });
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export type ApiUrlSource = 'env' | 'profile' | 'default';

/** `HADRONBOX_API_URL` > profile `apiUrl` > https://api.hadronbox.tr */
export function resolveApiUrl(env: Env, profile: ProfileSettings | undefined): { url: string; source: ApiUrlSource } {
  const fromEnv = env.HADRONBOX_API_URL;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return { url: normalizeApiUrl(fromEnv), source: 'env' };
  }
  if (profile?.apiUrl !== undefined) {
    return { url: normalizeApiUrl(profile.apiUrl), source: 'profile' };
  }
  return { url: DEFAULT_API_URL, source: 'default' };
}

/** `--profile` > `HADRONBOX_PROFILE` > config `activeProfile` > "default". */
export function resolveProfileName(flag: string | undefined, env: Env, config: ConfigFile): string {
  const fromEnv = env.HADRONBOX_PROFILE;
  const name =
    flag ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined) ?? config.activeProfile ?? DEFAULT_PROFILE;
  return assertProfileName(name);
}

export interface ResolvedConfig {
  readonly paths: ConfigPaths;
  readonly file: ConfigFile;
  readonly profile: string;
  readonly apiUrl: string;
  readonly apiUrlSource: ApiUrlSource;
}

export async function loadConfig(
  info: PlatformInfo,
  profileFlag: string | undefined,
  onWarning?: WarningSink,
): Promise<ResolvedConfig> {
  const paths = configPaths(info);
  const file = await readConfigFile(paths.configFile, onWarning);
  const profile = resolveProfileName(profileFlag, info.env, file);
  const { url, source } = resolveApiUrl(info.env, file.profiles[profile]);
  return { paths, file, profile, apiUrl: url, apiUrlSource: source };
}

/** Origin of an API base URL (`https://api.hadronbox.tr`, `http://127.0.0.1:3000`); the credential binding key. */
export function apiOrigin(url: string): string {
  return new URL(url).origin;
}
