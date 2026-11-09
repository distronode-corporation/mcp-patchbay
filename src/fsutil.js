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
 * Writes `content` atomically (temp file + rename) with the given mode. A symlink is written
 * through (dotfile managers link settings files), not replaced, and the temp file never outlives
 * a failure.
 * @param {string} file
 * @param {string} content
 * @param {number} mode
 */
export function writeAtomic(file, content, mode) {
  let target = file;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) target = fs.realpathSync(file);
  } catch { /* a new file, or a dangling link: write the path itself */ }
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}
