import { readFileSync } from 'node:fs';

/** Replaced at build time by esbuild (`define`). Undefined when running from source (tests, tsc). */
declare const __HB_VERSION__: string | undefined;

function readSourceVersion(): string {
  const raw: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof raw === 'object' && raw !== null && 'version' in raw && typeof raw.version === 'string') {
    return raw.version;
  }
  throw new Error('hadronbox package.json has no version');
}

export const CLI_VERSION: string = typeof __HB_VERSION__ === 'string' ? __HB_VERSION__ : readSourceVersion();

/** Sent on every API request: version + OS family only, for compatibility. No arch, Node or host data. */
export const USER_AGENT = `hadronbox-cli/${CLI_VERSION} (${process.platform})`;
