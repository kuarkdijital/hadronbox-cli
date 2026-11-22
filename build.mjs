// Bundles the CLI into two ESM files with no runtime dependencies:
// - dist/cli.js       (bin entry): Node.js version preflight only, then imports ./hadronbox.js,
// - dist/hadronbox.js (the CLI itself, from src/bin.ts).
// esbuild instead of tsup: tsup is a wrapper around the same esbuild; using esbuild directly keeps the
// dev dependency tree to one pinned package (already in the lockfile through vite/vitest).
import { build } from 'esbuild';
import { chmod, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const pkg = JSON.parse(await readFile(here('./package.json'), 'utf8'));
const entryFile = here('./dist/cli.js');

await rm(here('./dist/'), { recursive: true, force: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
};
await build({
  ...common,
  entryPoints: [here('./src/entry.ts')],
  outfile: entryFile,
  // Must parse on old Node versions so they reach the "requires Node 20" message.
  target: 'node12',
  // Keep `import()` as is (Node ≥ 13.2 has it; older ones fail at it and print a SyntaxError — acceptable for
  // EOL versions) instead of lowering it to require(), which does not exist in ESM.
  supported: { 'dynamic-import': true },
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  ...common,
  entryPoints: [here('./src/bin.ts')],
  outfile: here('./dist/hadronbox.js'),
  target: 'node20',
  define: { __HB_VERSION__: JSON.stringify(pkg.version) },
});
await chmod(entryFile, 0o755);
