// Small file helpers shared by import and rename-permissions.
import fs from 'node:fs';
import path from 'node:path';

/** A UTC timestamp usable in a file name. */
export function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * Copies `file` to `<file>.bak-<timestamp>` and returns the backup path, or null if `file`
 * does not exist.
 * @param {string} file
 * @param {number} [mode] mode for the backup (default: the original's)
 */
export function backup(file, mode) {
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  let bak = `${file}.bak-${stamp()}`;
  for (let i = 1; fs.existsSync(bak); i++) bak = `${file}.bak-${stamp()}-${i}`;
  fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(bak, mode ?? (st.mode & 0o777));
  return bak;
}

/**
 * Writes `content` atomically (temp file + rename) with the given mode.
 * @param {string} file
 * @param {string} content
 * @param {number} mode
 */
export function writeAtomic(file, content, mode) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
