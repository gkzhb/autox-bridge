import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseManifest, validateInput } from '../dist/scripts/manifest.js';
import { discoverScripts, resolveScript, userScriptsDirectory, MAX_MANIFEST_BYTES, MAX_SCRIPT_BYTES, MAX_REGISTRY_ENTRIES } from '../dist/scripts/registry.js';
import { compileScript, parseScriptInput, MAX_INPUT_BYTES } from '../dist/scripts/compile.js';
import { fixture, device } from './helpers.js';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/autox-bridge.js', import.meta.url));
const manifest = (overrides = {}) => ({ schemaVersion: 1, name: 'demo', description: 'Demo script', runtime: 'autox', entry: 'main.js', ...overrides });
async function setup(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autox-registry-'));
  const root = path.join(temp, 'autox', 'scripts');
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = temp;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await fs.rm(temp, { recursive: true, force: true });
  });
  const add = async (folder = 'demo', config = manifest(), source = 'console.log("demo");') => {
    const dir = path.join(root, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'script.json'), JSON.stringify(config));
    await fs.mkdir(path.dirname(path.join(dir, config.entry)), { recursive: true });
    await fs.writeFile(path.join(dir, config.entry), source);
    return dir;
  };
  const run = (args, url = 'http://127.0.0.1:1', cwd = temp) => exec(process.execPath, [bin, '--json', '--url', url, ...args], {
    timeout: 10000, cwd, env: { ...process.env, XDG_CONFIG_HOME: temp, AUTOX_BRIDGE_TOKEN: '' },
  });
  return { root, temp, add, run };
}

test('user path defaults and explicit XDG absolute-path validation', () => {
  assert.equal(userScriptsDirectory({}, '/home/demo'), path.join('/home/demo', '.config', 'autox', 'scripts'));
  assert.equal(userScriptsDirectory({ XDG_CONFIG_HOME: '/config' }, '/unused'), path.join('/config', 'autox', 'scripts'));
  assert.equal(userScriptsDirectory({ XDG_CONFIG_HOME: '' }, '/home/demo'), path.join('/home/demo', '.config', 'autox', 'scripts'));
  assert.throws(() => userScriptsDirectory({ XDG_CONFIG_HOME: 'relative' }), /absolute/);
});

test('strict manifest and primitive parameter contracts reject invalid declarations', () => {
  assert.deepEqual(parseManifest(manifest()), manifest());
  const invalid = [null, [], { ...manifest(), schemaVersion: 2 }, manifest({ runtime: 'shell' }), manifest({ name: '../bad' }),
    manifest({ description: '' }), manifest({ unknown: true }), manifest({ parameters: [] }),
    ...['/tmp/x.js', '../x.js', 'a/../x.js', './x.js', 'C:\\x.js', 'a\\b.js', 'file:x.js', 'a//x.js', 'x.ts', 'a\0.js'].map(entry => manifest({ entry })),
    ...[{ type: 'object' }, { type: 'string', required: 'yes' }, { type: 'string', default: false },
      { type: 'number', enum: [1, '2'] }, { type: 'boolean', enum: [] }, { type: 'string', enum: ['a'], default: 'b' },
      { type: 'string', other: true }].map(parameter => manifest({ parameters: { value: parameter } })),
    manifest({ parameters: JSON.parse('{"__proto__":{"type":"string"}}') }),
  ];
  for (const value of invalid) assert.throws(() => parseManifest(value), undefined, JSON.stringify(value));
  const valid = parseManifest(manifest({ parameters: {
    text: { type: 'string', required: true }, count: { type: 'number', default: 2, enum: [1, 2] },
    active: { type: 'boolean', default: false }, optional: { type: 'string' },
  } }));
  assert.deepEqual({ ...validateInput(valid, { text: 'hello' }) }, { text: 'hello', count: 2, active: false });
  for (const input of [[], null, {}, { text: 2 }, { text: 'ok', count: '2' }, { text: 'ok', count: 3 }, { text: 'ok', extra: true }, { text: 'ok', active: null }, JSON.parse('{"text":"ok","__proto__":{}}')]) {
    assert.throws(() => validateInput(valid, input));
  }
  assert.throws(() => parseScriptInput('{bad'), /valid JSON/);
  assert.throws(() => parseScriptInput(' '.repeat(MAX_INPUT_BYTES + 1)), /exceeds/);
});

