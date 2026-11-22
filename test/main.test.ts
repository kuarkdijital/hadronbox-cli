import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands';
import type { CommandSpec } from '../src/commands/types';
import { cliError } from '../src/errors/cli-error';
import { isRecord } from '../src/json';
import { CLI_VERSION } from '../src/version';
import { TEST_KEY, jsonResponse, runCli } from './helpers';

/** A throwaway command that exercises the services the way the real commands do. */
const probe: CommandSpec = {
  name: 'probe',
  summary: { tr: 'Deneme', en: 'Probe' },
  usage: 'probe [ad]',
  examples: ['hb probe'],
  maxPositionals: 1,
  options: { force: { type: 'boolean', description: { tr: 'Zorla', en: 'Force' } } },
  async run(ctx) {
    const api = await ctx.services.api();
    const me = await api.get('/me', (v) => {
      if (isRecord(v) && typeof v.email === 'string') return v.email;
      throw new Error('shape');
    });
    ctx.out.result(me, { email: me, force: ctx.args.values.force === true, arg: ctx.args.positionals[0] ?? null });
  },
};
const group: CommandSpec = {
  name: 'machines',
  aliases: ['m'],
  summary: { tr: 'Makineler', en: 'Machines' },
  usage: 'machines <alt komut>',
  examples: ['hb machines ls'],
  subcommands: [
    {
      name: 'ls',
      aliases: ['list'],
      summary: { tr: 'Listeler', en: 'Lists' },
      usage: 'machines ls',
      examples: ['hb machines ls'],
      maxPositionals: 0,
      async run(ctx) {
        ctx.out.data('listed');
      },
    },
  ],
};
const failing: CommandSpec = {
  name: 'boom',
  summary: { tr: 'Patlar', en: 'Explodes' },
  usage: 'boom',
  examples: ['hb boom'],
  async run() {
    throw new Error(`internal detail ${TEST_KEY}`);
  },
};
const conflict: CommandSpec = {
  name: 'conflict',
  summary: { tr: 'Çakışma', en: 'Conflict' },
  usage: 'conflict',
  examples: ['hb conflict'],
  async run() {
    throw cliError('AUTH_REQUIRED');
  },
};
const commands = [...COMMANDS, probe, group, failing, conflict];

