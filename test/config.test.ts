import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_API_URL,
  loadConfig,
  normalizeApiUrl,
  readConfigFile,
  resolveApiUrl,
  resolveProfileName,
  writeConfigFile,
  EMPTY_CONFIG,
} from '../src/config/config';
import { configDir, configPaths } from '../src/config/paths';
import { CliError } from '../src/errors/cli-error';

describe('configDir', () => {
  it('Linux/macOS: XDG_CONFIG_HOME, else ~/.config', () => {
    expect(configDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/cfg' }, homedir: '/home/u' })).toBe(
      '/x/cfg/hadronbox',
    );
    expect(configDir({ platform: 'linux', env: {}, homedir: '/home/u' })).toBe('/home/u/.config/hadronbox');
    expect(configDir({ platform: 'darwin', env: {}, homedir: '/Users/u' })).toBe('/Users/u/.config/hadronbox');
  });

  it('ignores a relative XDG_CONFIG_HOME (XDG spec)', () => {
    expect(configDir({ platform: 'linux', env: { XDG_CONFIG_HOME: 'rel' }, homedir: '/home/u' })).toBe(
      '/home/u/.config/hadronbox',
    );
  });

  it('Windows: %APPDATA%\\hadronbox, else ~\\AppData\\Roaming', () => {
    expect(
      configDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, homedir: 'C:\\Users\\u' }),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\hadronbox');
    expect(configDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\u' })).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\hadronbox',
    );
  });

  it('HADRONBOX_CONFIG_DIR overrides everything', () => {
    const paths = configPaths({ platform: 'linux', env: { HADRONBOX_CONFIG_DIR: '/custom/hb' }, homedir: '/home/u' });
    expect(paths).toEqual({
      dir: '/custom/hb',
      configFile: '/custom/hb/config.json',
      credentialsFile: '/custom/hb/credentials.json',
    });
  });
});

describe('API URL', () => {
  it('defaults to https://api.hadronbox.tr', () => {
    expect(resolveApiUrl({}, undefined)).toEqual({ url: DEFAULT_API_URL, source: 'default' });
    expect(DEFAULT_API_URL).toBe('https://api.hadronbox.tr');
  });

  it('env beats profile beats default', () => {
    expect(
      resolveApiUrl({ HADRONBOX_API_URL: 'https://staging.example.tr/' }, { apiUrl: 'https://p.example.tr' }),
    ).toEqual({
      url: 'https://staging.example.tr',
      source: 'env',
    });
    expect(resolveApiUrl({}, { apiUrl: 'https://p.example.tr/api/' })).toEqual({
      url: 'https://p.example.tr/api',
      source: 'profile',
    });
  });

  it('allows http only for loopback', () => {
    expect(normalizeApiUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeApiUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
    for (const bad of ['http://api.hadronbox.tr', 'ftp://x', 'not a url', 'https://u:p@x.tr', 'https://x.tr/?a=1']) {
      expect(() => normalizeApiUrl(bad)).toThrow(CliError);
    }
    try {
      normalizeApiUrl('http://evil.example');
    } catch (error) {
      expect((error as CliError).code).toBe('INVALID_API_URL');
      expect((error as CliError).exitCode).toBe(2);
    }
  });
});

describe('profiles', () => {
  it('flag > env > activeProfile > default, names validated', () => {
    const cfg = { version: 1 as const, activeProfile: 'work', profiles: {} };
    expect(resolveProfileName('ci', { HADRONBOX_PROFILE: 'env' }, cfg)).toBe('ci');
    expect(resolveProfileName(undefined, { HADRONBOX_PROFILE: 'env' }, cfg)).toBe('env');
    expect(resolveProfileName(undefined, {}, cfg)).toBe('work');
    expect(resolveProfileName(undefined, {}, EMPTY_CONFIG)).toBe('default');
    expect(() => resolveProfileName('Bad Name', {}, EMPTY_CONFIG)).toThrow(/Invalid profile name/);
  });
});

describe('config file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hb-cfg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('missing file is an empty config', async () => {
    expect(await readConfigFile(path.join(dir, 'none.json'))).toEqual(EMPTY_CONFIG);
  });

  it('round-trips through an atomic 0600 write in a 0700 directory', async () => {
    const file = path.join(dir, 'sub', 'config.json');
    const cfg = { version: 1 as const, activeProfile: 'work', profiles: { work: { apiUrl: 'https://x.tr' } } };
    await writeConfigFile(file, cfg);
    expect(await readConfigFile(file)).toEqual(cfg);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('corrupt or wrongly shaped files are CONFIG_INVALID (exit 1)', async () => {
    const file = path.join(dir, 'config.json');
    for (const content of [
      '{not json',
      '{"version":2,"profiles":{}}',
      '{"version":1,"profiles":{"BAD":{}}}',
      '{"version":1,"profiles":{"a":{"apiUrl":5}}}',
    ]) {
      await writeFile(file, content);
      await expect(readConfigFile(file)).rejects.toMatchObject({ code: 'CONFIG_INVALID', exitCode: 1 });
    }
  });

  it('loadConfig resolves paths, profile and API URL', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ version: 1, profiles: { default: { apiUrl: 'https://dev.example.tr' } } }),
    );
    const resolved = await loadConfig(
      { platform: 'linux', env: { HADRONBOX_CONFIG_DIR: dir }, homedir: '/home/u' },
      undefined,
    );
    expect(resolved.profile).toBe('default');
    expect(resolved.apiUrl).toBe('https://dev.example.tr');
    expect(resolved.apiUrlSource).toBe('profile');
    expect(resolved.paths.credentialsFile).toBe(path.join(dir, 'credentials.json'));
    expect(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'))).toHaveProperty('version', 1);
  });
});
