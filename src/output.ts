import type { CliError } from './errors/cli-error';
import type { Lang } from './i18n';
import type { JsonValue } from './json';
import { redactSecrets } from './redact';

export interface Writer {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
}

export interface OutputOptions {
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly json: boolean;
  readonly color: boolean;
  readonly lang: Lang;
  readonly debug: boolean;
}

const LABELS = {
  error: { tr: 'hata', en: 'error' },
  code: { tr: 'kod', en: 'code' },
  warning: { tr: 'uyarı', en: 'warning' },
} as const;

/** Decides whether stderr decorations may use ANSI colors (NO_COLOR, --no-color, CI, TERM=dumb, no TTY). */
export function shouldUseColor(
  env: Readonly<Record<string, string | undefined>>,
  stderr: Writer,
  noColorFlag: boolean,
): boolean {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') return false;
  if (env.TERM === 'dumb') return false;
  return stderr.isTTY === true;
}

/**
 * Output contract: data goes to stdout, decoration/progress/warnings to stderr. With
 * `--json` stdout carries exactly one JSON document (errors included) so `jq .` always parses it. Everything the CLI
 * prints passes through {@link redactSecrets}.
 */
export class Output {
  private jsonDocumentWritten = false;

  constructor(private readonly options: OutputOptions) {}

  get lang(): Lang {
    return this.options.lang;
  }

  get json(): boolean {
    return this.options.json;
  }

  /** A line of data on stdout (human mode). */
  data(text: string): void {
    this.options.stdout.write(`${redactSecrets(text)}\n`);
  }

  /** True once a JSON document went to stdout; later ones are suppressed (one document per run). */
  get jsonDocumentDone(): boolean {
    return this.jsonDocumentWritten;
  }

  /** One JSON document on stdout. A second call in the same run is dropped (reported with --debug). */
  jsonValue(value: JsonValue): void {
    if (this.jsonDocumentWritten) {
      this.debug('suppressed a second JSON document on stdout');
      return;
    }
    this.jsonDocumentWritten = true;
    this.options.stdout.write(`${redactSecrets(JSON.stringify(value, null, 2))}\n`);
  }

  /** Prints `json` in --json mode, otherwise the human text. */
  result(human: string, json: JsonValue): void {
    if (this.options.json) {
      this.jsonValue(json);
    } else {
      this.data(human);
    }
  }

  /** Progress/info line on stderr (never in stdout, so pipes and --json stay clean). */
  info(text: string): void {
    this.options.stderr.write(`${redactSecrets(text)}\n`);
  }

  warn(text: string): void {
    const label = this.paint(LABELS.warning[this.options.lang], '33');
    this.options.stderr.write(`${label}: ${redactSecrets(text)}\n`);
  }

  debug(text: string): void {
    if (this.options.debug) {
      this.options.stderr.write(`${this.paint('debug', '90')}: ${redactSecrets(text)}\n`);
    }
  }

  /**
   * Error contract: human mode writes two stderr lines, the message and `kod: <CODE>`; `--json` writes
   * `{ "error": { "code", "message", "details"? }, "exitCode": n }` to stdout. If the run already printed its JSON
   * result, the error goes to stderr in human form so stdout stays a single valid document.
   */
  error(error: CliError): void {
    const message = error.messageIn(this.options.lang);
    if (this.options.json && !this.jsonDocumentWritten) {
      const payload: { [key: string]: JsonValue } = { code: error.code, message };
      if (error.details !== undefined) payload.details = error.details;
      this.jsonValue({ error: payload, exitCode: error.exitCode });
    } else {
      const { lang } = this.options;
      this.options.stderr.write(
        `${this.paint(LABELS.error[lang], '31')}: ${redactSecrets(message)}\n${LABELS.code[lang]}: ${error.code}\n`,
      );
    }
    if (this.options.debug && error.cause !== undefined) {
      const cause = error.cause instanceof Error ? (error.cause.stack ?? error.cause.message) : String(error.cause);
      this.debug(cause);
    }
  }

  private paint(text: string, ansi: string): string {
    return this.options.color ? `\u001b[${ansi}m${text}\u001b[0m` : text;
  }
}
