import { spawn } from 'node:child_process';

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** Written to the child's stdin, then stdin is closed. Secrets go here, never into argv. */
  readonly input?: string;
  readonly timeoutMs: number;
}

/** Runs a program without a shell. Rejects with an error whose `code` is 'ENOENT' when the program is missing. */
export type CommandRunner = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

export class CommandTimeoutError extends Error {
  constructor(file: string) {
    super(`${file} timed out`);
    this.name = 'CommandTimeoutError';
  }
}

export const spawnRunner: CommandRunner = (file, args, options) =>
  new Promise<RunResult>((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new CommandTimeoutError(file));
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
