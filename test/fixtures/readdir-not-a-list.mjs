// Preloaded with `node --import` into a CLI run: reading the pidfile directory returns something
// that is not a list of names, so the reaper throws where no record can make it throw. Lets a test
// reach the CLI's guard around reaping.
import fs from 'node:fs';

const readdirSync = fs.readdirSync;
fs.readdirSync = (dir, ...rest) => (String(dir).includes('mcp-patchbay-') ? null : readdirSync(dir, ...rest));
