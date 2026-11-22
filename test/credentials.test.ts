import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveApiKey } from '../src/credentials/auth';
import { FileCredentialStore } from '../src/credentials/file-store';
import { KEYCHAIN_SERVICE, LibsecretKeychain, MacosKeychain, platformKeychain } from '../src/credentials/keychain';
import type { CommandRunner, RunResult } from '../src/credentials/runner';
import { createCredentialStore, resolveStoreMode } from '../src/credentials/store';
import type { Localized } from '../src/i18n';
import { TEST_KEY } from './helpers';

const OTHER_KEY = `hb_live_${'b2'.repeat(24)}`;

/** In-memory fake of `security` / `secret-tool`, recording argv and stdin. */
function fakeKeychainRunner(kind: 'macos' | 'libsecret') {
  const items = new Map<string, string>();
  const calls: { file: string; args: readonly string[]; input?: string }[] = [];
  const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' });
  const runner: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, input: options.input });
    if (kind === 'macos') {
      if (args[0] === '-i') {
        const match = /-a (\S+) .* -w (\S+)/.exec(options.input ?? '');
        if (match?.[1] && match[2]) items.set(match[1], match[2]);
        return ok();
      }
      const account = args[args.indexOf('-a') + 1] ?? '';
      if (args[0] === 'find-generic-password') {
        const value = items.get(account);
        return value === undefined ? { exitCode: 44, stdout: '', stderr: 'not found' } : ok(`${value}\n`);
      }
      if (args[0] === 'delete-generic-password') {
        return items.delete(account) ? ok() : { exitCode: 44, stdout: '', stderr: '' };
      }
    } else {
      const account = args[args.indexOf('account') + 1] ?? '';
      if (args[0] === 'lookup') {
        const value = items.get(account);
        return value === undefined ? { exitCode: 1, stdout: '', stderr: '' } : ok(value);
      }
      if (args[0] === 'store') {
        items.set(account, options.input ?? '');
        return ok();
      }
      if (args[0] === 'clear') {
        items.delete(account);
        return ok();
      }
    }
    throw new Error(`unexpected call ${file} ${args.join(' ')}`);
  };
  return { runner, items, calls };
}

const missingTool: CommandRunner = async () => {
  throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });
};

const noDbus: CommandRunner = async () => ({
  exitCode: 1,
  stdout: '',
  stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY',
});

