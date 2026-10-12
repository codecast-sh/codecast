import { spawnSync } from 'node:child_process';

import { UsageError } from '@platform/evals/cli';

/** One `cast <args> --json` read through the person's own CLI, parsed; a failure is the usage error naming the command and its last line. */
export function castJson(args: string[]): any {
  const r = spawnSync('cast', [...args, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new UsageError(`cast ${args.join(' ')} --json failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  return JSON.parse(r.stdout);
}
