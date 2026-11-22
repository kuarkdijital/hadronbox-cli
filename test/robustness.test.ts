import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands';
import type { CommandSpec } from '../src/commands/types';
import { cliError } from '../src/errors/cli-error';
import { CLI_ERRORS } from '../src/errors/messages';
import { localize } from '../src/i18n';
import { Cli, type MainIO } from '../src/main';
import { Output } from '../src/output';
import { checkNodeVersion, earlyLang, loadFailure } from '../src/preflight';
import { installProcessHandlers, type ProcessEvents } from '../src/process-handlers';
import { MemoryWriter, TEST_KEY, runCli } from './helpers';

function cliFor(argv: string[], commands?: readonly CommandSpec[]) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const io: MainIO = { argv, env: {}, stdout, stderr, platform: 'linux', homedir: '/h', commands };
  return { cli: new Cli(io), stdout, stderr };
}

describe('Output: one JSON document per run', () => {
  it('drops a second jsonValue', () => {
    const stdout = new MemoryWriter();
    const out = new Output({ stdout, stderr: new MemoryWriter(), json: true, color: false, lang: 'tr', debug: false });
    out.jsonValue({ a: 1 });
    out.jsonValue({ b: 2 });
    expect(JSON.parse(stdout.text)).toEqual({ a: 1 });
  });

  it('an error after the JSON result goes to stderr in human form', () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const out = new Output({ stdout, stderr, json: true, color: false, lang: 'en', debug: false });
    out.result('x', { ok: true });
    out.error(cliError('INTERRUPTED'));
    expect(JSON.parse(stdout.text)).toEqual({ ok: true });
    expect(stderr.text).toBe('error: Interrupted.\ncode: INTERRUPTED\n');
  });
});

describe('process handlers', () => {
  function setup(argv: string[], commands?: readonly CommandSpec[]) {
    const { cli, stdout, stderr } = cliFor(argv, commands);
    const proc = new EventEmitter();
    const exits: number[] = [];
    installProcessHandlers(proc as unknown as ProcessEvents, cli, (code) => exits.push(code));
    return { cli, proc, exits, stdout, stderr };
  }

  it('SIGINT with --json writes one INTERRUPTED document and exits 130', () => {
    const { proc, exits, stdout, stderr } = setup(['version', '--json']);
    proc.emit('SIGINT');
    expect(exits).toEqual([130]);
    expect(JSON.parse(stdout.text)).toEqual({
      error: { code: 'INTERRUPTED', message: 'İptal edildi.' },
      exitCode: 130,
    });
    expect(stderr.text).toBe('');
  });

  it('SIGINT in human mode: two stderr lines, 130', () => {
    const { proc, exits, stderr } = setup(['version', '--lang', 'en']);
    proc.emit('SIGINT');
    expect(exits).toEqual([130]);
    expect(stderr.text).toBe('error: Interrupted.\ncode: INTERRUPTED\n');
  });

  it('uncaught exception / unhandled rejection with --json → INTERNAL document, exit 1, redacted debug stack', () => {
    const { proc, exits, stdout, stderr } = setup(['version', '--json', '--debug']);
    proc.emit('uncaughtException', new Error(`boom ${TEST_KEY}`));
    proc.emit('unhandledRejection', `reason ${TEST_KEY}`);
    expect(exits).toEqual([1, 1]);
    expect(JSON.parse(stdout.text)).toMatchObject({ error: { code: 'INTERNAL' }, exitCode: 1 });
    expect(stderr.text).toContain('boom hb_live_••••a1a1');
    expect(stdout.text + stderr.text).not.toContain(TEST_KEY);
  });

  it('SIGINT after a JSON result keeps stdout a single document', async () => {
    const { cli, proc, stdout } = setup(['version', '--json']);
    expect(await cli.run()).toBe(0);
    proc.emit('SIGINT');
    expect(() => JSON.parse(stdout.text)).not.toThrow();
  });
});

