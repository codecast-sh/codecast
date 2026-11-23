import { describe, expect, test } from 'bun:test';
import { rowEnvMeId, rowEnvRolesSig, rowEnvRoster } from './inboxRowEnv';

// The inbox rows' shared env (components/SessionItem InboxRowEnvProvider)
// changes only when something a row draws changes: a store subscription keeps
// its value while the selector returns the same thing (Object.is), so the
// context, and every row under it, holds still through a heartbeat.

const TEAM = 'team-1';
const member = (id: string, name: string, presence: object) => ({ _id: id, name, image: `https://img/${id}`, roster_team: TEAM, ...presence });
const role = (name: string) => ({ _id: 'r1', short_id: 'rl-1', handle: 'hooks', name, avatar: null, status: 'active' });

function state(opts: { beat: number; seat: string; roleName?: string; sarah?: string }) {
  return {
    currentUser: { _id: 'me' },
    clientState: { ui: { active_team_id: TEAM } },
    teamMembers: [
      member('me', 'Alex', { last_seen_at: opts.beat, presence: 'active' }),
      member('sarah', opts.sarah ?? 'Sarah', { last_seen_at: opts.beat - 5, presence: opts.beat % 2 ? 'active' : 'idle' }),
    ],
    viewerRoles: { r1: role(opts.roleName ?? 'Webhooks lead') },
    anchors: { a1: { bot_user_id: 'bot-1', status: opts.seat, role: { _id: 'r1' } } },
    orgTree: null,
    orgIntents: null,
  };
}

const env = (s: any) => [rowEnvMeId(s), rowEnvRoster(s), rowEnvRolesSig(s)] as const;

describe('inbox row env', () => {
  test('a presence heartbeat and a seat changing state leave every value as it was', () => {
    const before = env(state({ beat: 1, seat: 'working' }));
    const after = env(state({ beat: 2, seat: 'idle' }));
    for (let i = 0; i < before.length; i++) expect(Object.is(before[i], after[i])).toBe(true);
  });

  test('a rename of a teammate or of the role changes it', () => {
    const before = env(state({ beat: 1, seat: 'working' }));
    expect(Object.is(rowEnvRoster(state({ beat: 1, seat: 'working', sarah: 'Sarah Chen' })), before[1])).toBe(false);
    expect(rowEnvRolesSig(state({ beat: 1, seat: 'working', roleName: 'Hooks lead' }))).not.toBe(before[2]);
  });
});
