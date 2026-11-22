import { constants as osConstants } from 'node:os';
import type { Localized } from '../i18n';

/**
 * Process exit code contract (README.md "Çıkış kodları"). These numbers are a public
 * API: scripts and AI agents branch on them. Never renumber or reuse a value; new ones go between 9 and 124.
 */
export const ExitCode = {
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
} as const;

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCodeValue = (typeof ExitCode)[ExitCodeName];

export interface ExitCodeRow {
  readonly code: ExitCodeValue;
  readonly name: ExitCodeName;
  readonly description: Localized;
}

export const EXIT_CODE_TABLE: readonly ExitCodeRow[] = [
  { code: 0, name: 'OK', description: { tr: 'Başarılı', en: 'Success' } },
  {
    code: 1,
    name: 'GENERAL',
    description: {
      tr: 'Genel hata (sunucu hatası, beklenmeyen yanıt, yerel dosya hatası)',
      en: 'General error (server error, unexpected response, local file error)',
    },
  },
  {
    code: 2,
    name: 'USAGE',
    description: {
      tr: 'Kullanım hatası (bilinmeyen komut/seçenek, eksik veya geçersiz argüman, TTY yokken onay gerekir)',
      en: 'Usage error (unknown command/option, missing or invalid argument, confirmation needed without a TTY)',
    },
  },
  {
    code: 3,
    name: 'AUTH',
    description: {
      tr: 'Kimlik doğrulama/yetki: giriş yok, API anahtarı geçersiz, yetki yok (401/403)',
      en: 'Authentication/authorization: not logged in, invalid API key, forbidden (401/403)',
    },
  },
  { code: 4, name: 'NOT_FOUND', description: { tr: 'Bulunamadı (404)', en: 'Not found (404)' } },
  { code: 5, name: 'PLAN_LIMIT', description: { tr: 'Plan veya kota sınırı (402)', en: 'Plan or quota limit (402)' } },
  {
    code: 6,
    name: 'INVALID_STATE',
    description: { tr: 'Geçersiz durum veya çakışma (409)', en: 'Invalid state or conflict (409)' },
  },
  {
    code: 7,
    name: 'NETWORK',
    description: {
      tr: 'Ağ hatası, zaman aşımı, oran sınırı (429) veya hizmet geçici olarak kullanılamıyor (502/503/504)',
      en: 'Network error, timeout, rate limited (429) or service temporarily unavailable (502/503/504)',
    },
  },
  {
    code: 8,
    name: 'CLI_UPGRADE',
    description: {
      tr: 'CLI sürümü artık desteklenmiyor (426); güncelle: npx hadronbox@latest',
      en: 'This CLI version is no longer supported (426); update: npx hadronbox@latest',
    },
  },
  {
    code: 125,
    name: 'REMOTE_NOT_STARTED',
    description: {
      tr: 'exec/sh: CLI tarafında hata (uzak komut başlamadan, bağlantı koptu, --timeout); sınıf: details.cliExitCode',
      en: 'exec/sh: CLI-side failure (before the start, connection lost, --timeout); class: details.cliExitCode',
    },
  },
  {
    code: 130,
    name: 'INTERRUPTED',
    description: {
      tr: 'Kullanıcı iptal etti (Ctrl+C / SIGINT; uzak komut çalışırken sinyal uzak sürece iletilir)',
      en: 'Interrupted by the user (Ctrl+C / SIGINT; while a remote command runs the signal goes to it)',
    },
  },
];

/**
 * Exit code for a finished remote command (`exec`, `sh`). Once the remote process has started the CLI exits with
 * the remote code as is (0..255) and, when the process died from a signal, with 128 + signal number (shell rule).
 * A CLI failure before the remote process started exits with 125 instead ({@link toRemoteSetupError} in
 * cli-error.ts), so a remote `exit 3` can never be mistaken for a CLI error.
 */
export function remoteExitCode(code: number | null, signal: string | number | null): number {
  if (signal !== null) {
    const signals: Readonly<Record<string, number>> = osConstants.signals;
    const signo = typeof signal === 'number' ? signal : Object.hasOwn(signals, signal) ? signals[signal] : undefined;
    if (typeof signo === 'number' && Number.isInteger(signo) && signo > 0 && signo < 128) {
      return 128 + signo;
    }
    return ExitCode.GENERAL;
  }
  if (code !== null && Number.isInteger(code) && code >= 0 && code <= 255) {
    return code;
  }
  return ExitCode.GENERAL;
}
