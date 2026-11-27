// Preloaded with `node --import` into a CLI run: every fs.fstatSync fails with EIO, as a failing
// disk would. Lets a test reach the paths for a config load error that is not a ConfigError.
import fs from 'node:fs';

fs.fstatSync = () => {
  throw Object.assign(new Error('EIO: i/o error, fstat'), { code: 'EIO' });
};
