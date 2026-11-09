import fs from 'node:fs';

/** The package version, read from package.json once. */
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
