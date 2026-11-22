import type { OptionSpecs } from '../args/parse';
import { LANGS } from '../i18n';

/** Flags accepted by every command (anywhere on the command line before `--`). */
export const GLOBAL_OPTIONS = {
  help: { type: 'boolean', short: 'h', description: { tr: 'Yardımı gösterir', en: 'Show help' } },
  version: { type: 'boolean', short: 'v', description: { tr: 'Sürümü yazar', en: 'Print the version' } },
  json: {
    type: 'boolean',
    description: {
      tr: 'Makine-okur çıktı: stdout’a tek JSON belgesi (hatalar dahil)',
      en: 'Machine-readable output: one JSON document on stdout (errors included)',
    },
  },
  lang: {
    type: 'string',
    valueName: 'tr|en',
    choices: LANGS,
    description: { tr: 'Mesaj dili (varsayılan tr)', en: 'Message language (default tr)' },
  },
  'no-color': { type: 'boolean', description: { tr: 'Renkleri kapatır', en: 'Disable colors' } },
  profile: {
    type: 'string',
    valueName: 'ad',
    description: { tr: 'Kullanılacak profil (varsayılan "default")', en: 'Profile to use (default "default")' },
  },
  debug: {
    type: 'boolean',
    description: {
      tr: 'Tanılama satırları (istek yolu, durum, süre; anahtar yazılmaz)',
      en: 'Diagnostic lines (request path, status, timing; never the key)',
    },
  },
} as const satisfies OptionSpecs;
