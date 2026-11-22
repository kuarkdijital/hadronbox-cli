import type { OptionSpec, OptionSpecs } from '../args/parse';
import { EXIT_CODE_TABLE } from '../errors/exit-codes';
import type { Lang } from '../i18n';
import type { JsonValue } from '../json';
import { CLI_VERSION } from '../version';
import { GLOBAL_OPTIONS } from './global-options';
import type { CommandSpec } from './types';

const T = {
  tagline: { tr: 'hadronbox.tr makineleri için komut satırı aracı', en: 'command line tool for hadronbox.tr machines' },
  usage: { tr: 'Kullanım', en: 'Usage' },
  commands: { tr: 'Komutlar', en: 'Commands' },
  subcommands: { tr: 'Alt komutlar', en: 'Subcommands' },
  options: { tr: 'Seçenekler', en: 'Options' },
  globalOptions: { tr: 'Genel seçenekler', en: 'Global options' },
  examples: { tr: 'Örnekler', en: 'Examples' },
  aliases: { tr: 'Takma adlar', en: 'Aliases' },
  env: { tr: 'Ortam değişkenleri', en: 'Environment variables' },
  command: { tr: 'komut', en: 'command' },
  options1: { tr: 'seçenekler', en: 'options' },
  more: {
    tr: 'Bir komutun ayrıntısı: hb <komut> --help · Çıkış kodları: hb help exit-codes',
    en: 'Details of a command: hb <command> --help · Exit codes: hb help exit-codes',
  },
  exitTitle: { tr: 'Çıkış kodları', en: 'Exit codes' },
  exitRemote: {
    tr: 'exec/sh: uzak komut bitince CLI onun kodunu aynen döndürür (sinyalle ölümde 128+sinyal).\nCLI tarafındaki her hata 125 ile çıkar: uzak komut başlamadan (reason: not_started), oturum başladıktan sonra\nbağlantı koparsa (remoteStarted: true, reason: session_lost) ve exec --timeout aşımında (reason: timeout).\nAsıl sınıf --json çıktısında details.cliExitCode alanındadır. Otomasyon için --json kullan.',
    en: 'exec/sh: when the remote command finishes the CLI exits with its code (128+signal when killed by a signal).\nEvery CLI-side failure exits with 125: before the remote command started (reason: not_started), when the\nconnection drops after the start (remoteStarted: true, reason: session_lost) and on exec --timeout (reason: timeout).\nThe original class is in details.cliExitCode of the --json output. Automation should use --json.',
  },
} as const;

const ENV_VARS: readonly { name: string; tr: string; en: string }[] = [
  {
    name: 'HADRONBOX_API_KEY',
    tr: 'API anahtarı (hb_live_…); kayıtlı girişten önce gelir',
    en: 'API key (hb_live_…); takes precedence over a stored login',
  },
  {
    name: 'HADRONBOX_API_URL',
    tr: 'API adresi (varsayılan https://api.hadronbox.tr)',
    en: 'API URL (default https://api.hadronbox.tr)',
  },
  { name: 'HADRONBOX_LANG', tr: 'Mesaj dili: tr | en', en: 'Message language: tr | en' },
  { name: 'HADRONBOX_PROFILE', tr: 'Profil adı', en: 'Profile name' },
  {
    name: 'HADRONBOX_CONFIG_DIR',
    tr: 'Yapılandırma dizini (varsayılan XDG / %APPDATA%)',
    en: 'Config directory (default XDG / %APPDATA%)',
  },
  { name: 'HADRONBOX_CREDENTIAL_STORE', tr: 'auto | keychain | file', en: 'auto | keychain | file' },
  { name: 'NO_COLOR', tr: 'Renkleri kapatır', en: 'Disables colors' },
];

function optionLabel(name: string, spec: OptionSpec): string {
  const long = `--${name}${spec.type === 'string' ? ` <${spec.valueName ?? 'value'}>` : ''}`;
  return spec.short === undefined ? `    ${long}` : `-${spec.short}, ${long}`;
}

function table(rows: readonly [string, string][]): string {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join('\n');
}

function optionRows(specs: OptionSpecs, lang: Lang): [string, string][] {
  return Object.entries(specs)
    .filter(([, spec]) => !spec.hidden)
    .map(([name, spec]) => [optionLabel(name, spec), spec.description[lang]]);
}

