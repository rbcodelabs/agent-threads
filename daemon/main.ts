/** Bundle entry for dist/agent-threads.cjs. */
import { runCli } from './cli';

// `agent-threads list | head`: a closed pipe is the reader's choice, not an error worth a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

runCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
