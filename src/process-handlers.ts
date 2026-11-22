import type { Cli } from './main';

/** The subset of `process` the handlers need (an EventEmitter in tests). */
export interface ProcessEvents {
  once(event: 'SIGINT', listener: () => void): unknown;
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

/**
 * Last-resort exits. All of them go through the run's Cli, so with `--json` stdout still gets exactly one valid
 * JSON document (`INTERRUPTED` → 130, `INTERNAL` → 1) and debug stacks are redacted. Commands that forward signals
 * to a remote process (sh/exec) install their own SIGINT handling.
 */
export function installProcessHandlers(proc: ProcessEvents, cli: Cli, exit: (code: number) => void): void {
  proc.once('SIGINT', () => {
    exit(cli.interrupt());
  });
  proc.on('uncaughtException', (error) => {
    exit(cli.fail(error));
  });
  proc.on('unhandledRejection', (reason) => {
    exit(cli.fail(reason));
  });
}
