import { runGa4 } from './ga4.js';
import { runGsc } from './gsc.js';
import { runBing } from './bing.js';

const sources = { ga4: runGa4, gsc: runGsc, bing: runBing };
const failed = [];

for (const [name, run] of Object.entries(sources)) {
  try {
    await run();
  } catch (err) {
    failed.push(name);
    console.error(`\n== ${name.toUpperCase()}: ERROR ==\n${err.message || err}`);
  }
}

console.log(`\nResultado: ${Object.keys(sources).length - failed.length}/${Object.keys(sources).length} fuentes OK${failed.length ? ` (fallan: ${failed.join(', ')})` : ''}`);
process.exitCode = failed.length ? 1 : 0;
