import { stripControlChars } from './redact';

/** CLI message language. Turkish is the default; `--lang en` or `HADRONBOX_LANG=en` switches. */
export const LANGS = ['tr', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'tr';

export interface Localized {
  readonly tr: string;
  readonly en: string;
}

export type MessageParams = Readonly<Record<string, string | number>>;

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/**
 * Replaces `{name}` placeholders; unknown placeholders are left as they are. Values usually come from the command
 * line or the server, so control/bidi characters are stripped from them.
 */
export function interpolate(template: string, params: MessageParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : stripControlChars(String(value));
  });
}

export function localize(text: Localized, params?: MessageParams): Localized {
  return { tr: interpolate(text.tr, params), en: interpolate(text.en, params) };
}
