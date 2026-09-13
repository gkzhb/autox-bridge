import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { createProject, packageProject } from '../dist/project.js';
import { fixture, device } from './helpers.js';

async function folder(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-autox-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await createProject(root, 'Demo');
  return root;
}

test('project creation refuses overwrite; ZIP paths, content hashes, ignores, deletes and full sync', async t => {
  const root = await folder(t);
  await assert.rejects(createProject(root), /overwrite/);
  await fs.mkdir(path.join(root, 'build'));
  await fs.writeFile(path.join(root, 'build', 'no.js'), 'excluded');
  await fs.writeFile(path.join(root, 'builder.js'), 'included');
  await fs.mkdir(path.join(root, 'lib'));
  await fs.writeFile(path.join(root, 'lib', '工具.js'), 'module.exports = 1');
  const first = await packageProject(root);
  const files = unzipSync(first.buffer);
  assert.deepEqual(Object.keys(files).sort(), ['builder.js', 'lib/工具.js', 'main.js', 'project.json']);
  assert.equal(first.md5, createHash('md5').update(first.buffer).digest('hex'));
  const second = await packageProject(root, first.snapshot);
  assert.deepEqual(Object.keys(unzipSync(second.buffer)), []);
  const stat = await fs.stat(path.join(root, 'main.js'));
  await fs.writeFile(path.join(root, 'main.js'), 'toast("modified")');
  await fs.utimes(path.join(root, 'main.js'), stat.atime, stat.mtime);
  await fs.rm(path.join(root, 'builder.js'));
  const changed = await packageProject(root, first.snapshot);
  assert.deepEqual(changed.files, ['main.js']);
  assert.deepEqual(changed.removed, ['builder.js']);
  assert.equal(new TextDecoder().decode(unzipSync(changed.buffer)['main.js']), 'toast("modified")');
  const full = await packageProject(root, changed.snapshot, { full: true });
  assert.equal(full.files.length, 3);
});

test('project rejects escaping ignores, symlinks, malformed config and excessive size', async t => {
  const root = await folder(t);
  await assert.rejects(packageProject(root, undefined, { maxBytes: 1 }), /exceeds/);
  await fs.symlink(path.join(root, 'main.js'), path.join(root, 'link.js'));
  await assert.rejects(packageProject(root), /symlinks/);
  await fs.rm(path.join(root, 'link.js'));
  for (const config of [{ ignore: ['../secrets'] }, { ignore: '/tmp' }, null]) {
    await fs.writeFile(path.join(root, 'project.json'), JSON.stringify(config));
    await assert.rejects(packageProject(root), /ignore|object/);
  }
});

test('per-device incremental project snapshots, binary+command adjacency, reconnect and failure retry', async t => {
  const root = await folder(t);
  const { bridge, client } = await fixture(t);
  const a = await device(t, bridge, { name: 'A' });
  const b = await device(t, bridge, { name: 'B' });
  const first = await client.action({ action: 'save_project', folder: root, device: a.id });
  const binary = await a.next();
  const command = await a.next();
  assert.ok(Buffer.isBuffer(binary));
  assert.equal(command.md5, createHash('md5').update(binary).digest('hex'));
  assert.deepEqual(command.data, { command: 'save_project', id: root, name: root });
  assert.equal(first.results[0].files.length, 2);
  const second = await client.action({ action: 'run_project', folder: root, all: true });
  assert.equal(second.results.find(r => r.deviceId === a.id).files.length, 0);
  assert.equal(second.results.find(r => r.deviceId === b.id).files.length, 2);
  await a.next(); await a.next(); await b.next(); await b.next();
  await Promise.all([
    client.action({ action: 'save_project', folder: root, device: a.id }),
    client.action({ action: 'stopAll', device: a.id }),
    client.action({ action: 'run_project', folder: root, device: a.id }),
  ]);
  const frames = [];
  for (let i = 0; i < 5; i++) frames.push(await a.next());
  for (let i = 0; i < frames.length; i++) if (Buffer.isBuffer(frames[i])) assert.equal(frames[i + 1].type, 'bytes_command');
  await fs.writeFile(path.join(root, 'main.js'), 'changed');
  const session = bridge.devices.get(a.id);
  const originalSend = session.sendJson.bind(session);
  session.sendJson = async () => { throw new Error('injected send failure'); };
  const failed = await bridge.execute({ action: 'save_project', folder: root, device: a.id });
  assert.equal(failed.ok, false);
  await a.next();
  session.sendJson = originalSend;
  const retry = await client.action({ action: 'save_project', folder: root, device: a.id });
  assert.deepEqual(retry.results[0].files, ['main.js']);
  await a.next(); await a.next();
  await session.close();
  const c = await device(t, bridge, { name: 'A' });
  const fresh = await client.action({ action: 'save_project', folder: root, device: c.id });
  assert.equal(fresh.results[0].files.length, 2);
  await c.next(); await c.next();
});

test('reference selection matches original predicate including trailing separators', async t => {
  const root = await folder(t);
  for (const dir of ['.git', 'node_modules', 'build']) {
    await fs.mkdir(path.join(root, dir));
    await fs.writeFile(path.join(root, dir, 'inside.js'), dir);
  }
  await fs.writeFile(path.join(root, 'build-extra.js'), 'extra');
  const all = ['.git/inside.js', 'node_modules/inside.js', 'build/inside.js', 'build-extra.js', 'main.js', 'project.json'];
  for (const ignore of [[], ['build'], ['build/'], ['./']]) {
    await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ ignore }));
    const expected = all.filter(rel => !ignore.some(p => path.join(root, rel).startsWith(path.join(root, path.normalize(p))))).sort();
    const result = await packageProject(root, undefined, { referenceFiles: true });
    assert.deepEqual(result.files.slice().sort(), expected);
    assert.deepEqual(Object.keys(unzipSync(result.buffer)).sort(), expected);
  }
});
