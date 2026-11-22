import { cliError } from './errors/cli-error';
import type { Lang } from './i18n';

/** Questions on the terminal. Only used when `ctx.interactive` is true (TTY on stdin and stderr, CI not set). */
export interface Prompter {
  /** Yes/no question; anything but an explicit yes is "no" (default no). */
  confirm(question: string, lang: Lang): Promise<boolean>;
  /** Reads a line without echoing it (API key). Ctrl+C → INTERRUPTED. */
  secret(question: string): Promise<string>;
}

export interface TtyInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TtyOutput {
  write(chunk: string): unknown;
}

const YES = new Set(['e', 'evet', 'y', 'yes']);

export function isYes(answer: string): boolean {
  return YES.has(answer.trim().toLocaleLowerCase('tr'));
}

/**
 * Reads characters from a TTY in raw mode until Enter. `echo: false` prints nothing for typed characters (secret);
 * Backspace edits, Ctrl+C rejects with INTERRUPTED, Ctrl+D ends the input.
 */
export function readLine(input: TtyInput, output: TtyOutput, echo: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const raw = typeof input.setRawMode === 'function';
    const finish = (error?: unknown) => {
      input.removeListener('data', onData);
      if (raw) input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (error === undefined) resolve(value);
      else reject(error);
    };
    // Escape sequences (arrow keys: ESC [ A, ESC O P, …) are dropped instead of ending up in the value.
    let escape: 'none' | 'start' | 'csi' = 'none';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (escape === 'start') {
          escape = char === '[' || char === 'O' ? 'csi' : 'none';
          continue;
        }
        if (escape === 'csi') {
          if (char >= '@' && char <= '~') escape = 'none';
          continue;
        }
        if (char === '\u001b') {
          escape = 'start';
          continue;
        }
        if (char === '\r' || char === '\n' || char === '\u0004') {
          finish();
          return;
        }
        if (char === '\u0003') {
          finish(cliError('INTERRUPTED'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (echo) output.write('\b \b');
          }
          continue;
        }
        if (char < ' ') continue;
        value += char;
        if (echo) output.write(char);
      }
    };
    input.setEncoding('utf8');
    if (raw) input.setRawMode?.(true);
    input.on('data', onData);
    input.resume();
  });
}

export function ttyPrompter(input: TtyInput, output: TtyOutput): Prompter {
  return {
    async confirm(question, lang) {
      output.write(`${question} ${lang === 'tr' ? '(e/H)' : '(y/N)'} `);
      return isYes(await readLine(input, output, true));
    },
    async secret(question) {
      output.write(`${question} `);
      return readLine(input, output, false);
    },
  };
}

export interface StdinSource {
  setEncoding(encoding: BufferEncoding): unknown;
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer>;
}

/** Reads all of a piped stdin (bounded), e.g. `hb login --with-api-key < key.txt`. */
export async function readAllStdin(stdin: StdinSource, limit = 64 * 1024): Promise<string> {
  stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of stdin) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length > limit) throw cliError('INVALID_API_KEY');
  }
  return text;
}
