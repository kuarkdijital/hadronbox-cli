import { main, type MainIO } from '../src/main';
import type { Writer } from '../src/output';

export class MemoryWriter implements Writer {
  chunks: string[] = [];
  constructor(readonly isTTY = false) {}
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const TEST_KEY = `hb_live_${'a1'.repeat(24)}`;

export async function runCli(
  argv: string[],
  overrides: Partial<MainIO> = {},
  options: { tty?: boolean } = {},
): Promise<RunResult> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter(options.tty === true);
  const code = await main({
    argv,
    env: { HADRONBOX_CONFIG_DIR: '/nonexistent/hadronbox-test' },
    stdout,
    stderr,
    platform: 'linux',
    homedir: '/home/test',
    ...(options.tty === true ? { stdinIsTTY: true } : {}),
    ...overrides,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
