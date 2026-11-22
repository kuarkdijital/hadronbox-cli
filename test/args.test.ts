import { describe, expect, it } from 'vitest';
import { assertNoSecretsInArgv, parseArguments, type OptionSpecs } from '../src/args/parse';
import { CliError } from '../src/errors/cli-error';
import { ExitCode } from '../src/errors/exit-codes';

const specs: OptionSpecs = {
  json: { type: 'boolean', description: { tr: '', en: '' } },
  yes: { type: 'boolean', short: 'y', description: { tr: '', en: '' } },
  lang: { type: 'string', choices: ['tr', 'en'], description: { tr: '', en: '' } },
  name: { type: 'string', description: { tr: '', en: '' } },
};

function expectUsage(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    const e = error as CliError;
    expect(e.code).toBe(code);
    expect(e.exitCode).toBe(ExitCode.USAGE);
    return;
  }
  throw new Error('expected a usage error');
}

describe('parseArguments', () => {
  it('parses booleans, short flags, strings, inline values and positionals', () => {
    const parsed = parseArguments(['box1', '-y', '--json', '--lang=en', '--name', 'web'], specs);
    expect(parsed.values).toEqual({ yes: true, json: true, lang: 'en', name: 'web' });
    expect(parsed.positionals).toEqual(['box1']);
    expect(parsed.rest).toEqual([]);
  });

  it('keeps everything after -- untouched (remote command)', () => {
    const parsed = parseArguments(['box1', '--json', '--', 'ls', '-la', '--json'], specs);
    expect(parsed.positionals).toEqual(['box1']);
    expect(parsed.rest).toEqual(['ls', '-la', '--json']);
    expect(parsed.values.json).toBe(true);
  });

  it('drops command path tokens by index', () => {
    const parsed = parseArguments(['machines', 'rm', 'box1'], specs, { skipIndexes: new Set([0, 1]) });
    expect(parsed.positionals).toEqual(['box1']);
  });

  it('rejects unknown long and short options', () => {
    expectUsage(() => parseArguments(['--nope'], specs), 'UNKNOWN_OPTION');
    expectUsage(() => parseArguments(['-x'], specs), 'UNKNOWN_OPTION');
  });

  it('rejects a string option without value or swallowing the next flag', () => {
    expectUsage(() => parseArguments(['--name'], specs), 'MISSING_OPTION_VALUE');
    expectUsage(() => parseArguments(['--name', '--json'], specs), 'MISSING_OPTION_VALUE');
  });

  it('accepts an inline value that starts with a dash', () => {
    expect(parseArguments(['--name=-x'], specs).values.name).toBe('-x');
  });

  it('rejects a value on a boolean flag and values outside choices', () => {
    expectUsage(() => parseArguments(['--json=1'], specs), 'OPTION_TAKES_NO_VALUE');
    expectUsage(() => parseArguments(['--lang', 'de'], specs), 'INVALID_OPTION_VALUE');
  });

  it('enforces maxPositionals', () => {
    expectUsage(() => parseArguments(['a', 'b'], specs, { maxPositionals: 1 }), 'UNEXPECTED_ARGUMENT');
  });
});

describe('assertNoSecretsInArgv', () => {
  it.each([
    ['--api-key', 'x'],
    ['--api-key=hb_live_123'],
    ['--apikey', 'x'],
    ['--API_KEY', 'x'],
    ['login', 'hb_live_0123456789abcdef'],
  ])('rejects %s', (...argv) => {
    expectUsage(() => assertNoSecretsInArgv(argv), 'API_KEY_IN_ARGV');
  });

  it('allows a key-like string in the remote command after --', () => {
    expect(() => assertNoSecretsInArgv(['exec', 'box', '--', 'echo', 'hb_live_abc'])).not.toThrow();
  });

  it('allows unrelated flags such as --token (preview tokens)', () => {
    expect(() => assertNoSecretsInArgv(['ports', 'url', '--token'])).not.toThrow();
  });
});