test('Zod schemas retain strict keys, finite primitives, falsy defaults and issue paths', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const definitions = JSON.parse(`{"${key}":{"type":"string"}}`);
    assert.throws(() => parseManifest(manifest({ parameters: definitions })), z.ZodError);
    assert.throws(() => validateInput(parseManifest(manifest()), JSON.parse(`{"${key}":1}`)), z.ZodError);
  }
  const config = parseManifest(manifest({ parameters: {
    count: { type: 'number', required: true, default: 0, enum: [0, 1] },
    enabled: { type: 'boolean', default: false, enum: [false] },
    text: { type: 'string', default: '' }, optional: { type: 'string' },
  } }));
  const result = validateInput(config, {});
  assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual({ ...result }, { count: 0, enabled: false, text: '' });
  assert.equal(Object.hasOwn(result, 'optional'), false);
  for (const count of [NaN, Infinity, -Infinity, null, '0']) {
    assert.throws(() => validateInput(config, { count }), error =>
      error instanceof z.ZodError && error.issues.some(issue => issue.path[0] === 'count'));
  }
  assert.throws(() => validateInput(config, { count: '0', enabled: 'false', extra: 1 }), error => {
    assert.ok(error instanceof z.ZodError);
    assert.ok(error.issues.some(issue => issue.path[0] === 'count'));
    assert.ok(error.issues.some(issue => issue.path[0] === 'enabled'));
    assert.ok(error.issues.some(issue => issue.code === 'unrecognized_keys'));
    return true;
  });
  assert.throws(() => parseManifest(manifest({ parameters: { count: { type: 'number', default: Infinity } } })), z.ZodError);
  assert.throws(() => parseManifest(manifest({ parameters: { count: { type: 'number', enum: [1], default: 2 } } })), error =>
    error instanceof z.ZodError && error.issues.some(issue => issue.path.join('.') === 'parameters.count.default'));
});

test('discovery is offline, deterministic, user-only and exactly one directory level', async t => {
  const { root, temp, add, run } = await setup(t);
  assert.deepEqual(await discoverScripts(), { root, scripts: [], diagnostics: [] });
  assert.equal(JSON.parse((await run(['scripts', 'validate'])).stdout).ok, true);
  await add('z-last', manifest({ name: 'last' }));
  await add('a-first', manifest({ name: 'first', entry: 'src/main.js' }));
  await add('container/nested', manifest({ name: 'nested' }));
  await fs.writeFile(path.join(root, 'loose.js'), 'ignored');
  const project = path.join(temp, 'work', '.autox', 'scripts', 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'script.json'), JSON.stringify(manifest({ name: 'project' })));
  await fs.writeFile(path.join(project, 'main.js'), 'throw new Error("never execute");');
  const registry = await discoverScripts();
  assert.deepEqual(registry.scripts.map(item => item.manifest.name), ['first', 'last']);
  assert.equal(registry.diagnostics.length, 1); // container lacks its own manifest; nested never discovered
  const output = JSON.parse((await run(['scripts', 'list'], undefined, path.join(temp, 'work'))).stdout);
  assert.deepEqual(output.scripts.map(item => item.name), ['first', 'last']);
  assert.equal(JSON.parse((await run(['scripts', 'list', '--query', 'FIRST'])).stdout).scripts.length, 1);
  assert.equal(JSON.parse((await run(['scripts', 'show', 'first'])).stdout).manifest.name, 'first');
  await assert.rejects(run(['scripts', 'show', 'nested']), error => error.code === 1 && /not found/.test(JSON.parse(error.stderr).error));
  await assert.rejects(run(['scripts', 'validate']), error => error.code === 1 && JSON.parse(error.stdout).ok === false);
});

