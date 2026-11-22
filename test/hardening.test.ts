import { chmod, chown, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeApiUrl, readConfigFile } from '../src/config/config';
import { ensurePrivateDir, readPrivateFile, writePrivateFile } from '../src/config/secure-file';
import { FileCredentialStore } from '../src/credentials/file-store';
import {
  LibsecretKeychain,
  MacosKeychain,
  SECRET_TOOL_CANDIDATES,
  SECURITY_BIN,
  platformKeychain,
} from '../src/credentials/keychain';
import { spawnRunner, type CommandRunner } from '../src/credentials/runner';
import { LayeredCredentialStore } from '../src/credentials/store';
import type { Keychain } from '../src/credentials/keychain';
import { CliError } from '../src/errors/cli-error';
import { ApiClient, apiPath } from '../src/http/client';
import type { Localized } from '../src/i18n';
import { maskUrlCredentials, sanitizeServerText, stripControlChars } from '../src/redact';
import { TEST_KEY, jsonResponse } from './helpers';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('text sanitizing', () => {
  it('strips C0, C1 (8-bit CSI) and bidi controls', () => {
    expect(stripControlChars('a\u001b[2Jb\u009b31mc\u202ed\u2066e\u200ff')).toBe('a [2Jb 31mc d e f');
    expect(sanitizeServerText(`x\u0085y ${TEST_KEY}`)).toBe('x y hb_live_••••a1a1');
  });

  it('masks URL credentials, parsed or not', () => {
    expect(maskUrlCredentials('https://user:secret@api.example.tr/x')).toBe('https://***@api.example.tr/x');
    expect(maskUrlCredentials('ht!tp://u:p@[bad')).toBe('ht!tp://***@[bad');
    try {
      normalizeApiUrl('https://user:secret@api.example.tr');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).messageIn('tr')).not.toContain('secret');
      expect((error as CliError).messageIn('en')).toContain('https://***@api.example.tr');
    }
  });
});

describe('config directory and file trust', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hb-trust-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a symlinked credentials/config file (O_NOFOLLOW)', async () => {
    const target = path.join(dir, 'elsewhere.json');
    await writeFile(target, JSON.stringify({ version: 1, profiles: {} }), { mode: 0o600 });
    await chmod(dir, 0o700);
    await symlink(target, path.join(dir, 'credentials.json'));
    await symlink(target, path.join(dir, 'config.json'));
    await expect(new FileCredentialStore(path.join(dir, 'credentials.json')).get('default')).rejects.toMatchObject({
      code: 'INSECURE_PATH',
      exitCode: 1,
      details: { reason: 'symlink' },
    });
    await expect(readConfigFile(path.join(dir, 'config.json'))).rejects.toMatchObject({ code: 'INSECURE_PATH' });
  });

  it('tightens our own group/world-writable directory to 0700 with a warning', async () => {
    await chmod(dir, 0o777);
    const warnings: Localized[] = [];
    expect(await ensurePrivateDir(dir, (w) => warnings.push(w))).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(warnings[0]?.tr).toContain('0700');
    expect(await ensurePrivateDir(path.join(dir, 'missing'))).toBe(false);
  });

  it('tightens a group-writable config.json but leaves a readable one alone', async () => {
    await chmod(dir, 0o700);
    const file = path.join(dir, 'config.json');
    await writeFile(file, '{}', { mode: 0o644 });
    await chmod(file, 0o644);
    expect(await readPrivateFile(file, 'config')).toBe('{}');
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    await chmod(file, 0o664);
    const warnings: Localized[] = [];
    await readPrivateFile(file, 'config', (w) => warnings.push(w));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(warnings).toHaveLength(1);
  });

  it.runIf(isRoot)('refuses a directory or file owned by another user', async () => {
    const other = path.join(dir, 'other');
    await mkdir(other, { mode: 0o700 });
    await chown(other, 4242, 4242);
    await expect(ensurePrivateDir(other)).rejects.toMatchObject({
      code: 'INSECURE_PATH',
      details: { reason: 'owner' },
    });
    await chmod(dir, 0o700);
    const file = path.join(dir, 'credentials.json');
    await writeFile(file, '{}', { mode: 0o600 });
    await chown(file, 4242, 4242);
    await expect(readPrivateFile(file, 'secret')).rejects.toMatchObject({ details: { reason: 'owner' } });
  });

  it('writePrivateFile replaces a planted symlink instead of writing through it', async () => {
    await chmod(dir, 0o700);
    const victim = path.join(dir, 'victim.txt');
    await writeFile(victim, 'keep');
    const file = path.join(dir, 'credentials.json');
    await symlink(victim, file);
    await writePrivateFile(file, 'new');
    expect((await stat(file)).isSymbolicLink()).toBe(false);
    expect(await readPrivateFile(victim, 'config')).toBe('keep');
    expect(await readPrivateFile(file, 'secret')).toBe('new');
  });
});

