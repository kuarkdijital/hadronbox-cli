import type { Lang } from './i18n';
import { stripControlChars } from './redact';

/** Plain-text table (no box characters, two spaces between columns); cells are stripped of control characters. */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const clean = rows.map((row) => row.map((cell) => stripControlChars(cell)));
  const widths = headers.map((header, i) => Math.max(header.length, ...clean.map((row) => (row[i] ?? '').length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...clean.map(line)].join('\n');
}

/** `label: value` lines with aligned values. */
export function renderFields(fields: readonly (readonly [string, string])[]): string {
  const width = Math.max(0, ...fields.map(([label]) => label.length + 1));
  return fields.map(([label, value]) => `${`${label}:`.padEnd(width)}  ${stripControlChars(value)}`).join('\n');
}

const STATUS_LABELS: Readonly<Record<string, { tr: string; en: string }>> = {
  creating: { tr: 'hazırlanıyor', en: 'creating' },
  running: { tr: 'çalışıyor', en: 'running' },
  paused: { tr: 'duraklatıldı', en: 'paused' },
  stopped: { tr: 'durduruldu', en: 'stopped' },
  error: { tr: 'hata', en: 'error' },
};

export function statusLabel(status: string, lang: Lang): string {
  return STATUS_LABELS[status]?.[lang] ?? status;
}

const PAUSED_REASON_LABELS: Readonly<Record<string, { tr: string; en: string }>> = {
  user: { tr: 'elle', en: 'by you' },
  idle: { tr: 'boşta kaldığı için', en: 'idle' },
  max_runtime: { tr: 'azami çalışma süresi doldu', en: 'max run time reached' },
};

export function pausedReasonLabel(reason: string, lang: Lang): string {
  return PAUSED_REASON_LABELS[reason]?.[lang] ?? reason;
}

/** Local date and time, e.g. "22.11.2026 13:05" (tr) / "22/11/2026, 13:05" (en). */
export function formatDateTime(iso: string, lang: Lang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(
    date,
  );
}

/** Whole minutes as "45 dk" / "2 sa 5 dk" (tr), "45 min" / "2 h 5 min" (en). */
export function formatMinutes(minutes: number, lang: Lang): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const [h, m] = lang === 'tr' ? ['sa', 'dk'] : ['h', 'min'];
  if (hours === 0) return `${rest} ${m}`;
  return rest === 0 ? `${hours} ${h}` : `${hours} ${h} ${rest} ${m}`;
}

export function formatMib(mib: number): string {
  const gib = mib / 1024;
  return Number.isInteger(gib) ? `${gib} GiB` : `${gib.toFixed(1)} GiB`;
}