describe('preflight', () => {
  it('accepts Node 20+', () => {
    expect(checkNodeVersion([], {}, '20.0.0')).toBeNull();
    expect(checkNodeVersion([], {}, '22.23.5')).toBeNull();
  });

  it('old Node: localized two lines, exit 1, same text as the catalog', () => {
    const tr = checkNodeVersion(['ls'], {}, '18.19.0');
    const expected = localize(CLI_ERRORS.UNSUPPORTED_NODE, { required: 20, current: '18.19.0' });
    expect(tr).toEqual({ exitCode: 1, stdout: '', stderr: `hata: ${expected.tr}\nkod: UNSUPPORTED_NODE\n` });
    const en = checkNodeVersion(['--lang', 'en'], {}, '16.0.0');
    expect(en?.stderr).toContain('requires Node.js 20');
  });

  it('old Node with --json: one JSON document on stdout', () => {
    const failure = checkNodeVersion(['ls', '--json'], { HADRONBOX_LANG: 'en' }, '18.0.0');
    expect(failure?.stderr).toBe('');
    expect(JSON.parse(failure?.stdout ?? '')).toEqual({
      error: { code: 'UNSUPPORTED_NODE', message: 'hadronbox requires Node.js 20 or newer (current 18.0.0).' },
      exitCode: 1,
    });
  });

  it('load failure follows the INTERNAL contract', () => {
    const failure = loadFailure(['--json'], {});
    expect(JSON.parse(failure.stdout)).toEqual({
      error: { code: 'INTERNAL', message: CLI_ERRORS.INTERNAL.tr },
      exitCode: 1,
    });
  });

  it('earlyLang: last --lang wins, ignores arguments after --', () => {
    expect(earlyLang(['--lang', 'en', '--lang=tr'], {})).toBe('tr');
    expect(earlyLang(['--', '--lang', 'en'], {})).toBe('tr');
    expect(earlyLang([], { HADRONBOX_LANG: 'en' })).toBe('en');
  });
});

describe('exec/sh exit code 125', () => {
  const remote = (behaviour: 'auth' | 'interrupt' | 'remote'): CommandSpec => ({
    name: 'exec',
    summary: { tr: 'Çalıştır', en: 'Run' },
    usage: 'exec <ad> -- <komut…>',
    examples: ['hb exec box -- ls'],
    passthroughExit: true,
    async run() {
      if (behaviour === 'auth') throw cliError('AUTH_REQUIRED');
      if (behaviour === 'interrupt') throw cliError('INTERRUPTED');
      return 3;
    },
  });

  it('a CLI failure before the remote start exits 125 and keeps code + class', async () => {
    const r = await runCli(['exec', 'box', '--json', '--', 'ls'], { commands: [...COMMANDS, remote('auth')] });
    expect(r.code).toBe(125);
    expect(JSON.parse(r.stdout)).toMatchObject({
      error: { code: 'AUTH_REQUIRED', details: { cliExitCode: 3 } },
      exitCode: 125,
    });
  });

  it('Ctrl+C before the remote start stays 130; a remote code passes through', async () => {
    expect((await runCli(['exec', 'box'], { commands: [...COMMANDS, remote('interrupt')] })).code).toBe(130);
    const passed = await runCli(['exec', 'box'], { commands: [...COMMANDS, remote('remote')] });
    expect(passed).toEqual({ code: 3, stdout: '', stderr: '' });
  });

  it('other commands keep the normal table', async () => {
    const plain: CommandSpec = { ...remote('auth'), name: 'plain', passthroughExit: false };
    expect((await runCli(['plain'], { commands: [...COMMANDS, plain] })).code).toBe(3);
  });
});

describe('main: argument edge cases (nits)', () => {
  it('--json=1 still answers in JSON', async () => {
    const r = await runCli(['--json=1']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: 'OPTION_TAKES_NO_VALUE' } });
  });

  it('--lang --json still answers in JSON', async () => {
    const r = await runCli(['--lang', '--json']);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: 'MISSING_OPTION_VALUE' }, exitCode: 2 });
  });

  it('stray arguments after -- without a command are rejected', async () => {
    const r = await runCli(['--', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('kod: UNEXPECTED_ARGUMENT');
  });

  it('an invalid --profile is rejected even when the command does not load config', async () => {
    const r = await runCli(['version', '--profile', 'Bad']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('kod: INVALID_PROFILE');
  });

  it('control characters in echoed input are stripped', async () => {
    const r = await runCli(['no\u001b[31mpe\u202e']);
    expect(r.stderr).not.toMatch(/[\u001b\u202e]/);
    expect(r.stderr).toContain('no [31mpe');
  });
});
