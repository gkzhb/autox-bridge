import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import archiver from 'archiver';
import { MAX_PAYLOAD, isRecord } from './protocol.js';

const hash = data => createHash('sha256').update(data).digest('hex');

/** Ignore entries are relative paths, not globs, with an optional strict reference prefix/exclusion mode. */
export async function packageProject(folder, previous = new Map(), { full = false, maxBytes = MAX_PAYLOAD - 65536, referenceFiles = false } = {}) {
  folder = await fs.realpath(folder);
  const config = JSON.parse(await fs.readFile(path.join(folder, 'project.json'), 'utf8'));
  if (!isRecord(config) || (config.ignore !== undefined && (!Array.isArray(config.ignore) || config.ignore.some(x => typeof x !== 'string')))) {
    throw new Error('project.json must be an object with an optional string[] ignore');
  }
  const ignores = [...(referenceFiles ? [] : ['.git', 'node_modules']), ...(config.ignore ?? [])].map(entry => {
    const normalized = path.posix.normalize(entry.replaceAll('\\', '/'));
    if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`ignore path must stay inside project: ${entry}`);
    }
    return referenceFiles ? normalized : normalized.replace(/\/$/, '');
  });
  const ignored = rel => ignores.some(p => referenceFiles
    ? path.join(folder, rel).startsWith(path.join(folder, p))
    : p === '.' || rel === p || rel.startsWith(`${p}/`));
  const snapshot = new Map();
  const files = [];
  let totalBytes = 0;
  async function walk(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix + entry.name;
      if (ignored(rel)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Project symlinks are not supported: ${rel}`);
      if (entry.isDirectory()) { await walk(absolute, `${rel}/`); continue; }
      if (!entry.isFile()) throw new Error(`Unsupported project file: ${rel}`);
      const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let data;
      try {
        const stat = await handle.stat();
        totalBytes += stat.size;
        if (totalBytes > maxBytes) throw new Error(`Project exceeds ${maxBytes} bytes (uncompressed)`);
        data = await handle.readFile();
        totalBytes += data.length - stat.size;
        if (totalBytes > maxBytes) throw new Error(`Project exceeds ${maxBytes} bytes (uncompressed)`);
      } finally { await handle.close(); }
      const digest = hash(data);
      snapshot.set(rel, digest);
      if (full || previous.get(rel) !== digest) files.push({ name: rel, data });
    }
  }
  await walk(folder);
  const removed = [...previous.keys()].filter(name => !snapshot.has(name));
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks = [];
  let zippedBytes = 0;
  const completed = new Promise((resolve, reject) => {
    archive.on('data', chunk => {
      zippedBytes += chunk.length;
      if (zippedBytes > MAX_PAYLOAD) { reject(new Error('Project ZIP exceeds 64 MiB')); archive.abort(); return; }
      chunks.push(chunk);
    });
    archive.once('error', reject);
    archive.once('warning', reject);
    archive.once('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const file of files) archive.append(file.data, { name: file.name, date: new Date('2000-01-01T00:00:00Z'), mode: 0o644 });
  const [buffer] = await Promise.all([completed, archive.finalize()]);
  return { folder, buffer, md5: createHash('md5').update(buffer).digest('hex'), snapshot,
    files: files.map(file => file.name), removed };
}

export async function createProject(folder, name = path.basename(path.resolve(folder))) {
  folder = path.resolve(folder);
  await fs.mkdir(folder, { recursive: true });
  const configPath = path.join(folder, 'project.json');
  const mainPath = path.join(folder, 'main.js');
  // Never overwrite either file, even when the other one is absent.
  for (const file of [configPath, mainPath]) {
    try { await fs.lstat(file); throw new Error(`Refusing to overwrite ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const config = { name, main: 'main.js', ignore: ['build'], packageName: 'com.example', versionName: '1.0.0', versionCode: 1 };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(mainPath, "toast('Hello, AutoX.js');\n", { flag: 'wx' });
  return { folder, files: ['project.json', 'main.js'] };
}