describe('main: help, version, usage', () => {
  it('--version prints the bare version on stdout', async () => {
    const r = await runCli(['--version']);
    expect(r).toEqual({ code: 0, stdout: `${CLI_VERSION}\n`, stderr: '' });
    expect((await runCli(['-v'])).stdout).toBe(`${CLI_VERSION}\n`);
  });

  it('--version --json is one JSON document', async () => {
    const r = await runCli(['--version', '--json']);
    expect(JSON.parse(r.stdout)).toMatchObject({ version: CLI_VERSION });
  });

  it('no arguments and --help print Turkish root help on stdout, exit 0', async () => {
    for (const argv of [[], ['--help'], ['help'], ['-h']]) {
      const r = await runCli(argv);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Kullanım:');
      expect(r.stdout).toContain('hb help exit-codes');
      expect(r.stderr).toBe('');
    }
  });

  it('--lang en and HADRONBOX_LANG=en switch to English', async () => {
    expect((await runCli(['--help', '--lang', 'en'])).stdout).toContain('Usage:');
    expect((await runCli(['--help'], { env: { HADRONBOX_LANG: 'en' } })).stdout).toContain('Usage:');
    expect((await runCli(['--help', '--lang=tr'], { env: { HADRONBOX_LANG: 'en' } })).stdout).toContain('Kullanım:');
  });

  it('invalid HADRONBOX_LANG is a usage error', async () => {
    const r = await runCli(['version'], { env: { HADRONBOX_LANG: 'de' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('kod: INVALID_ENV_VALUE');
  });

  it('help exit-codes prints the contract table (human and JSON)', async () => {
    const human = await runCli(['help', 'exit-codes']);
    expect(human.code).toBe(0);
    for (const n of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '125', '130']) {
      expect(human.stdout).toMatch(new RegExp(`^  ${n} `, 'm'));
    }
    const json = JSON.parse((await runCli(['help', 'exit-codes', '--json'])).stdout) as {
      exitCodes: { code: number }[];
    };
    expect(json.exitCodes.map((r) => r.code)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 125, 130]);
  });

  it('command help via --help and help <cmd>, with examples and aliases', async () => {
    const a = await runCli(['machines', 'ls', '--help'], { commands });
    const b = await runCli(['help', 'm', 'list'], { commands });
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain('Örnekler:');
    expect(a.stdout).toContain('Takma adlar: list');
  });

  it('unknown command: exit 2, two stderr lines, suggestion', async () => {
    const r = await runCli(['probr'], { commands });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      'hata: Bilinmeyen komut: probr. Bunu mu demek istedin: probe? Komutlar için: hb --help\nkod: UNKNOWN_COMMAND\n',
    );
  });

  it('unknown subcommand and missing subcommand are usage errors', async () => {
    expect((await runCli(['machines', 'lx'], { commands })).stderr).toContain('machines lx');
    const missing = await runCli(['machines'], { commands });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('kod: MISSING_COMMAND');
  });

  it('unknown option / extra positional: exit 2', async () => {
    expect((await runCli(['version', '--nope'])).code).toBe(2);
    expect((await runCli(['version', 'extra'])).stderr).toContain('kod: UNEXPECTED_ARGUMENT');
  });

  it('--json errors go to stdout as {error:{code,message},exitCode}, nothing on stderr', async () => {
    const r = await runCli(['nope', '--json', '--lang', 'en']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({
      error: { code: 'UNKNOWN_COMMAND', message: 'Unknown command: nope. See: hb --help' },
      exitCode: 2,
    });
  });

  it('rejects --api-key on argv (exit 2) and never echoes the key', async () => {
    const r = await runCli(['probe', '--api-key', TEST_KEY], { commands });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('kod: API_KEY_IN_ARGV');
    expect(r.stdout + r.stderr).not.toContain(TEST_KEY);
  });

  it('a CliError from a command keeps its code and exit code', async () => {
    const r = await runCli(['conflict', '--lang', 'en'], { commands });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(
      'error: Not logged in. Set the HADRONBOX_API_KEY environment variable or run "hb login".\ncode: AUTH_REQUIRED\n',
    );
  });

  it('unexpected exceptions become INTERNAL (exit 1) without leaking details', async () => {
    const r = await runCli(['boom'], { commands });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('kod: INTERNAL');
    expect(r.stderr).not.toContain('internal detail');
    const debug = await runCli(['boom', '--debug'], { commands });
    expect(debug.stderr).toContain('internal detail hb_live_••••a1a1');
    expect(debug.stderr).not.toContain(TEST_KEY);
  });

  it('colors only on a TTY and never with NO_COLOR / --no-color', async () => {
    const { MemoryWriter } = await import('./helpers');
    const { main } = await import('../src/main');
    const run = async (env: Record<string, string>, argv: string[]) => {
      const stderr = new MemoryWriter(true);
      await main({ argv, env, stdout: new MemoryWriter(), stderr, platform: 'linux', homedir: '/h' });
      return stderr.text;
    };
    expect(await run({}, ['nope'])).toContain('\u001b[31m');
    expect(await run({ NO_COLOR: '1' }, ['nope'])).not.toContain('\u001b[');
    expect(await run({}, ['nope', '--no-color'])).not.toContain('\u001b[');
    expect(await run({ CI: 'true' }, ['nope'])).not.toContain('\u001b[');
  });
});

describe('main: services (config, auth, HTTP)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hb-main-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses HADRONBOX_API_KEY and HADRONBOX_API_URL; options after the command parse', async () => {
    const seen: string[] = [];
    const r = await runCli(['probe', 'box1', '--force', '--json'], {
      commands,
      env: { HADRONBOX_CONFIG_DIR: dir, HADRONBOX_API_KEY: TEST_KEY, HADRONBOX_API_URL: 'https://staging.example.tr' },
      fetch: async (url, init) => {
        seen.push(url, String((init.headers as Record<string, string>).authorization));
        return jsonResponse(200, { data: { email: 'sen@ornek.com' } });
      },
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ email: 'sen@ornek.com', force: true, arg: 'box1' });
    expect(seen).toEqual(['https://staging.example.tr/me', `Bearer ${TEST_KEY}`]);
  });

  it('not logged in → exit 3 before any request', async () => {
    let called = false;
    const r = await runCli(['probe'], {
      commands,
      platform: 'win32',
      env: { HADRONBOX_CONFIG_DIR: dir },
      fetch: async () => {
        called = true;
        return jsonResponse(200, {});
      },
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('kod: AUTH_REQUIRED');
    expect(called).toBe(false);
  });

  it('maps API errors to exit codes end to end (402 → 5, JSON on stdout)', async () => {
    const r = await runCli(['probe', '--json'], {
      commands,
      env: { HADRONBOX_CONFIG_DIR: dir, HADRONBOX_API_KEY: TEST_KEY },
      fetch: async () => jsonResponse(402, { statusCode: 402, code: 'PLAN_LIMIT_MACHINES', message: 'x' }),
    });
    expect(r.code).toBe(5);
    expect(JSON.parse(r.stdout)).toMatchObject({
      error: { code: 'PLAN_LIMIT_MACHINES', message: 'Makine kotan doldu. Daha fazlası için Pro’ya yükselt.' },
      exitCode: 5,
    });
  });

  it('network failure → exit 7', async () => {
    const r = await runCli(['probe'], {
      commands,
      env: { HADRONBOX_CONFIG_DIR: dir, HADRONBOX_API_KEY: TEST_KEY },
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(r.code).toBe(7);
    expect(r.stderr).toContain('kod: NETWORK_ERROR');
  });

  it('insecure HADRONBOX_API_URL is refused before the key is sent', async () => {
    let called = false;
    const r = await runCli(['probe'], {
      commands,
      env: { HADRONBOX_CONFIG_DIR: dir, HADRONBOX_API_KEY: TEST_KEY, HADRONBOX_API_URL: 'http://api.example.tr' },
      fetch: async () => {
        called = true;
        return jsonResponse(200, {});
      },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('kod: INVALID_API_URL');
    expect(called).toBe(false);
  });

  it('the API key never appears in stdout/stderr (pattern test)', async () => {
    const outputs: string[] = [];
    for (const argv of [['probe', '--debug'], ['probe', '--json', '--debug'], ['help'], ['--version']]) {
      const r = await runCli(argv, {
        commands,
        env: { HADRONBOX_CONFIG_DIR: dir, HADRONBOX_API_KEY: TEST_KEY },
        fetch: async () => jsonResponse(400, { statusCode: 400, code: 'VALIDATION', message: `bad key ${TEST_KEY}` }),
      });
      outputs.push(r.stdout, r.stderr);
    }
    expect(outputs.join('\n')).not.toMatch(/hb_live_[0-9a-f]{8,}/);
  });
});
