// The real CLI (dist/hadronbox.js). Loaded by entry.ts after the Node.js version check.
import { homedir } from 'node:os';
import { ExitCode } from './errors/exit-codes';
import { Cli } from './main';
import { installProcessHandlers } from './process-handlers';
import { readAllStdin, ttyPrompter } from './prompt';

const cli = new Cli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdinIsTTY: process.stdin.isTTY === true,
  platform: process.platform,
  homedir: homedir(),
  prompter: ttyPrompter(process.stdin, process.stderr),
  readStdin: () => readAllStdin(process.stdin),
});

/** Exit once stdout/stderr flushed (pipes are asynchronous on some platforms; a big JSON document must not be cut). */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
  setTimeout(() => process.exit(code), 1000).unref();
}

// `hb … | head` closes the pipe early: that is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(ExitCode.OK);
});
installProcessHandlers(process, cli, exitAfterFlush);

process.exitCode = await cli.run();