function commandRows(commands: readonly CommandSpec[], lang: Lang): [string, string][] {
  return commands.filter((c) => !c.hidden).map((c) => [c.name, c.summary[lang]]);
}

export function renderRootHelp(commands: readonly CommandSpec[], lang: Lang): string {
  return [
    `hadronbox ${CLI_VERSION} — ${T.tagline[lang]}`,
    '',
    `${T.usage[lang]}:`,
    `  hb <${T.command[lang]}> [${T.options1[lang]}]`,
    `  npx hadronbox <${T.command[lang]}> [${T.options1[lang]}]`,
    '',
    `${T.commands[lang]}:`,
    table(commandRows(commands, lang)),
    '',
    `${T.globalOptions[lang]}:`,
    table(optionRows(GLOBAL_OPTIONS, lang)),
    '',
    `${T.env[lang]}:`,
    table(ENV_VARS.map((v) => [v.name, v[lang]])),
    '',
    T.more[lang],
  ].join('\n');
}

/** `path` is the command chain, e.g. [machines, rm]. */
export function renderCommandHelp(path: readonly CommandSpec[], lang: Lang): string {
  const command = path[path.length - 1];
  if (command === undefined) throw new Error('empty command path');
  const lines = [
    `hb ${path.map((c) => c.name).join(' ')} — ${command.summary[lang]}`,
    '',
    `${T.usage[lang]}:`,
    `  hb ${command.usage}`,
  ];
  if (command.aliases !== undefined && command.aliases.length > 0) {
    lines.push('', `${T.aliases[lang]}: ${command.aliases.join(', ')}`);
  }
  if (command.subcommands !== undefined && command.subcommands.length > 0) {
    lines.push('', `${T.subcommands[lang]}:`, table(commandRows(command.subcommands, lang)));
  }
  if (command.options !== undefined && Object.keys(command.options).length > 0) {
    lines.push('', `${T.options[lang]}:`, table(optionRows(command.options, lang)));
  }
  lines.push('', `${T.globalOptions[lang]}:`, table(optionRows(GLOBAL_OPTIONS, lang)));
  if (command.examples.length > 0) {
    lines.push('', `${T.examples[lang]}:`, ...command.examples.map((e) => `  ${e}`));
  }
  if (command.notes !== undefined) {
    lines.push('', command.notes[lang]);
  }
  return lines.join('\n');
}

export function renderExitCodes(lang: Lang): string {
  return [
    `${T.exitTitle[lang]}:`,
    table(EXIT_CODE_TABLE.map((row) => [`${String(row.code).padEnd(4)}${row.name}`, row.description[lang]])),
    '',
    T.exitRemote[lang],
  ].join('\n');
}

export function exitCodesJson(lang: Lang): JsonValue {
  return {
    exitCodes: EXIT_CODE_TABLE.map((row) => ({ code: row.code, name: row.name, description: row.description[lang] })),
    remote: {
      passthrough: true,
      signalBase: 128,
      cliFailureExitCode: 125,
      reasons: ['not_started', 'session_lost', 'timeout'],
    },
  };
}

export function commandJson(command: CommandSpec, lang: Lang): JsonValue {
  return {
    name: command.name,
    aliases: [...(command.aliases ?? [])],
    summary: command.summary[lang],
    usage: `hb ${command.usage}`,
    examples: [...command.examples],
    options: Object.entries(command.options ?? {})
      .filter(([, spec]) => !spec.hidden)
      .map(([name, spec]) => ({ name: `--${name}`, type: spec.type, description: spec.description[lang] })),
    subcommands: (command.subcommands ?? []).filter((c) => !c.hidden).map((c) => commandJson(c, lang)),
  };
}

export function rootHelpJson(commands: readonly CommandSpec[], lang: Lang): JsonValue {
  return {
    name: 'hadronbox',
    version: CLI_VERSION,
    commands: commands.filter((c) => !c.hidden).map((c) => commandJson(c, lang)),
    globalOptions: Object.entries(GLOBAL_OPTIONS).map(([name, spec]) => ({
      name: `--${name}`,
      type: spec.type,
      description: spec.description[lang],
    })),
  };
}
