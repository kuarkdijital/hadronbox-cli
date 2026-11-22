// Checks what `npm publish` would upload: exactly the files below, the bin entry executable and starting with a
// shebang, and nothing else (no src, test, maps, .env, lockfile). Run after `npm run build`.
// Used by .github/workflows/ci.yml and .github/workflows/npm-publish.yml.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXPECTED = ['CHANGELOG.md', 'LICENSE', 'README.md', 'dist/cli.js', 'dist/hadronbox.js', 'package.json'];

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// --ignore-scripts: dist/ is already built; prepack would only rebuild it.
const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
const [report] = JSON.parse(raw);
const files = report.files.map((file) => file.path).sort();

const problems = [];
if (report.name !== pkg.name || report.version !== pkg.version) {
  problems.push(`package ${report.name}@${report.version} != package.json ${pkg.name}@${pkg.version}`);
}
const missing = EXPECTED.filter((file) => !files.includes(file));
const extra = files.filter((file) => !EXPECTED.includes(file));
if (missing.length > 0) problems.push(`missing from the package: ${missing.join(', ')}`);
if (extra.length > 0) problems.push(`unexpected files in the package: ${extra.join(', ')}`);

const entry = report.files.find((file) => file.path === 'dist/cli.js');
if (entry && (entry.mode & 0o111) === 0) problems.push('dist/cli.js is not executable');
if (!readFileSync(new URL('../dist/cli.js', import.meta.url), 'utf8').startsWith('#!/usr/bin/env node\n')) {
  problems.push('dist/cli.js does not start with "#!/usr/bin/env node"');
}
for (const [name, target] of Object.entries(pkg.bin ?? {})) {
  if (target !== 'dist/cli.js') problems.push(`bin ${name} -> ${target}, expected dist/cli.js`);
}

if (problems.length > 0) {
  console.error(`npm pack check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`npm pack check ok: ${report.name}@${report.version}, ${files.length} files, ${report.size} bytes`);
for (const file of report.files) console.log(`  ${file.path} (${file.size} B)`);
