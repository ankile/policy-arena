/** Build only the static release entry, then stage a validated public export. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateRelease } from '../src/release/types';
import { createReleaseAdapter } from '../src/release/adapter';

const [source, ...flags] = process.argv.slice(2);
if (!source || flags.some(f => f !== '--preview')) throw new Error('Usage: bun scripts/package_release.ts RELEASE_JSON [--preview]');
const data = validateRelease(JSON.parse(readFileSync(source, 'utf8')));
const sourceDir = resolve(source, '..');
const ui = JSON.parse(readFileSync(join(sourceDir, 'ui.json'), 'utf8'));
const sim = JSON.parse(readFileSync(join(sourceDir, "sim-statistics.json"), "utf8"));
createReleaseAdapter(data, ui, sim);
if (!flags.includes('--preview') && data.state !== 'public_verified') throw new Error('Production release requires public verification receipts');
const target = process.env.MULLIGAN_RELEASE_OUTPUT || '/tmp/mulligan-arena-build';
if (resolve(target) === resolve('dist')) throw new Error('Release must use a separate build directory');
const result = spawnSync('bun', ['run', 'build:release'], {stdio:'inherit'});
if (result.status !== 0) throw new Error('Release build failed');
mkdirSync(join(target, 'data'), {recursive:true});
copyFileSync(source, join(target, 'data/release.json'));
copyFileSync(join(sourceDir, 'ui.json'), join(target, 'data/ui.json'));
for (const name of ['sim-statistics.json','catalog.html','catalog.js','manifest.json','mapping.csv','training-recipes.json','evaluation-bundles.json','episode-lineage-audit.json','README.md','out-of-scope.csv','plan.html']) {
  copyFileSync(join(sourceDir, name), join(target, 'data', name));
}
copyFileSync('public/favicon.svg', join(target, 'favicon.svg'));
const headers = `/*
  Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://huggingface.co https://*.hf.co; media-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co; upgrade-insecure-requests
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
  Strict-Transport-Security: max-age=63072000; includeSubDomains
/data/*
  Cache-Control: public, max-age=0, must-revalidate
`;
writeFileSync(join(target, '_headers'), headers);
writeFileSync(join(target, 'robots.txt'), flags.includes('--preview') ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\n');
for (const file of readdirSync(join(target, 'assets')).filter(f => f.endsWith('.js'))) {
  const content = readFileSync(join(target, 'assets', file), 'utf8');
  if (/grandiose-rook|ideal-pig|convex.cloud|Sign in with Hugging Face/.test(content)) throw new Error(`Internal backend leaked into release bundle: ${file}`);
}
console.log(`Validated ${data.tasks.length} tasks; release staged at ${target}`);