describe('keychain tool paths and checks', () => {
  it('macOS uses /usr/bin/security; item not found (44) → null; unsafe account rejected', async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (file) => {
      calls.push(file);
      return { exitCode: 44, stdout: '', stderr: '' };
    };
    const keychain = new MacosKeychain(runner);
    expect(await keychain.get('default')).toBeNull();
    expect(calls).toEqual([SECURITY_BIN]);
    expect(SECURITY_BIN).toBe('/usr/bin/security');
    await expect(keychain.get('x -w evil')).rejects.toThrow(/invalid keychain account/);
    await expect(keychain.set('default', 'not-a-key')).rejects.toThrow(/not an API key/);
  });

  it('secret-tool is only looked up in fixed absolute directories, never via PATH', () => {
    expect(SECRET_TOOL_CANDIDATES.every((p) => path.isAbsolute(p))).toBe(true);
    const seen: string[] = [];
    expect(platformKeychain('linux', spawnRunner, (p) => (seen.push(p), false))).toBeNull();
    expect(seen).toEqual([...SECRET_TOOL_CANDIDATES]);
    const found = platformKeychain('linux', spawnRunner, (p) => p === '/usr/local/bin/secret-tool');
    expect(found).toBeInstanceOf(LibsecretKeychain);
  });
});

describe('layered store warnings', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hb-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const okKeychain = (): Keychain => {
    const items = new Map<string, string>();
    return {
      backend: 'libsecret',
      get: async (p) => items.get(p) ?? null,
      set: async (p, k) => void items.set(p, k),
      delete: async (p) => items.delete(p),
    };
  };

  it('keychain write succeeded but a corrupt credentials.json cannot be cleaned → warning, keychain result', async () => {
    const file = path.join(dir, 'credentials.json');
    await writeFile(file, '{corrupt', { mode: 0o600 });
    await chmod(dir, 0o700);
    const warnings: Localized[] = [];
    const store = new LayeredCredentialStore(
      'auto',
      okKeychain(),
      new FileCredentialStore(file),
      (w) => warnings.push(w),
      file,
    );
    expect(await store.set('default', TEST_KEY)).toBe('libsecret');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.en).toContain('could not be removed');
  });

  it('falling back to the file in auto mode warns once; explicit file mode does not warn', async () => {
    const file = path.join(dir, 'credentials.json');
    const warnings: Localized[] = [];
    const auto = new LayeredCredentialStore('auto', null, new FileCredentialStore(file), (w) => warnings.push(w), file);
    await auto.set('default', TEST_KEY);
    await auto.set('other', TEST_KEY);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.tr).toContain('0600');
    const explicit = new LayeredCredentialStore(
      'file',
      null,
      new FileCredentialStore(file),
      (w) => warnings.push(w),
      file,
    );
    await explicit.set('third', TEST_KEY);
    expect(warnings).toHaveLength(1);
  });
});

describe('spawnRunner (real child processes)', () => {
  const node = process.execPath;

  it('passes stdin, not argv, and collects stdout/stderr/exit code', async () => {
    const script =
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(d.toUpperCase());process.stderr.write("e");process.exit(3)})';
    const result = await spawnRunner(node, ['-e', script], { input: 'secret', timeoutMs: 10_000 });
    expect(result).toEqual({ exitCode: 3, stdout: 'SECRET', stderr: 'e' });
  });

  it('rejects with ENOENT for a missing program', async () => {
    await expect(spawnRunner('/nonexistent/hb-tool', [], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('kills and rejects on timeout', async () => {
    await expect(spawnRunner(node, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 100 })).rejects.toMatchObject({
      name: 'CommandTimeoutError',
    });
  });
});

describe('HTTP hardening', () => {
  it('requests use redirect: manual', async () => {
    let redirect: RequestRedirect | undefined;
    const api = new ApiClient({
      baseUrl: 'https://api.example.tr',
      fetch: async (_url, init) => {
        redirect = init.redirect;
        return jsonResponse(200, { data: null });
      },
    });
    await api.get('/me', (v) => v);
    expect(redirect).toBe('manual');
  });

  it('apiPath encodes each value as one segment and rejects dot segments', () => {
    expect(apiPath`/sandboxes/${'a b/c?d#e'}/exec`).toBe('/sandboxes/a%20b%2Fc%3Fd%23e/exec');
    expect(apiPath`/sandboxes/${'../api-keys'}`).toBe('/sandboxes/..%2Fapi-keys');
    for (const bad of ['..', '.', '']) {
      expect(() => apiPath`/sandboxes/${bad}`).toThrow(CliError);
    }
    try {
      apiPath`/sandboxes/${'..'}`;
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_PATH_SEGMENT', exitCode: 2 });
    }
  });

  it('url() refuses raw dot segments, also percent-encoded', () => {
    const api = new ApiClient({ baseUrl: 'https://api.example.tr' });
    expect(() => api.url('/sandboxes/../api-keys')).toThrow(/segments/);
    expect(() => api.url('/sandboxes/%2e%2E/api-keys')).toThrow(/segments/);
    expect(api.url('/sandboxes/a..b')).toBe('https://api.example.tr/sandboxes/a..b');
  });

  it('caps the response size (declared and streamed)', async () => {
    const declared = new ApiClient({
      baseUrl: 'https://api.example.tr',
      fetch: async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(11 * 1024 * 1024) },
        }),
    });
    await expect(declared.get('/me', (v) => v)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE', exitCode: 1 });
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const streamed = new ApiClient({
      baseUrl: 'https://api.example.tr',
      fetch: async () => {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            if (sent > 12) controller.close();
            else controller.enqueue(chunk);
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await expect(streamed.get('/me', (v) => v)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});
