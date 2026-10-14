/** Bundle entry for dist/agent-threads.cjs. */
import { runCli } from './cli';

runCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
