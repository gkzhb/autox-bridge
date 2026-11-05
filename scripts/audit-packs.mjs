// Run after packing both packages; no installation, publication or device action.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = process.cwd();
for (const name of ['autox-bridge', 'phonectl']) {
  const source = path.join(root, 'packages', name);
  const manifest = JSON.parse(readFileSync(path.join(source, 'package.json')));
  const archive = path.join(root, `${name}-${manifest.version}.tgz`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/') && !entry.includes('../'), entry);
    assert.ok(!/^package\/(?:packages|node_modules|test|\.planning|\.agents)\//.test(entry), entry);
    assert.ok(!/pnpm-(?:lock|workspace)\.yaml$/.test(entry), entry);
  }
  const temp = mkdtempSync(path.join(os.tmpdir(), 'workspace-pack-audit-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', temp]);
    const packed = JSON.parse(readFileSync(path.join(temp, 'package/package.json')));
    for (const key of ['name', 'version', 'type', 'main', 'types', 'exports', 'bin', 'files', 'engines', 'license', 'dependencies']) assert.deepEqual(packed[key], manifest[key], key);
    for (const file of ['README.md', 'LICENSE', 'NOTICE']) assert.deepEqual(readFileSync(path.join(temp, 'package', file)), readFileSync(path.join(source, file)), file);
    symlinkSync(path.join(source, 'node_modules'), path.join(temp, 'package/node_modules'));
    mkdirSync(path.join(temp, 'consumer/node_modules'), { recursive: true });
    symlinkSync(path.join(temp, 'package'), path.join(temp, 'consumer/node_modules', name));
    const code = name === 'phonectl'
      ? "import assert from 'node:assert/strict'; import {execute,status,PhoneError} from 'phonectl'; assert.equal(typeof execute,'function'); assert.equal(typeof status,'function'); assert.equal(new PhoneError('X','x').code,'X');"
      : "import assert from 'node:assert/strict'; import {AutoXBridge} from 'autox-bridge'; import {envelope} from 'autox-bridge/protocol'; assert.equal(typeof AutoXBridge,'function'); assert.equal(envelope('ping',null).type,'ping');";
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(temp, 'consumer') });
    for (const [alias, bin] of Object.entries(packed.bin)) {
      assert.ok(entries.includes('package/' + bin.replace(/^\.\//, '')), bin);
      assert.equal(execFileSync(process.execPath, [path.join(temp, 'package', bin), '--version'], { encoding: 'utf8' }).trim(), manifest.version);
      assert.match(execFileSync(process.execPath, [path.join(temp, 'package', bin), '--help'], { encoding: 'utf8' }), /Usage:/);
      console.log(`PASS packed ${alias} bin/version/help`);
    }
    assert.ok(entries.includes('package/dist/index.d.ts'));
    console.log(`PASS ${name}: ${entries.length} entries; manifest, legal text, README, exports, types and bins`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
console.log('Dependency runtime smoke uses existing workspace installation, not a clean consumer install.');
