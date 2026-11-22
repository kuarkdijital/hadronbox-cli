import { parseArgs } from 'node:util';
import { cliError } from '../errors/cli-error';
import type { Localized } from '../i18n';

/**
 * Argument parsing is built on Node's own `util.parseArgs` (stable since Node 20, zero dependencies). It runs in
 * non-strict token mode and this module does the validation, so every parse error has a stable code and a
 * Turkish/English message instead of Node's English-only exception text.
 */

interface OptionSpecBase {
  readonly short?: string;
  readonly description: Localized;
  readonly hidden?: boolean;
}

export interface BooleanOptionSpec extends OptionSpecBase {
  readonly type: 'boolean';
}

export interface StringOptionSpec extends OptionSpecBase {
  readonly type: 'string';
  readonly valueName?: string;
  readonly choices?: readonly string[];
}

export type OptionSpec = BooleanOptionSpec | StringOptionSpec;
export type OptionSpecs = Readonly<Record<string, OptionSpec>>;

export type OptionValues = Readonly<Record<string, string | boolean | undefined>>;

export interface ParsedArgs {
  readonly values: OptionValues;
  /** Positionals before `--` (after removing the command path). */
  readonly positionals: readonly string[];
  /** Everything after the first standalone `--` (passed through untouched, e.g. the remote command of exec). */
  readonly rest: readonly string[];
}

interface Token {
  readonly kind: 'option' | 'positional' | 'option-terminator';
  readonly index: number;
  readonly name?: string;
  readonly rawName?: string;
  readonly value?: string | undefined;
  readonly inlineValue?: boolean | undefined;
}

type NodeParseOptions = Record<string, { type: 'string' | 'boolean'; short?: string }>;

function toNodeOptions(specs: OptionSpecs): NodeParseOptions {
  const options: NodeParseOptions = {};
  for (const [name, spec] of Object.entries(specs)) {
    options[name] = spec.short === undefined ? { type: spec.type } : { type: spec.type, short: spec.short };
  }
  return options;
}

function tokenize(argv: readonly string[], specs: OptionSpecs): readonly Token[] {
  const { tokens } = parseArgs({
    args: [...argv],
    options: toNodeOptions(specs),
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  return tokens;
}

/**
 * argv index of the option terminator `--`, or -1. Taken from the tokens, so a `--` consumed as the value of a
 * string option (`--profile --`) is not mistaken for the terminator.
 */
export function terminatorIndex(argv: readonly string[], specs: OptionSpecs = {}): number {
  const token = tokenize(argv, specs).find((t) => t.kind === 'option-terminator');
  return token === undefined ? -1 : token.index;
}

/** Positional tokens before `--`, in order, without validating options (used to find the command path). */
export function leadingPositionals(
  argv: readonly string[],
  specs: OptionSpecs,
): readonly { value: string; index: number }[] {
  const result: { value: string; index: number }[] = [];
  for (const token of tokenize(argv, specs)) {
    if (token.kind === 'option-terminator') break;
    if (token.kind === 'positional' && token.value !== undefined) {
      result.push({ value: token.value, index: token.index });
    }
  }
  return result;
}

/** Lenient read of a few global flags before the command is known (language, --json); never throws. */
export function peekOptions(argv: readonly string[], specs: OptionSpecs): OptionValues {
  const values: Record<string, string | boolean | undefined> = {};
  for (const token of tokenize(argv, specs)) {
    if (token.kind === 'option-terminator') break;
    if (token.kind !== 'option' || token.name === undefined) continue;
    const spec = specs[token.name];
    if (spec?.type === 'boolean' && token.value === undefined) values[token.name] = true;
    if (spec?.type === 'string' && token.value !== undefined) values[token.name] = token.value;
  }
  return values;
}

export interface ParseOptions {
  /** argv indexes to drop (the command path tokens). */
  readonly skipIndexes?: ReadonlySet<number>;
  /** Max positionals before `--`; extra ones raise UNEXPECTED_ARGUMENT. Default: unlimited. */
  readonly maxPositionals?: number;
}

/** Strict parse: unknown options, missing values, values on boolean flags and bad choices are usage errors (exit 2). */
export function parseArguments(argv: readonly string[], specs: OptionSpecs, options: ParseOptions = {}): ParsedArgs {
  const skip = options.skipIndexes ?? new Set<number>();
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  const rest: string[] = [];
  let terminated = false;

  for (const token of tokenize(argv, specs)) {
    if (token.kind === 'option-terminator') {
      terminated = true;
      continue;
    }
    if (token.kind === 'positional') {
      if (token.value === undefined || skip.has(token.index)) continue;
      (terminated ? rest : positionals).push(token.value);
      continue;
    }
    const rawName = token.rawName ?? `--${token.name ?? ''}`;
    const spec = token.name === undefined ? undefined : specs[token.name];
    if (spec === undefined || token.name === undefined) {
      throw cliError('UNKNOWN_OPTION', { option: rawName });
    }
    if (spec.type === 'boolean') {
      if (token.value !== undefined) {
        throw cliError('OPTION_TAKES_NO_VALUE', { option: rawName });
      }
      values[token.name] = true;
      continue;
    }
    // A string option swallowed the next flag (`--lang --json`) or had nothing after it.
    if (token.value === undefined || (!token.inlineValue && token.value.startsWith('-'))) {
      throw cliError('MISSING_OPTION_VALUE', { option: rawName });
    }
    if (spec.choices !== undefined && !spec.choices.includes(token.value)) {
      throw cliError('INVALID_OPTION_VALUE', {
        option: rawName,
        value: token.value,
        allowed: spec.choices.join(', '),
      });
    }
    values[token.name] = token.value;
  }

  if (options.maxPositionals !== undefined && positionals.length > options.maxPositionals) {
    const extra = positionals[options.maxPositionals] ?? '';
    throw cliError('UNEXPECTED_ARGUMENT', { argument: extra });
  }
  return { values, positionals, rest };
}

const SECRET_FLAG = /^--?api[-_]?key(=.*)?$/i;

/**
 * An API key must never be accepted from argv (shell history, `ps`). Rejects `--api-key` style flags and
 * any argument that contains `hb_live_` before the first `--` (arguments after `--` belong to the remote command).
 */
export function assertNoSecretsInArgv(argv: readonly string[], specs: OptionSpecs = {}): void {
  const end = terminatorIndex(argv, specs);
  const checked = end === -1 ? argv : argv.slice(0, end);
  for (const arg of checked) {
    if (SECRET_FLAG.test(arg) || arg.includes('hb_live_')) {
      throw cliError('API_KEY_IN_ARGV');
    }
  }
}

export function stringValue(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

export function booleanValue(values: OptionValues, name: string): boolean {
  return values[name] === true;
}
