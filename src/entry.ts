// Package entry (dist/cli.js). Imports nothing but the dependency-free preflight, so an old Node.js gets a
// localized UNSUPPORTED_NODE error (JSON with --json) instead of a module-linking SyntaxError; the real CLI
// (dist/hadronbox.js, built from bin.ts) is loaded only after the check.
import { checkNodeVersion, loadFailure, type EarlyFailure } from './preflight';

/** Resolved relative to this file; a variable so esbuild keeps it as a runtime import of the second bundle. */
const MAIN_BUNDLE = './hadronbox.js';

function emit(failure: EarlyFailure): void {
  if (failure.stdout !== '') process.stdout.write(failure.stdout);
  if (failure.stderr !== '') process.stderr.write(failure.stderr);
  process.exitCode = failure.exitCode;
}

const argv = process.argv.slice(2);
const tooOld = checkNodeVersion(argv, process.env, process.versions.node);
if (tooOld !== null) {
  emit(tooOld);
} else {
  import(MAIN_BUNDLE).catch((error: unknown) => {
    if (process.env.HADRONBOX_DEBUG === '1' || argv.indexOf('--debug') !== -1) {
      process.stderr.write('debug: ' + String(error instanceof Error ? error.stack : error) + '\n');
    }
    emit(loadFailure(argv, process.env));
  });
}
