// ota.sh signs eas in the same way on every machine that sends: EXPO_TOKEN, else the Vault's
// expo-publish-token, else the machine's own eas login, and says which machine lacked all three.
// Runs the real script against a throwaway origin, with eas, cast and bun stubbed.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OTA = path.join(import.meta.dir, 'ota.sh');
let dir: string;
let clone: string;
let calls: string;
let sha: string;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ota-test-')));
  calls = path.join(dir, 'calls.log');
  git(dir, 'init', '-q', '--bare', 'origin.git');
  clone = path.join(dir, 'clone');
  git(dir, 'clone', '-q', 'origin.git', 'clone');
  write(path.join(clone, 'packages/mobile/app.json'), JSON.stringify({ expo: { platforms: ['ios'] } }));
  git(clone, 'add', '.');
  git(clone, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'Ship it');
  git(clone, 'push', '-q', 'origin', 'HEAD');
  sha = git(clone, 'rev-parse', 'HEAD');
  // eas: logs the token it sees and each command; whoami and channel:list answer as the case sets.
  write(path.join(dir, 'eas'), `#!/bin/bash
echo "eas token=\${EXPO_TOKEN:-} $*" >> "${calls}"
case "$1" in
  whoami) exit "\${WHOAMI_EXIT:-0}" ;;
  channel:list)
    if [ -n "\${LIST_FAILS:-}" ]; then echo "An Expo user account is required to proceed." >&2; exit 1; fi
    echo '{"currentPage":[{"name":"production","isPaused":false},{"name":"old","isPaused":true}]}' ;;
esac
`);
  // cast vault run <name> -- <cmd>: the token in the command's env when the Vault holds one.
  write(path.join(dir, 'bin/cast'), `#!/bin/bash
echo "cast $*" >> "${calls}"
if [ "$1 $2 $3 $4" = "vault run expo-publish-token --" ]; then
  if [ -z "\${VAULT_HAS:-}" ]; then echo "Error: expo-publish-token has no value yet" >&2; exit 1; fi
  shift 4; EXPO_TOKEN=from-vault exec "$@"
fi
exit 1
`);
  write(path.join(dir, 'bin/bun'), '#!/bin/bash\nexit 0\n');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function ota(env: Record<string, string>) {
  const base: Record<string, string> = { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, EAS: path.join(dir, 'eas'), TMPDIR: dir } as Record<string, string>;
  delete base.EXPO_TOKEN;
  const r = spawnSync('bash', [OTA, sha], { cwd: clone, env: { ...base, ...env }, encoding: 'utf-8' });
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf-8').trim().split('\n') : [];
  return { code: r.status, stderr: r.stderr.trim(), log };
}

describe('ota.sh signs in to Expo', () => {
  test("with the Vault's token when it holds one, on every eas call and with no login check", () => {
    const r = ota({ VAULT_HAS: '1', WHOAMI_EXIT: '1' });
    expect(r.code).toBe(0);
    const eas = r.log.filter((l) => l.startsWith('eas '));
    expect(eas).toEqual([
      'eas token=from-vault channel:list --json --non-interactive',
      'eas token=from-vault update --channel production --platform ios --message Ship it --non-interactive',
    ]);
  });

  test('with EXPO_TOKEN from the environment, reading no Vault', () => {
    const r = ota({ EXPO_TOKEN: 'from-env', VAULT_HAS: '1' });
    expect(r.code).toBe(0);
    expect(r.log.some((l) => l.startsWith('cast '))).toBe(false);
    expect(r.log.filter((l) => l.startsWith('eas ')).every((l) => l.startsWith('eas token=from-env '))).toBe(true);
  });

  test("with the machine's own eas login when the Vault has no token", () => {
    const r = ota({});
    expect(r.code).toBe(0);
    expect(r.log.filter((l) => l.startsWith('eas ')).map((l) => l.split(' ')[2])).toEqual(['whoami', 'channel:list', 'update']);
  });

  test('stops before any worktree or upload, naming the machine, when nothing signs it in', () => {
    const r = ota({ WHOAMI_EXIT: '1' });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`Expo sign-in required on ${spawnSync('hostname', ['-s'], { encoding: 'utf-8' }).stdout.trim()}: no EXPO_TOKEN here, no value for expo-publish-token in the Vault, and no eas login on this machine`);
    expect(r.log.filter((l) => l.startsWith('eas ')).map((l) => l.split(' ')[2])).toEqual(['whoami']);
    expect(git(clone, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  test("ends on eas's own error when channel:list fails, not a JSON parse of it", () => {
    const r = ota({ VAULT_HAS: '1', LIST_FAILS: '1' });
    expect(r.code).toBe(1);
    expect(r.stderr.split('\n').pop()).toBe('An Expo user account is required to proceed.');
    expect(r.log.some((l) => l.includes(' update '))).toBe(false);
  });
});
