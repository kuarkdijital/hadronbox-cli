/**
 * Runs before anything else is loaded (entry.ts imports only this file), so it must not import any module and
 * must use syntax old Node versions can parse. It mirrors the error contract for the two failures that happen
 * before the real CLI exists: a too old Node.js (UNSUPPORTED_NODE) and a broken install where the main bundle
 * cannot be loaded (INTERNAL). Message texts equal CLI_ERRORS (checked by test/preflight.test.ts).
 */

export const MIN_NODE_MAJOR = 20;

export interface EarlyFailure {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type EnvLike = { readonly [key: string]: string | undefined };

function beforeTerminator(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
}

export function earlyLang(argv: readonly string[], env: EnvLike): 'tr' | 'en' {
  const args = beforeTerminator(argv);
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i];
    if (arg === '--lang=en' || (arg === '--lang' && args[i + 1] === 'en')) return 'en';
    if (arg === '--lang=tr' || (arg === '--lang' && args[i + 1] === 'tr')) return 'tr';
  }
  return env.HADRONBOX_LANG === 'en' ? 'en' : 'tr';
}

export function earlyJson(argv: readonly string[]): boolean {
  return beforeTerminator(argv).some((arg) => arg === '--json' || arg.indexOf('--json=') === 0);
}

function report(
  argv: readonly string[],
  code: string,
  message: string,
  exitCode: number,
  lang: 'tr' | 'en',
): EarlyFailure {
  if (earlyJson(argv)) {
    const body = JSON.stringify({ error: { code: code, message: message }, exitCode: exitCode }, null, 2);
    return { exitCode: exitCode, stdout: body + '\n', stderr: '' };
  }
  const label = lang === 'tr' ? 'hata' : 'error';
  const codeLabel = lang === 'tr' ? 'kod' : 'code';
  return { exitCode: exitCode, stdout: '', stderr: label + ': ' + message + '\n' + codeLabel + ': ' + code + '\n' };
}

/** Null when this Node.js can run the CLI, otherwise what to print and the exit code (1). */
export function checkNodeVersion(argv: readonly string[], env: EnvLike, nodeVersion: string): EarlyFailure | null {
  const major = Number(String(nodeVersion).split('.')[0]);
  if (major >= MIN_NODE_MAJOR) return null;
  const lang = earlyLang(argv, env);
  const message =
    lang === 'tr'
      ? 'hadronbox Node.js ' + MIN_NODE_MAJOR + ' veya üstünü gerektirir (şu an ' + nodeVersion + ').'
      : 'hadronbox requires Node.js ' + MIN_NODE_MAJOR + ' or newer (current ' + nodeVersion + ').';
  return report(argv, 'UNSUPPORTED_NODE', message, 1, lang);
}

/** The main bundle could not be loaded (damaged install). */
export function loadFailure(argv: readonly string[], env: EnvLike): EarlyFailure {
  const lang = earlyLang(argv, env);
  const message =
    lang === 'tr'
      ? 'Beklenmeyen bir hata oluştu. Ayrıntı için --debug ile tekrar çalıştır.'
      : 'An unexpected error occurred. Run again with --debug for details.';
  return report(argv, 'INTERNAL', message, 1, lang);
}