describe('credential storage', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hb-cred-'));
    file = path.join(dir, 'hadronbox', 'credentials.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('FileCredentialStore', () => {
    it('writes 0600 inside a 0700 dir, reads back, deletes', async () => {
      const store = new FileCredentialStore(file);
      await store.set('default', TEST_KEY);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      expect(await store.get('default')).toBe(TEST_KEY);
      expect(await store.get('other')).toBeNull();
      await store.set('other', OTHER_KEY);
      expect(await store.delete('default')).toBe(true);
      expect(await store.get('other')).toBe(OTHER_KEY);
      expect(await store.delete('other')).toBe(true);
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await store.delete('other')).toBe(false);
    });

    it('tightens loose permissions and warns', async () => {
      const warnings: Localized[] = [];
      const store = new FileCredentialStore(file, (m) => warnings.push(m));
      await store.set('default', TEST_KEY);
      await chmod(file, 0o644);
      expect(await store.get('default')).toBe(TEST_KEY);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.tr).toContain('0600');
    });
  });

  describe('macOS keychain', () => {
    it('never puts the key in argv (security -i over stdin) and verifies the write', async () => {
      const fake = fakeKeychainRunner('macos');
      const keychain = new MacosKeychain(fake.runner);
      await keychain.set('default', TEST_KEY);
      expect(await keychain.get('default')).toBe(TEST_KEY);
      for (const call of fake.calls) {
        expect(call.args.join(' ')).not.toContain('hb_live_');
      }
      expect(fake.calls[0]?.input).toContain(`-s ${KEYCHAIN_SERVICE} -a default`);
      expect(await keychain.delete('default')).toBe(true);
      expect(await keychain.delete('default')).toBe(false);
    });
  });

  describe('libsecret', () => {
    it('stores via stdin and reads back', async () => {
      const fake = fakeKeychainRunner('libsecret');
      const keychain = new LibsecretKeychain(fake.runner);
      await keychain.set('default', TEST_KEY);
      expect(fake.items.get('default')).toBe(TEST_KEY);
      expect(await keychain.get('default')).toBe(TEST_KEY);
      expect(fake.calls.every((c) => !c.args.join(' ').includes('hb_live_'))).toBe(true);
    });

    it('treats D-Bus failures as unavailable', async () => {
      await expect(new LibsecretKeychain(noDbus).get('default')).rejects.toMatchObject({
        name: 'KeychainUnavailableError',
      });
    });
  });

  it('platformKeychain: none on Windows', () => {
    expect(platformKeychain('win32', missingTool, () => true)).toBeNull();
    expect(platformKeychain('darwin', missingTool, () => false)?.backend).toBe('macos-keychain');
    expect(platformKeychain('linux', missingTool, () => true)?.backend).toBe('libsecret');
  });

  describe('layered store', () => {
    it('auto: keychain when available, and removes a stale file entry', async () => {
      await new FileCredentialStore(file).set('default', OTHER_KEY);
      const fake = fakeKeychainRunner('libsecret');
      const store = createCredentialStore({
        platform: 'linux',
        env: {},
        credentialsFile: file,
        runner: fake.runner,
        canExecute: () => true,
      });
      expect(store.preferred).toBe('libsecret');
      expect(await store.set('default', TEST_KEY)).toBe('libsecret');
      expect(await store.get('default')).toEqual({ apiKey: TEST_KEY, backend: 'libsecret' });
      expect(await new FileCredentialStore(file).get('default')).toBeNull();
    });

    it('auto: falls back to the 0600 file when secret-tool is missing or D-Bus is absent', async () => {
      for (const runner of [missingTool, noDbus]) {
        const store = createCredentialStore({
          platform: 'linux',
          env: {},
          credentialsFile: file,
          runner,
          canExecute: () => true,
        });
        expect(await store.set('default', TEST_KEY)).toBe('file');
        expect(await store.get('default')).toEqual({ apiKey: TEST_KEY, backend: 'file' });
        expect(await store.delete('default')).toBe(true);
      }
    });

    it('Windows uses the file', async () => {
      const store = createCredentialStore({ platform: 'win32', env: {}, credentialsFile: file, runner: missingTool });
      expect(store.preferred).toBe('file');
      expect(await store.set('default', TEST_KEY)).toBe('file');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        version: 1,
        profiles: { default: { apiKey: TEST_KEY } },
      });
    });

    it('keychain mode fails loudly instead of falling back', async () => {
      const store = createCredentialStore({
        platform: 'linux',
        env: { HADRONBOX_CREDENTIAL_STORE: 'keychain' },
        credentialsFile: file,
        runner: missingTool,
        canExecute: () => true,
      });
      await expect(store.set('default', TEST_KEY)).rejects.toMatchObject({
        code: 'CREDENTIAL_STORE_ERROR',
        exitCode: 1,
      });
      expect(() =>
        createCredentialStore({
          platform: 'win32',
          env: { HADRONBOX_CREDENTIAL_STORE: 'keychain' },
          credentialsFile: file,
        }),
      ).toThrow();
    });

    it('file mode never touches the keychain', async () => {
      const fake = fakeKeychainRunner('macos');
      const store = createCredentialStore({
        platform: 'darwin',
        env: { HADRONBOX_CREDENTIAL_STORE: 'file' },
        credentialsFile: file,
        runner: fake.runner,
      });
      expect(await store.set('default', TEST_KEY)).toBe('file');
      expect(fake.calls).toHaveLength(0);
    });

    it('refuses to store something that is not an API key', async () => {
      const store = createCredentialStore({ platform: 'win32', env: {}, credentialsFile: file });
      await expect(store.set('default', 'hunter2')).rejects.toMatchObject({ code: 'INVALID_API_KEY', exitCode: 3 });
    });

    it('resolveStoreMode validates the env value', () => {
      expect(resolveStoreMode({})).toBe('auto');
      expect(resolveStoreMode({ HADRONBOX_CREDENTIAL_STORE: 'file' })).toBe('file');
      expect(() => resolveStoreMode({ HADRONBOX_CREDENTIAL_STORE: 'vault' })).toThrow(/HADRONBOX_CREDENTIAL_STORE/);
    });
  });

  describe('resolveApiKey', () => {
    it('HADRONBOX_API_KEY first, then the stored credential', async () => {
      const store = createCredentialStore({ platform: 'win32', env: {}, credentialsFile: file });
      await store.set('default', OTHER_KEY);
      expect(await resolveApiKey({ HADRONBOX_API_KEY: ` ${TEST_KEY} ` }, store, 'default')).toEqual({
        apiKey: TEST_KEY,
        source: 'env',
      });
      expect(await resolveApiKey({}, store, 'default')).toEqual({ apiKey: OTHER_KEY, source: 'file' });
    });

    it('no key → AUTH_REQUIRED (3); malformed → INVALID_API_KEY (3)', async () => {
      const store = createCredentialStore({ platform: 'win32', env: {}, credentialsFile: file });
      await expect(resolveApiKey({}, store, 'default')).rejects.toMatchObject({ code: 'AUTH_REQUIRED', exitCode: 3 });
      await expect(resolveApiKey({ HADRONBOX_API_KEY: 'hb_live_short' }, store, 'default')).rejects.toMatchObject({
        code: 'INVALID_API_KEY',
        exitCode: 3,
      });
    });
  });
});
