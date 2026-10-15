/** The real terminal behind `Prompter` and the `--json` stdin command channel. */
import { createInterface } from 'node:readline';
import type { Prompter } from './follow';

/** Prompts go to stderr so stdout stays a clean transcript (or clean NDJSON). */
export function createTerminalPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Prompter & { close(): void } {
  const rl = createInterface({ input, output, terminal: false });
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (line) => {
    const w = waiting.shift();
    if (w) w(line); else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w(null);
  });
  return {
    ask(prompt, signal) {
      output.write(prompt);
      const buffered = lines.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (closed || signal.aborted) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        const done = (v: string | null): void => { signal.removeEventListener('abort', onAbort); resolve(v); };
        const onAbort = (): void => {
          const i = waiting.indexOf(done);
          if (i >= 0) waiting.splice(i, 1);
          output.write('\n');
          done(null);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiting.push(done);
      });
    },
    close: () => rl.close(),
  };
}

/** Read NDJSON commands from `input` until it ends. Lines that are not JSON objects are reported, not fatal. */
export function readJsonCommands(
  input: NodeJS.ReadableStream,
  onCommand: (cmd: Record<string, unknown>) => void,
  onBad: (line: string) => void,
  onEnd: () => void,
): () => void {
  const rl = createInterface({ input, terminal: false });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) onCommand(parsed as Record<string, unknown>);
      else onBad(t);
    } catch {
      onBad(t);
    }
  });
  rl.on('close', onEnd);
  return () => rl.close();
}
