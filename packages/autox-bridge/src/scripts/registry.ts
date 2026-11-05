import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { errorMessage } from '../errors.js';
import { isRecord } from '../protocol.js';
import { parseManifest } from './manifest.js';
import type { RegisteredScript, ScriptRegistry } from './types.js';

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_REGISTRY_ENTRIES = 1024;

export function userScriptsDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const config = env.XDG_CONFIG_HOME;
  if (config && !path.isAbsolute(config)) throw new Error('XDG_CONFIG_HOME must be an absolute path');
  return path.join(config || path.join(home, '.config'), 'autox', 'scripts');
}

async function directory(file: string) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected a directory, not a symlink: ${file}`);
}

/** Check each component under a trusted root. This is not an OS sandbox against concurrent directory replacement. */
export async function checkScriptFile(root: string, file: string, maxBytes: number): Promise<void> {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Script file must stay inside registry');
  await directory(root);
  let current = root;
  const parts = relative.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    await directory(current);
  }
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Expected a regular file, not a symlink: ${file}`);
  if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${file}`);
}

export async function readScriptFile(root: string, file: string, maxBytes: number): Promise<string> {
  await checkScriptFile(root, file, maxBytes);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Expected regular file of at most ${maxBytes} bytes: ${file}`);
    // Read at most limit + 1 even if the file grows after stat().
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${file}`);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

/** Only direct child directories are registrations; no project or recursive discovery. */
export async function discoverScripts(): Promise<ScriptRegistry> {
  const requested = userScriptsDirectory();
  const result: ScriptRegistry = { root: requested, scripts: [], diagnostics: [] };
  try { await directory(requested); }
  catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return result;
    throw error;
  }
  result.root = await fs.realpath(requested);
  const entries = [];
  const dir = await fs.opendir(result.root);
  for await (const entry of dir) {
    if (entries.length >= MAX_REGISTRY_ENTRIES) throw new Error(`Registry exceeds ${MAX_REGISTRY_ENTRIES} directory entries`);
    entries.push(entry);
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const folder = path.join(result.root, entry.name);
    let name: string | undefined;
    try {
      await directory(folder);
      const manifestPath = path.join(folder, 'script.json');
      const raw: unknown = JSON.parse(await readScriptFile(result.root, manifestPath, MAX_MANIFEST_BYTES));
      // Reserve a declared name even when other fields are invalid: never fall back
      // to a different same-name script merely because this registration broke.
      if (isRecord(raw) && typeof raw.name === 'string') name = raw.name;
      const manifest = parseManifest(raw);
      name = manifest.name;
      const entryPath = path.join(folder, manifest.entry);
      await checkScriptFile(result.root, entryPath, MAX_SCRIPT_BYTES);
      const digest = createHash('sha256').update(JSON.stringify([folder, manifest.name])).digest('hex');
      result.scripts.push({ directory: folder, manifestPath, entryPath, id: `autox-script:${digest}`, manifest });
    } catch (error) {
      result.diagnostics.push({ directory: folder, ...(name ? { name } : {}), error: errorMessage(error) });
    }
  }
  const names = new Map<string, string[]>();
  for (const item of [...result.scripts.map(script => ({ name: script.manifest.name, directory: script.directory })), ...result.diagnostics]) {
    if (item.name) names.set(item.name, [...(names.get(item.name) ?? []), item.directory]);
  }
  for (const [name, folders] of names) {
    if (folders.length > 1) result.diagnostics.push({ name, directory: result.root, error: `Duplicate script name ${name}: ${folders.join(', ')}` });
  }
  return result;
}

export function resolveScript(registry: ScriptRegistry, name: string): RegisteredScript {
  const issues = registry.diagnostics.filter(issue => issue.name === name);
  if (issues.length) throw new Error(issues.map(issue => issue.error).join('; '));
  const script = registry.scripts.find(item => item.manifest.name === name);
  if (!script) throw new Error(`Script not found: ${name}. Use scripts list to inspect ${registry.root}`);
  return script;
}
