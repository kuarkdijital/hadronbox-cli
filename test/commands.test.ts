import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MainIO } from '../src/main';
import type { Prompter } from '../src/prompt';
import { FakeApi, fakeMachine, type FakeApiOptions } from './fake-api';
import { TEST_KEY, runCli, type RunResult } from './helpers';

const OTHER_KEY = `hb_live_${'c3'.repeat(24)}`;

let dir: string;
let api: FakeApi;

async function startApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  api = await new FakeApi(options).start();
  return api;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hb-cmd-'));
});

afterEach(async () => {
  await api?.stop();
  await rm(dir, { recursive: true, force: true });
});

/** Environment for a CLI run against the fake API with file credentials in a temp config dir. */
function env(extra: Record<string, string> = {}): Record<string, string> {
  return { HADRONBOX_CONFIG_DIR: dir, HADRONBOX_API_URL: api.url, HADRONBOX_CREDENTIAL_STORE: 'file', ...extra };
}

function hb(argv: string[], overrides: Partial<MainIO> = {}, options: { tty?: boolean } = {}): Promise<RunResult> {
  return runCli(argv, { env: env(), ...overrides }, options);
}

function withKey(argv: string[], overrides: Partial<MainIO> = {}, options: { tty?: boolean } = {}): Promise<RunResult> {
  return runCli(argv, { env: env({ HADRONBOX_API_KEY: TEST_KEY }), ...overrides }, options);
}

function prompter(answers: { secret?: string; confirm?: boolean }): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async confirm(question) {
      asked.push(question);
      return answers.confirm ?? false;
    },
    async secret(question) {
      asked.push(question);
      return answers.secret ?? '';
    },
  };
}

const outputs: string[] = [];
afterEach(() => {
  // No command ever prints a full key.
  expect(outputs.join('\n')).not.toMatch(/hb_live_[0-9a-f]{8,}/);
  outputs.length = 0;
});
function keep(result: RunResult): RunResult {
  outputs.push(result.stdout, result.stderr);
  return result;
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
}

