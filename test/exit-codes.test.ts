import { describe, expect, it } from 'vitest';
import { EXIT_CODE_TABLE, ExitCode, remoteExitCode } from '../src/errors/exit-codes';
import { CLI_ERRORS } from '../src/errors/messages';

describe('exit code contract', () => {
  it('has fixed values (public API: never renumber)', () => {
    expect(ExitCode).toEqual({
      OK: 0,
      GENERAL: 1,
      USAGE: 2,
      AUTH: 3,
      NOT_FOUND: 4,
      PLAN_LIMIT: 5,
      INVALID_STATE: 6,
      NETWORK: 7,
      CLI_UPGRADE: 8,
      REMOTE_NOT_STARTED: 125,
      INTERRUPTED: 130,
    });
  });

  it('documents every code exactly once in both languages', () => {
    expect(EXIT_CODE_TABLE.map((row) => row.code)).toEqual(Object.values(ExitCode));
    for (const row of EXIT_CODE_TABLE) {
      expect(ExitCode[row.name]).toBe(row.code);
      expect(row.description.tr.length).toBeGreaterThan(0);
      expect(row.description.en.length).toBeGreaterThan(0);
    }
  });

  it('every CLI error code maps to a documented exit code and has tr+en copy', () => {
    const documented = new Set<number>(Object.values(ExitCode));
    for (const [code, spec] of Object.entries(CLI_ERRORS)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(documented.has(spec.exit)).toBe(true);
      expect(spec.tr).not.toBe(spec.en);
    }
  });
});

describe('remoteExitCode', () => {
  it('passes remote codes through unchanged, including values that collide with CLI codes', () => {
    for (const code of [0, 1, 2, 3, 7, 42, 125, 127, 255]) {
      expect(remoteExitCode(code, null)).toBe(code);
    }
  });

  it('maps a signal death to 128 + signal number', () => {
    expect(remoteExitCode(null, 'SIGKILL')).toBe(137);
    expect(remoteExitCode(null, 'SIGTERM')).toBe(143);
    expect(remoteExitCode(null, 2)).toBe(130);
  });

  it('falls back to GENERAL for impossible values', () => {
    expect(remoteExitCode(null, null)).toBe(1);
    expect(remoteExitCode(300, null)).toBe(1);
    expect(remoteExitCode(-1, null)).toBe(1);
    expect(remoteExitCode(null, 'SIGNOPE')).toBe(1);
  });
});
