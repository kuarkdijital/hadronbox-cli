import { EventEmitter } from 'node:events';
import { chown, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseMachine } from '../src/api/machines';
import { generateMachineName, idleInfo } from '../src/commands/machines';
import type { CommandSpec } from '../src/commands/types';
import { COMMANDS } from '../src/commands';
import { ensurePrivateDir } from '../src/config/secure-file';
import { cliError, toRemoteSetupError } from '../src/errors/cli-error';
import { formatMinutes, renderTable } from '../src/format';
import { isYes, readAllStdin, readLine, type TtyInput } from '../src/prompt';
import { maskUrlCredentials } from '../src/redact';
import { fakeMachine } from './fake-api';
import { MemoryWriter, runCli } from './helpers';

class FakeTty extends EventEmitter implements TtyInput {
  readonly isTTY = true;
  raw: boolean[] = [];
  setRawMode(mode: boolean) {
    this.raw.push(mode);
  }
  setEncoding() {}
  resume() {}
  pause() {}
  type(text: string) {
    this.emit('data', text);
  }
}

describe('prompt', () => {
  it('secret input is not echoed; backspace edits; raw mode is restored', async () => {
    const input = new FakeTty();
    const output = new MemoryWriter();
    const pending = readLine(input, output, false);
    input.type('hb_x');
    input.type('\u007fy\r');
    await expect(pending).resolves.toBe('hb_y');
    expect(output.text).toBe('\n');
    expect(input.raw).toEqual([true, false]);
  });

  it('Ctrl+C rejects with INTERRUPTED', async () => {
    const input = new FakeTty();
    const pending = readLine(input, new MemoryWriter(), true);
    input.type('ab\u0003');
    await expect(pending).rejects.toMatchObject({ code: 'INTERRUPTED', exitCode: 130 });
  });

  it('isYes accepts e/evet/y/yes only', () => {
    expect(['e', 'Evet', 'y', 'YES', ' e '].every(isYes)).toBe(true);
    expect(['', 'h', 'no', 'hayır', 'ee'].some(isYes)).toBe(false);
  });

  it('readAllStdin reads a pipe and bounds its size', async () => {
    await expect(readAllStdin(Readable.from(['hb_', 'live\n']))).resolves.toBe('hb_live\n');
    await expect(readAllStdin(Readable.from(['x'.repeat(70_000)]))).rejects.toMatchObject({ code: 'INVALID_API_KEY' });
  });
});

describe('machines helpers', () => {
  it('generated names match the API name rule', () => {
    for (let i = 0; i < 50; i += 1) expect(generateMachineName()).toMatch(/^hb-[a-z]+-\d{2}$/);
    expect(generateMachineName(() => 0)).toBe('hb-ajan-01');
  });

  it('idleInfo: idle minutes and time to auto-pause only for running + autoPause', () => {
    const now = Date.parse('2026-11-22T12:00:00Z');
    const base = { lastActiveAt: '2026-11-22T11:45:00Z', idleTimeoutMinutes: 30 };
    const parse = (o: object) => parseMachine({ ...fakeMachine(base), ...o, source: { type: 'template', label: 'x' } });
    expect(idleInfo(parse({}), now)).toEqual({ idleMinutes: 15, autoPauseInMinutes: 15 });
    expect(idleInfo(parse({ status: 'paused' }), now)).toEqual({ idleMinutes: 15, autoPauseInMinutes: null });
    expect(idleInfo(parse({ autoPause: false }), now).autoPauseInMinutes).toBeNull();
    expect(idleInfo(parse({ lastActiveAt: null }), now)).toEqual({ idleMinutes: null, autoPauseInMinutes: null });
  });

  it('parseMachine rejects a wrong shape', () => {
    expect(() => parseMachine({ name: 'x' })).toThrow();
    expect(() => parseMachine({ ...fakeMachine(), envKeys: [1] })).toThrow(/envKeys/);
  });

  it('renderTable aligns columns and strips control characters', () => {
    expect(
      renderTable(
        ['A', 'BB'],
        [
          ['x\u001b[31m', 'y'],
          ['long', 'z'],
        ],
      ),
    ).toBe('A       BB\nx [31m  y\nlong    z');
  });

  it('formatMinutes', () => {
    expect(formatMinutes(45, 'tr')).toBe('45 dk');
    expect(formatMinutes(125, 'tr')).toBe('2 sa 5 dk');
    expect(formatMinutes(120, 'en')).toBe('2 h');
  });
});

describe('exec/sh failure details', () => {
  it('before the start: reason not_started, remoteStarted false', () => {
    const error = toRemoteSetupError(cliError('AUTH_REQUIRED'));
    expect(error.exitCode).toBe(125);
    expect(error.details).toMatchObject({ cliExitCode: 3, remoteStarted: false, reason: 'not_started' });
  });

  it('after the start: session_lost; --timeout: timeout; Ctrl+C stays 130', () => {
    expect(toRemoteSetupError(cliError('NETWORK_ERROR', { host: 'x' }), true).details).toMatchObject({
      remoteStarted: true,
      reason: 'session_lost',
      cliExitCode: 7,
    });
    expect(toRemoteSetupError(cliError('TIMEOUT', { seconds: 60 }), true).details).toMatchObject({
      reason: 'timeout',
      remoteStarted: true,
    });
    expect(toRemoteSetupError(cliError('INTERRUPTED'), true).exitCode).toBe(130);
  });

  it('ctx.markRemoteStarted() flows into the 125 error of a passthrough command', async () => {
    const exec: CommandSpec = {
      name: 'exec',
      summary: { tr: 'x', en: 'x' },
      usage: 'exec',
      examples: ['hb exec'],
      passthroughExit: true,
      async run(ctx) {
        ctx.markRemoteStarted();
        throw cliError('TIMEOUT', { seconds: 60 });
      },
    };
    const r = await runCli(['exec', '--json'], { commands: [...COMMANDS, exec] });
    expect(r.code).toBe(125);
    expect(JSON.parse(r.stdout)).toMatchObject({
      error: { code: 'TIMEOUT', details: { remoteStarted: true, reason: 'timeout', cliExitCode: 7 } },
      exitCode: 125,
    });
  });
});

describe('re-review follow-ups', () => {
  it('r2: URL credentials are masked up to the last @', () => {
    expect(maskUrlCredentials('https://u:p@ss@host.tr/x')).toBe('https://***@host.tr/x');
    expect(maskUrlCredentials('https://host.tr/a@b')).toBe('https://host.tr/a@b');
  });

  it.runIf(typeof process.getuid === 'function' && process.getuid() !== 0)(
    'root-owned dir hint (non-root)',
    async () => {
      // Needs a root-owned directory; /root or / qualifies on most systems.
      const error = await ensurePrivateDir('/').catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'INSECURE_PATH' });
      expect((error as Error).message).toContain('sudo chown');
    },
  );

  it.runIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'a directory owned by another user still fails with the generic message',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'hb-own-'));
      const other = path.join(dir, 'x');
      await mkdir(other, { mode: 0o700 });
      await chown(other, 4242, 4242);
      const error = await ensurePrivateDir(other).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'INSECURE_PATH' });
      expect((error as Error).message).not.toContain('sudo chown');
      await rm(dir, { recursive: true, force: true });
    },
  );
});

describe('secret prompt input', () => {
  it('arrow keys and other escape sequences do not end up in a secret', async () => {
    const input = new FakeTty();
    const pending = readLine(input, new MemoryWriter(), false);
    input.type('hb\u001b[A_\u001bOPx\u001b[1;5Cy\r');
    await expect(pending).resolves.toBe('hb_xy');
  });
});