test('bad entries do not hide valid entries; duplicate names cannot execute', async t => {
  const { root, add } = await setup(t);
  await add('good', manifest({ name: 'good' }));
  const bad = await add('broken');
  await fs.writeFile(path.join(bad, 'script.json'), '{');
  await add('duplicate-a');
  await add('duplicate-b');
  const registry = await discoverScripts();
  assert.equal(resolveScript(registry, 'good').manifest.name, 'good');
  assert.throws(() => resolveScript(registry, 'demo'), /Duplicate/);
  assert.equal(registry.diagnostics.length, 2);
  // A well-formed same-name manifest with a missing entry still blocks ambiguous resolution.
  await fs.rm(path.join(root, 'duplicate-b', 'main.js'));
  const afterRemoval = await discoverScripts();
  assert.throws(() => resolveScript(afterRemoval, 'demo'), /Duplicate|ENOENT/);
  await fs.writeFile(path.join(root, 'duplicate-b', 'script.json'), JSON.stringify(manifest({ parameters: { value: { type: 'object' } } })));
  const invalidSameName = await discoverScripts();
  assert.throws(() => resolveScript(invalidSameName, 'demo'), /Duplicate script name demo/);
  assert.ok(invalidSameName.diagnostics.some(issue => /Duplicate script name demo/.test(issue.error)));
  assert.equal(resolveScript(invalidSameName, 'good').manifest.name, 'good');
});

test('symlink directories, manifests, entries and intermediate components are refused', async t => {
  const { root, temp, add } = await setup(t);
  const original = await add('original', manifest({ name: 'original' }));
  await fs.symlink(original, path.join(root, 'linked-directory'), 'dir');
  const linkedManifest = await add('linked-manifest');
  await fs.rm(path.join(linkedManifest, 'script.json'));
  await fs.symlink(path.join(original, 'script.json'), path.join(linkedManifest, 'script.json'));
  const linkedEntry = await add('linked-entry', manifest({ name: 'linked-entry' }));
  await fs.rm(path.join(linkedEntry, 'main.js'));
  await fs.symlink(path.join(original, 'main.js'), path.join(linkedEntry, 'main.js'));
  const nested = await add('nested-entry', manifest({ name: 'nested-entry', entry: 'sub/main.js' }));
  await fs.rm(path.join(nested, 'sub'), { recursive: true });
  await fs.symlink(original, path.join(nested, 'sub'), 'dir');
  const registry = await discoverScripts();
  assert.equal(registry.scripts.length, 1);
  assert.equal(registry.diagnostics.length, 4);
  assert.ok(registry.diagnostics.every(item => /symlink/.test(item.error)));
  await fs.rename(root, path.join(temp, 'moved'));
  await fs.symlink(path.join(temp, 'moved'), root, 'dir');
  await assert.rejects(discoverScripts(), /symlink/);
});

test('file size limits and bounded root enumeration', async t => {
  const { root, add } = await setup(t);
  const largeManifest = await add('manifest-large');
  await fs.writeFile(path.join(largeManifest, 'script.json'), ' '.repeat(MAX_MANIFEST_BYTES + 1));
  const largeScript = await add('script-large', manifest({ name: 'large' }));
  await fs.truncate(path.join(largeScript, 'main.js'), MAX_SCRIPT_BYTES + 1);
  assert.equal((await discoverScripts()).diagnostics.filter(item => /exceeds/.test(item.error)).length, 2);
  await Promise.all(Array.from({ length: MAX_REGISTRY_ENTRIES - 1 }, (_, i) => fs.writeFile(path.join(root, `file-${i}`), '')));
  await assert.rejects(discoverScripts(), /directory entries/);
});

test('input compilation preserves directives, CRLF, unicode and data without host execution', async t => {
  const { add, root } = await setup(t);
  const source = '\ufeff"ui";\r\n// comment\r\n/* header */\r\n"use strict";\r\nvar input = __AUTOX_INPUT__;\r\nresult = input;';
  await add('demo', manifest({ parameters: { text: { type: 'string', required: true }, active: { type: 'boolean', default: false } } }), source);
  const script = resolveScript(await discoverScripts(), 'demo');
  const text = '\"; throw new Error("injection"); //\\\r\n🙂\u2028\u2029$&';
  const output = await compileScript(root, script, { text });
  assert.ok(output.script.startsWith(source.slice(0, source.indexOf('__AUTOX_INPUT__'))));
  assert.ok(output.script.endsWith(';\r\nresult = input;'));
  const context = { result: undefined };
  vm.runInNewContext(output.script, context); // tests only: controlled fixture, never production host execution
  assert.equal(context.result.text, text);
  assert.equal(context.result.active, false);
  assert.equal(output.id, script.id);
  await assert.rejects(compileScript(root, script, {}), /required/);
  await assert.rejects(compileScript(root, script, { text: 'a'.repeat(MAX_INPUT_BYTES) }), /exceeds/);
});

