// Bundles the TypeScript tests with esbuild and runs them with node:test.
import { build } from 'esbuild';
import { readdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';

const out = '.test-build';
rmSync(out, { recursive: true, force: true });
const b = spawnSync('npm', ['run', '-s', 'build'], { stdio: 'inherit' });
if (b.status) process.exit(b.status);
const files = readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
await build({ entryPoints: files, bundle: true, platform: 'node', target: 'node22', packages: 'external', outdir: out, logLevel: 'warning' });
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files.map((f) => `${out}/${f.slice(5).replace(/\.ts$/, '.js')}`)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
