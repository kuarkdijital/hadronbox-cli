import path from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

export interface PlatformInfo {
  readonly platform: NodeJS.Platform;
  readonly env: Env;
  readonly homedir: string;
}

const APP_DIR = 'hadronbox';

/**
 * Directory for the profile file and the fallback credential file:
 * - `HADRONBOX_CONFIG_DIR` when set (absolute path; tests, portable setups),
 * - Windows: `%APPDATA%\hadronbox` (Roaming profile, per-user ACL),
 * - everything else (Linux, macOS, BSD): `$XDG_CONFIG_HOME/hadronbox`, else `~/.config/hadronbox`
 *   (XDG Base Directory spec: a relative XDG_CONFIG_HOME is invalid and ignored).
 */
export function configDir({ platform, env, homedir }: PlatformInfo): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const override = env.HADRONBOX_CONFIG_DIR;
  if (override !== undefined && override !== '' && p.isAbsolute(override)) {
    return p.normalize(override);
  }
  if (platform === 'win32') {
    const appData = env.APPDATA;
    const base =
      appData !== undefined && appData !== '' && p.isAbsolute(appData)
        ? appData
        : p.join(homedir, 'AppData', 'Roaming');
    return p.join(base, APP_DIR);
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== '' && p.isAbsolute(xdg) ? xdg : p.join(homedir, '.config');
  return p.join(base, APP_DIR);
}

export interface ConfigPaths {
  readonly dir: string;
  /** Non-secret settings (profiles, API URL). */
  readonly configFile: string;
  /** Fallback credential file (0600) when no OS keychain is usable. */
  readonly credentialsFile: string;
}

export function configPaths(info: PlatformInfo): ConfigPaths {
  const dir = configDir(info);
  const p = info.platform === 'win32' ? path.win32 : path.posix;
  return { dir, configFile: p.join(dir, 'config.json'), credentialsFile: p.join(dir, 'credentials.json') };
}