test('template rejects misplaced/repeated/literal/comment markers and preserves ordinary scripts', async t => {
  const { add, root, run } = await setup(t);
  const dir = await add('demo', manifest({ parameters: { text: { type: 'string' } } }));
  const script = resolveScript(await discoverScripts(), 'demo');
  for (const source of ['toast("x");', 'var other = 1; var input = __AUTOX_INPUT__;',
    'var input = "__AUTOX_INPUT__";', '// __AUTOX_INPUT__', '/* var input = __AUTOX_INPUT__; */',
    'var input = __AUTOX_INPUT__; // __AUTOX_INPUT__', 'var input = __AUTOX_INPUT__']) {
    await fs.writeFile(path.join(dir, 'main.js'), source);
    await assert.rejects(compileScript(root, script, {}), /placeholder|prologue/);
  }
  // Metadata queries do not parse/read entry bodies; validate does.
  assert.equal(JSON.parse((await run(['scripts', 'show', 'demo'])).stdout).manifest.name, 'demo');
  await assert.rejects(run(['scripts', 'validate']), error => error.code === 1 && JSON.parse(error.stdout).diagnostics.length === 1);
  const ordinary = '\ufeff"ui";\r\nui.layout(<vertical/>);\r\n';
  await add('plain', manifest({ name: 'plain' }), ordinary);
  const plain = resolveScript(await discoverScripts(), 'plain');
  assert.equal((await compileScript(root, plain)).script, ordinary);
  await fs.writeFile(plain.entryPath, Buffer.from([0xff]));
  await assert.rejects(compileScript(root, plain), /encoded data|encoding/i);
});

test('identity remains stable across input/content changes and distinguishes same-name locations', async t => {
  const { add, root } = await setup(t);
  const dir = await add();
  const first = resolveScript(await discoverScripts(), 'demo');
  await fs.writeFile(path.join(dir, 'main.js'), 'new content');
  assert.equal(resolveScript(await discoverScripts(), 'demo').id, first.id);
  await fs.rename(dir, path.join(root, 'moved'));
  assert.notEqual(resolveScript(await discoverScripts(), 'demo').id, first.id);
});

test('CLI run/rerun/x/stop reuse wire protocol and enforce inputs and device selection', async t => {
  const { add, run } = await setup(t);
  await add('demo', manifest({ parameters: { value: { type: 'number', required: true } } }), '"use strict";\nvar input = __AUTOX_INPUT__;\nconsole.log(input.value);');
  const { bridge, url } = await fixture(t);
  const a = await device(t, bridge, { name: 'A' });
  const info = JSON.parse((await run(['scripts', 'show', 'demo'])).stdout);
  for (const args of [['scripts', 'run'], ['scripts', 'rerun'], ['x']]) {
    const output = JSON.parse((await run([...args, 'demo', '--input', '{"value":2}', '--device', a.id], url)).stdout);
    assert.equal(output.ok, true);
    assert.equal(output.results[0].status, 'sent');
    const frame = await a.next();
    assert.equal(frame.data.command, args[1] === 'rerun' ? 'rerun' : 'run');
    assert.equal(frame.data.id, info.id);
    assert.equal(frame.data.name, 'demo.js');
    assert.match(frame.data.script, /JSON.parse/);
    assert.deepEqual(Object.keys(frame.data).sort(), ['command', 'id', 'name', 'script']);
  }
  // Default selection works with one device.
  await run(['x', 'demo', '--input', '{"value":3}'], url);
  await a.next();
  await run(['scripts', 'stop', 'demo', '--device', a.id], url);
  assert.deepEqual((await a.next()).data, { command: 'stop', id: info.id });
  for (const input of ['{}', '{"value":"2"}', '{"value":2,"extra":true}', '[]', '{oops']) {
    await assert.rejects(run(['x', 'demo', '--input', input], url), error => error.code === 1 && typeof JSON.parse(error.stderr).error === 'string');
  }
  const b = await device(t, bridge, { name: 'B' });
  await assert.rejects(run(['x', 'demo', '--input', '{"value":2}'], url), error => error.code === 1);
  await assert.rejects(run(['x', 'demo', '--input', '{"value":2}', '--all', '--device', a.id], url), error => error.code === 1);
  await run(['x', 'demo', '--input', '{"value":2}', '--all'], url);
  assert.equal((await a.next()).data.command, 'run');
  assert.equal((await b.next()).data.command, 'run');
});