describe('hb login', () => {
  it('--with-api-key reads stdin, verifies with GET /me, stores 0600, activates the profile and binds the key', async () => {
    await startApi();
    const r = keep(await hb(['login', '--with-api-key'], { readStdin: async () => `${TEST_KEY}\n` }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Giriş yapıldı: sen@ornek.com');
    expect(r.stdout).toContain('0600 izinli dosya');
    expect(api.requests.map((q) => [q.method, q.url, q.authorization])).toEqual([['GET', '/me', `Bearer ${TEST_KEY}`]]);
    expect(api.requests[0]?.userAgent).toMatch(/^hadronbox-cli\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \(\w+\)$/);
    const credentials = path.join(dir, 'credentials.json');
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentials, 'utf8'))).toEqual({
      version: 1,
      profiles: { default: { apiKey: TEST_KEY } },
    });
    // No apiUrl is written; the key is bound to the origin it was verified against.
    expect(await readConfig()).toEqual({
      version: 1,
      activeProfile: 'default',
      profiles: { default: { credentialOrigin: api.url } },
    });
    expect(r.stderr).toContain('bu profilin adresinden (https://api.hadronbox.tr) farklı');
  });

  it('--with-api-key --json prints one document with the binding', async () => {
    await startApi();
    const r = keep(await hb(['login', '--with-api-key', '--json'], { readStdin: async () => TEST_KEY }));
    expect(JSON.parse(r.stdout)).toMatchObject({
      email: 'sen@ornek.com',
      profile: 'default',
      stored: true,
      credentialStore: 'file',
      credentialOrigin: api.url,
      profileApiUrl: 'https://api.hadronbox.tr',
      auth: { type: 'api_key', apiKeyName: 'dizüstü' },
    });
  });

  it('asks with a hidden prompt on a terminal, and asks before changing the profile address', async () => {
    await startApi();
    const ask = prompter({ secret: TEST_KEY, confirm: true });
    const r = keep(await hb(['login'], { prompter: ask }, { tty: true }));
    expect(r.code).toBe(0);
    expect(ask.asked).toEqual(['API anahtarı:', `"default" profili bundan sonra ${api.url} adresini kullansın mı?`]);
    expect(r.stderr).toContain('https://hadronbox.tr/panel/api-anahtarlari');
    expect(await readConfig()).toMatchObject({ profiles: { default: { apiUrl: api.url, credentialOrigin: api.url } } });
  });

  it('a "no" on the terminal keeps the profile address', async () => {
    await startApi();
    keep(await hb(['login'], { prompter: prompter({ secret: TEST_KEY, confirm: false }) }, { tty: true }));
    expect(await readConfig()).toEqual({
      version: 1,
      activeProfile: 'default',
      profiles: { default: { credentialOrigin: api.url } },
    });
  });

  it('after an env-URL login, a run without the variable does not send the key anywhere else', async () => {
    await startApi();
    keep(await hb(['login', '--with-api-key'], { readStdin: async () => TEST_KEY }));
    const seen: string[] = [];
    const r = keep(
      await runCli(['ls'], {
        env: { HADRONBOX_CONFIG_DIR: dir, HADRONBOX_CREDENTIAL_STORE: 'file' },
        fetch: async (url) => {
          seen.push(url);
          return new Response('{}');
        },
      }),
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('kod: CREDENTIAL_ORIGIN_MISMATCH');
    expect(r.stderr).toContain(`${api.url} için doğrulandı; https://api.hadronbox.tr adresine gönderilmedi`);
    expect(seen).toEqual([]);
    // With the variable the binding matches again.
    expect(keep(await hb(['ls'])).code).toBe(0);
  });

  it('reverse: profile points to X, login against the default URL → key bound to the default, never sent to X', async () => {
    await startApi();
    const { writeConfigFile } = await import('../src/config/config');
    await writeConfigFile(path.join(dir, 'config.json'), {
      version: 1,
      activeProfile: 'default',
      profiles: { default: { apiUrl: api.url } },
    });
    const prod: string[] = [];
    const login = keep(
      await runCli(['login', '--with-api-key'], {
        env: {
          HADRONBOX_CONFIG_DIR: dir,
          HADRONBOX_CREDENTIAL_STORE: 'file',
          HADRONBOX_API_URL: 'https://api.hadronbox.tr',
        },
        readStdin: async () => TEST_KEY,
        fetch: async (url) => {
          prod.push(url);
          return new Response(JSON.stringify({ data: (await import('./fake-api')).ME }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    );
    expect(login.code).toBe(0);
    expect(prod).toEqual(['https://api.hadronbox.tr/me']);
    expect(login.stderr).toContain(`bu profilin adresinden (${api.url}) farklı`);
    expect(await readConfig()).toMatchObject({
      profiles: { default: { apiUrl: api.url, credentialOrigin: 'https://api.hadronbox.tr' } },
    });
    const later = keep(
      await runCli(['ls'], { env: { HADRONBOX_CONFIG_DIR: dir, HADRONBOX_CREDENTIAL_STORE: 'file' } }),
    );
    expect(later.code).toBe(3);
    expect(later.stderr).toContain('kod: CREDENTIAL_ORIGIN_MISMATCH');
    expect(api.requests).toHaveLength(0);
  });

  it('HADRONBOX_API_KEY is verified but never stored', async () => {
    await startApi();
    const r = keep(await withKey(['login', '--json']));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ stored: false, credentialSource: 'env', email: 'sen@ornek.com' });
    expect(r.stderr).toContain('HADRONBOX_API_KEY ile yetkilisin; anahtar kaydedilmedi');
    await expect(stat(path.join(dir, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(dir, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(api.paths()).toEqual(['GET /me']);
  });

  it('without the flag and without a terminal → MISSING_API_KEY, stdin is not read', async () => {
    await startApi();
    let read = false;
    const r = keep(
      await hb(['login'], {
        readStdin: async () => {
          read = true;
          return TEST_KEY;
        },
      }),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('kod: MISSING_API_KEY');
    expect(r.stderr).toContain('--with-api-key');
    expect(read).toBe(false);
    expect(api.requests).toHaveLength(0);
  });

  it('empty stdin with --with-api-key → MISSING_API_KEY', async () => {
    await startApi();
    expect(keep(await hb(['login', '--with-api-key'], { readStdin: async () => '\n' })).code).toBe(2);
  });

  it('malformed key → INVALID_API_KEY (3) without a request; server-rejected key → 3 and nothing stored', async () => {
    await startApi();
    const local = keep(await hb(['login', '--with-api-key'], { readStdin: async () => 'hb_live_nope' }));
    expect(local.code).toBe(3);
    expect(api.requests).toHaveLength(0);
    const rejected = keep(await hb(['login', '--with-api-key'], { readStdin: async () => OTHER_KEY }));
    expect(rejected.code).toBe(3);
    expect(rejected.stderr).toContain('API anahtarı geçersiz veya süresi dolmuş.');
    await expect(stat(path.join(dir, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('unverified email (403) → exit 3 with guidance', async () => {
    await startApi({ meError: { status: 403, code: 'EMAIL_NOT_VERIFIED' } });
    const r = keep(await hb(['login', '--with-api-key', '--lang', 'en'], { readStdin: async () => TEST_KEY }));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Verify it on hadronbox.tr');
  });

  it('refuses the key on argv', async () => {
    await startApi();
    const r = keep(await hb(['login', '--api-key', TEST_KEY]));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('kod: API_KEY_IN_ARGV');
  });

  it('--profile makes that profile active', async () => {
    await startApi();
    keep(await hb(['login', '--with-api-key', '--profile', 'ci'], { readStdin: async () => TEST_KEY }));
    expect((await readConfig()).activeProfile).toBe('ci');
  });

  it('if the config cannot be written the stored key is rolled back (previous key restored)', async () => {
    await startApi();
    const { mkdir } = await import('node:fs/promises');
    const { ME } = await import('./fake-api');
    // First login stores OTHER_KEY normally.
    const first = keep(
      await runCli(['login', '--with-api-key'], {
        env: env(),
        readStdin: async () => OTHER_KEY,
        fetch: async () =>
          new Response(JSON.stringify({ data: ME }), { headers: { 'content-type': 'application/json' } }),
      }),
    );
    expect(first.code).toBe(0);
    // Second login: while /me is answered, config.json is replaced by a directory, so the final write fails.
    const second = keep(
      await runCli(['login', '--with-api-key'], {
        env: env(),
        readStdin: async () => TEST_KEY,
        fetch: async () => {
          await rm(path.join(dir, 'config.json'));
          await mkdir(path.join(dir, 'config.json'));
          return new Response(JSON.stringify({ data: ME }), { headers: { 'content-type': 'application/json' } });
        },
      }),
    );
    expect(second.code).toBe(1);
    expect(JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'))).toEqual({
      version: 1,
      profiles: { default: { apiKey: OTHER_KEY } },
    });
  });
});

describe('hb whoami / logout', () => {
  it('whoami after login shows email, plan, quota, key name and where the key came from', async () => {
    await startApi();
    api.machines.push(fakeMachine());
    keep(await hb(['login', '--with-api-key'], { readStdin: async () => TEST_KEY }));
    const r = keep(await hb(['whoami']));
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('sen@ornek.com');
    expect(r.stdout).toMatch(/Makineler:\s+1\/2/);
    expect(r.stdout).toContain('"dizüstü" · 0600 izinli dosya');
    const json = JSON.parse(keep(await hb(['whoami', '--json'])).stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ machines: { used: 1, limit: 2 }, credentialSource: 'file', plan: { tier: 'free' } });
  });

  it('whoami without a login → AUTH_REQUIRED (3)', async () => {
    await startApi();
    const r = keep(await hb(['whoami']));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('kod: AUTH_REQUIRED');
  });

  it('logout removes the stored key and points to the panel for revocation; a second logout says there is none', async () => {
    await startApi();
    keep(await hb(['login', '--with-api-key'], { readStdin: async () => TEST_KEY }));
    const first = keep(await hb(['logout']));
    expect(first.stdout).toContain('Çıkış yapıldı');
    expect(first.stderr).toContain('https://hadronbox.tr/panel/api-anahtarlari');
    const second = keep(await hb(['logout', '--json']));
    expect(JSON.parse(second.stdout)).toEqual({ profile: 'default', removed: false });
    expect(keep(await hb(['whoami'])).code).toBe(3);
  });

  it('logout warns when HADRONBOX_API_KEY is still set', async () => {
    await startApi();
    const r = keep(await withKey(['logout']));
    expect(r.stderr).toContain('HADRONBOX_API_KEY hâlâ tanımlı');
  });
});

describe('hb machines', () => {
  it('ls prints a table and the quota; --json returns machine objects', async () => {
    await startApi();
    api.machines.push(fakeMachine({ name: 'web' }), fakeMachine({ name: 'db', status: 'paused', size: 'small' }));
    const r = keep(await withKey(['machines', 'ls']));
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^AD\s+DURUM\s+BOYUT\s+OLUŞTURULMA$/);
    expect(lines[1]).toMatch(/^web\s+çalışıyor\s+medium\s+/);
    expect(lines[2]).toMatch(/^db\s+duraklatıldı\s+small\s+/);
    expect(lines[3]).toBe('Kota: 2/2 makine');
    const json = JSON.parse(keep(await withKey(['ls', '--json'])).stdout) as {
      machines: { name: string }[];
      quota: unknown;
    };
    expect(json.machines.map((m) => m.name)).toEqual(['web', 'db']);
    expect(json.quota).toEqual({ used: 2, limit: 2 });
  });

  it('ls follows pages and forwards --status', async () => {
    await startApi({ pageCap: 2 });
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) api.machines.push(fakeMachine({ name }));
    const json = JSON.parse(keep(await withKey(['machines', 'list', '--json'])).stdout) as { machines: unknown[] };
    expect(json.machines).toHaveLength(5);
    expect(api.paths().filter((p) => p.startsWith('GET /sandboxes'))).toHaveLength(3);
    keep(await withKey(['ls', '--status', 'paused']));
    expect(api.paths().at(-1)).toBe('GET /sandboxes?page=1&limit=100&status=paused');
  });

  it('ls with no machines shows the empty state', async () => {
    await startApi();
    const r = keep(await withKey(['ls', '--lang', 'en']));
    expect(r.stdout).toBe('You have no machines yet. Create one: hb machines create\nQuota: 0/2 machines\n');
  });

  it('create prints only the name on stdout and sends the options', async () => {
    await startApi();
    const r = keep(
      await withKey(['machines', 'create', 'web', '--size', 'large', '--template', 'minimal', '--no-auto-pause']),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('web\n');
    expect(r.stderr).toContain('Makine oluşturuldu: web (hazırlanıyor)');
    expect(api.requests.at(-1)?.body).toEqual({
      name: 'web',
      size: 'large',
      templateCode: 'minimal',
      autoPause: false,
    });
    const json = JSON.parse(keep(await withKey(['create', 'api', '--json'])).stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ name: 'api', status: 'creating' });
  });

  it('create without a name generates hb-<word>-NN and retries on NAME_TAKEN', async () => {
    await startApi({ takenGeneratedNames: 2 });
    const r = keep(await withKey(['create']));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^hb-[a-z]+-\d{2}$/);
    expect(api.requests.filter((q) => q.method === 'POST')).toHaveLength(3);
  });

  it('create validates locally and maps the plan limit', async () => {
    await startApi({ quotaFull: true });
    expect(keep(await withKey(['create', 'Web_1'])).stderr).toContain('kod: INVALID_MACHINE_NAME');
    const both = keep(await withKey(['create', 'web', '--template', 'a', '--snapshot', 'b']));
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('kod: CONFLICTING_OPTIONS');
    expect(keep(await withKey(['create', 'web', '--size', 'huge'])).code).toBe(2);
    const full = keep(await withKey(['create', 'web']));
    expect(full.code).toBe(5);
    expect(full.stderr).toBe('hata: Makine kotan doldu. Daha fazlası için Pro’ya yükselt.\nkod: PLAN_LIMIT_MACHINES\n');
  });

  it('pause / resume / stop --hard by name call the POST routes with the encoded id', async () => {
    await startApi();
    const machine = fakeMachine({ name: 'web' });
    api.machines.push(machine);
    const paused = keep(await withKey(['machines', 'pause', 'web']));
    expect(paused.stdout).toBe('Makine duraklatıldı: web\n');
    expect(api.paths()).toContain(`POST /sandboxes/${machine.sandboxId}/pause`);
    expect(keep(await withKey(['start', 'web'])).stdout).toBe('Makine devam ettirildi: web\n');
    expect(keep(await withKey(['stop', 'web', '--hard', '--yes', '--lang', 'en'])).stdout).toBe(
      'Machine stopped: web\n',
    );
    expect(api.paths()).toContain(`POST /sandboxes/${machine.sandboxId}/stop`);
  });

  it('409 INVALID_STATE says what state the machine is in, exit 6', async () => {
    await startApi();
    api.machines.push(fakeMachine({ name: 'web', status: 'paused' }), fakeMachine({ name: 'old', status: 'stopped' }));
    const already = keep(await withKey(['pause', 'web']));
    expect(already.code).toBe(6);
    expect(already.stderr).toBe('hata: Makine zaten duraklatılmış: web\nkod: INVALID_STATE\n');
    const stopped = keep(await withKey(['resume', 'old', '--json']));
    expect(stopped.code).toBe(6);
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      error: {
        code: 'INVALID_STATE',
        message: 'Durdurulmuş makine yeniden başlatılamaz: old. Yeni makine oluştur: hb create',
      },
    });
  });

  it('accepts an id; unknown names are MACHINE_NOT_FOUND (4); duplicate names are ambiguous (2)', async () => {
    await startApi();
    const a = fakeMachine({ name: 'twin' });
    const b = fakeMachine({ name: 'twin' });
    api.machines.push(a, b, fakeMachine({ name: 'twins' }));
    const byId = keep(await withKey(['status', a.sandboxId, '--json']));
    expect(JSON.parse(byId.stdout)).toMatchObject({ sandboxId: a.sandboxId });
    const missing = keep(await withKey(['status', 'nope']));
    expect(missing.code).toBe(4);
    expect(missing.stderr).toBe('hata: Makine bulunamadı: nope\nkod: MACHINE_NOT_FOUND\n');
    const missingId = keep(await withKey(['status', 'sbx_00000000-0000-4000-8000-999999999999']));
    expect(missingId.code).toBe(4);
    const twin = keep(await withKey(['pause', 'twin']));
    expect(twin.code).toBe(2);
    expect(twin.stderr).toContain(a.sandboxId);
    expect(twin.stderr).toContain(b.sandboxId);
    expect(api.paths().some((p) => p.endsWith('/pause'))).toBe(false);
  });

  it('a name never escapes its path segment', async () => {
    await startApi();
    const r = keep(await withKey(['rm', '../api-keys', '--yes']));
    expect(r.code).toBe(4);
    expect(api.paths().every((p) => p.startsWith('GET /sandboxes?'))).toBe(true);
  });

  it('rm: non-interactive needs --yes (exit 2, nothing deleted); --yes deletes', async () => {
    await startApi();
    const machine = fakeMachine({ name: 'web' });
    api.machines.push(machine);
    const refused = keep(await withKey(['rm', 'web']));
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('kod: CONFIRMATION_REQUIRED');
    expect(api.paths().some((p) => p.endsWith('/destroy'))).toBe(false);
    const done = keep(await withKey(['machines', 'delete', 'web', '-y']));
    expect(done.stdout).toBe('Makine silindi: web\n');
    expect(api.paths()).toContain(`POST /sandboxes/${machine.sandboxId}/destroy`);
  });

  it('stop --hard needs confirmation like rm (exit 2 without --yes, nothing sent; asks on a terminal)', async () => {
    await startApi();
    const machine = fakeMachine({ name: 'web' });
    api.machines.push(machine);
    const refused = keep(await withKey(['stop', 'web', '--hard']));
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('kod: CONFIRMATION_REQUIRED');
    expect(keep(await withKey(['machines', 'pause', 'web', '--hard'])).code).toBe(2);
    expect(api.paths().some((p) => p.endsWith('/stop'))).toBe(false);
    const no = prompter({ confirm: false });
    const kept = keep(await withKey(['stop', 'web', '--hard'], { prompter: no }, { tty: true }));
    expect(kept.code).toBe(0);
    expect(no.asked[0]).toBe(
      '"web" makinesi tamamen durdurulsun mu? Durdurulan makine yeniden başlatılamaz, yalnız silinebilir.',
    );
    expect(api.paths().some((p) => p.endsWith('/stop'))).toBe(false);
    keep(await withKey(['stop', 'web', '--hard'], { prompter: prompter({ confirm: true }) }, { tty: true }));
    expect(api.paths()).toContain(`POST /sandboxes/${machine.sandboxId}/stop`);
    // A plain stop (= pause) does not ask.
    expect(keep(await withKey(['stop', 'nope'])).code).toBe(4);
    const help = keep(await hb(['machines', 'pause', '--help']));
    expect(help.stdout).toContain('yeniden başlatılamaz, yalnız silinebilir');
    expect(keep(await hb(['machines', 'resume', '--help'])).stdout).toContain('durdurulmuş makine başlatılamaz');
  });

  it('name resolution follows pages sorted by name', async () => {
    await startApi({ pageCap: 2 });
    for (const name of ['web-a', 'web-b', 'web-c', 'web-d']) api.machines.push(fakeMachine({ name }));
    api.machines.push(fakeMachine({ name: 'web' }));
    const r = keep(await withKey(['status', 'web', '--json']));
    expect(r.code).toBe(0);
    const searches = api.paths().filter((p) => p.startsWith('GET /sandboxes?'));
    expect(searches).toHaveLength(3);
    expect(searches[0]).toBe('GET /sandboxes?search=web&limit=100&page=1&sortBy=name&sortOrder=asc');
  });

  it('rm on a terminal asks (e/H): no keeps the machine, yes deletes', async () => {
    await startApi();
    api.machines.push(fakeMachine({ name: 'web' }));
    const no = prompter({ confirm: false });
    const kept = keep(await withKey(['rm', 'web'], { prompter: no }, { tty: true }));
    expect(kept.code).toBe(0);
    expect(no.asked[0]).toBe('"web" makinesi silinsin mi? Bu işlem geri alınamaz.');
    expect(kept.stderr).toContain('Silme iptal edildi.');
    expect(api.machines).toHaveLength(1);
    const yes = prompter({ confirm: true });
    keep(await withKey(['rm', 'web'], { prompter: yes }, { tty: true }));
    expect(api.machines).toHaveLength(0);
  });

  it('status shows state, resources, idle time and auto-pause', async () => {
    await startApi();
    api.machines.push(fakeMachine({ name: 'web' }));
    const r = keep(await withKey(['machines', 'status', 'web']));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Ad:\s+web$/m);
    expect(r.stdout).toMatch(/^Durum:\s+çalışıyor$/m);
    expect(r.stdout).toMatch(/^Kaynaklar:\s+medium · 2 vCPU · 4 GiB RAM · 20 GiB disk$/m);
    expect(r.stdout).toMatch(/^Son etkinlik:\s+.+\(10 dk önce\)$/m);
    expect(r.stdout).toMatch(/^Otomatik duraklatma:\s+20 dk sonra$/m);
    expect(r.stdout).toMatch(/^Ortam değişkenleri:\s+NODE_ENV$/m);
    const json = JSON.parse(keep(await withKey(['status', 'web', '--json'])).stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ name: 'web', idleMinutes: 10, autoPauseInMinutes: 20, envKeys: ['NODE_ENV'] });
  });

  it('missing machine argument → MISSING_ARGUMENT (2); help lists examples and shortcuts', async () => {
    await startApi();
    expect(keep(await withKey(['pause'])).stderr).toContain('kod: MISSING_ARGUMENT');
    const help = keep(await hb(['machines', '--help']));
    expect(help.stdout).toContain('hb ls · hb create');
    const rootHelp = keep(await hb(['--help']));
    expect(rootHelp.stdout).toMatch(/^\s+login\s/m);
    expect(rootHelp.stdout).toMatch(/^\s+machines\s/m);
    expect(rootHelp.stdout).not.toMatch(/^\s+ls\s/m);
  });

  it('a revoked key during a command maps to exit 3', async () => {
    await startApi({ validKeys: [OTHER_KEY] });
    const r = keep(await withKey(['ls']));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('kod: INVALID_API_KEY');
  });
});
