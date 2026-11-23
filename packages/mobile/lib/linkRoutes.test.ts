import { test, expect, describe } from 'bun:test';
import {
  mobileRouteForUrl,
  mobileEntityRoute,
  trimUrlTail,
  shortenUrl,
  urlPattern,
  isMentionStart,
  mobileNotificationRoute,
} from './linkRoutes';
import { MOBILE_SETTINGS_SECTIONS } from './settingsSections';

describe('mobileRouteForUrl', () => {
  test('codecast object URLs route in the app', () => {
    expect(mobileRouteForUrl('https://codecast.sh/tasks/ct-4102')).toBe('/task/ct-4102');
    expect(mobileRouteForUrl('https://codecast.sh/plans/pl-88')).toBe('/plan/pl-88');
    expect(mobileRouteForUrl('https://codecast.sh/conversation/abc123')).toBe('/session/abc123');
    expect(mobileRouteForUrl('https://www.codecast.sh/docs/xyz')).toBe('/doc/xyz');
    expect(mobileRouteForUrl('https://codecast.sh/decisions/sd-289')).toBe('/decisions/sd-289');
    expect(mobileRouteForUrl('https://codecast.sh/decisions/stacks/ds-4')).toBeNull();
  });

  test('share links of every kind land on the /share resolver screen', () => {
    expect(mobileRouteForUrl('https://codecast.sh/share/Tok123')).toBe('/share/Tok123');
    expect(mobileRouteForUrl('https://codecast.sh/share/doc/1a221088-1fc3-48c8-a814-71119676adf0'))
      .toBe('/share/doc/1a221088-1fc3-48c8-a814-71119676adf0');
    expect(mobileRouteForUrl('https://codecast.sh/share/plan/abc123def')).toBe('/share/plan/abc123def');
    expect(mobileRouteForUrl('https://codecast.sh/share/message/abc123def')).toBe('/share/message/abc123def');
    // A sub-kind word with no token is a malformed link, not a token.
    expect(mobileRouteForUrl('https://codecast.sh/share/doc')).toBeNull();
  });

  test('a page link carrying its share token opens in the app with the token', () => {
    // The web share button's link, pasted in team chat: it used to fall
    // through to Safari because the token kept it from parsing as a reference.
    expect(mobileRouteForUrl('https://codecast.sh/conversation/jx72x09rbqp73a1ah3dg5p6dc98hmbwg?share=296274eb-764f-46fb-b73c-b5dd0c2a1ce0'))
      .toBe('/share/296274eb-764f-46fb-b73c-b5dd0c2a1ce0');
    expect(mobileRouteForUrl('https://codecast.sh/docs/jd7abc123def456ghi789jkl012mno34?share=Tok123')).toBe('/doc/jd7abc123def456ghi789jkl012mno34?share=Tok123');
    expect(mobileRouteForUrl('https://codecast.sh/plans/pl-88?share=Tok123')).toBe('/plan/pl-88?share=Tok123');
    expect(mobileRouteForUrl('https://codecast.sh/tasks/ct-4102?share=Tok123')).toBe('/task/ct-4102');
    expect(mobileRouteForUrl('https://example.com/conversation/jx72x09rbqp73a1ah3dg5p6dc98hmbwg?share=x')).toBeNull();
  });

  test('settings sections the phone has a page for open there', () => {
    expect(mobileRouteForUrl('https://codecast.sh/settings/devices')).toBe('/settings/devices');
    expect(mobileRouteForUrl('https://codecast.sh/settings/notifications')).toBe('/settings/notifications');
    expect(mobileRouteForUrl('https://codecast.sh/settings')).toBe('/(tabs)/settings');
    expect(mobileRouteForUrl('https://codecast.sh/settings/keyboard')).toBeNull();
  });

  test('a link to one message opens its session at that message', () => {
    expect(mobileRouteForUrl('https://codecast.sh/conversation/jx72x09rbqp73a1ah3dg5p6dc98hmbwg#msg-jn7abcdefghijklmnopqrstuvwxyz012'))
      .toBe('/session/jx72x09rbqp73a1ah3dg5p6dc98hmbwg?message=jn7abcdefghijklmnopqrstuvwxyz012');
  });

  test('the retired assistant lane leads to the main app screens', () => {
    expect(mobileRouteForUrl('https://codecast.sh/simple')).toBe('/(tabs)/inbox');
    expect(mobileRouteForUrl('https://codecast.sh/simple/approvals')).toBe('/decisions');
    expect(mobileRouteForUrl('https://codecast.sh/simple/routines')).toBe('/(tabs)/tasks?segment=routines');
    expect(mobileRouteForUrl('https://codecast.sh/triggers')).toBe('/(tabs)/tasks?segment=routines');
    expect(mobileRouteForUrl('https://codecast.sh/team/activity?member=abc')).toBe('/(tabs)/chat?segment=activity');
    expect(mobileRouteForUrl('https://codecast.sh/simple/c/jx7abc123?x=1')).toBe('/session/jx7abc123');
    expect(mobileRouteForUrl('/simple/plan/')).toBe('/settings/plan');
    expect(mobileRouteForUrl('https://codecast.sh/simple/connections?whisk=connected')).toBe('/settings/mail');
    expect(mobileRouteForUrl('https://codecast.sh/simpler')).toBeNull();
  });

  test('web pages the phone has a screen for open there', () => {
    expect(mobileRouteForUrl('https://codecast.sh/inbox')).toBe('/(tabs)/inbox');
    expect(mobileRouteForUrl('https://codecast.sh/questions')).toBe('/decisions');
    expect(mobileRouteForUrl('https://codecast.sh/decisions?tab=team')).toBe('/decisions');
    expect(mobileRouteForUrl('https://codecast.sh/settings/plan?billing=done')).toBe('/settings/plan');
    expect(mobileRouteForUrl('https://codecast.sh/settings/integrations')).toBe('/settings/mail');
  });

  test('the tasks, notifications and settings pages open their tabs', () => {
    expect(mobileRouteForUrl('https://codecast.sh/tasks')).toBe('/(tabs)/tasks');
    expect(mobileRouteForUrl('/tasks/')).toBe('/(tabs)/tasks');
    expect(mobileRouteForUrl('https://codecast.sh/notifications')).toBe('/(tabs)/notifications');
    expect(mobileRouteForUrl('https://codecast.sh/settings')).toBe('/(tabs)/settings');
  });

  test('a settings section the phone has opens its page', () => {
    for (const key of MOBILE_SETTINGS_SECTIONS) {
      // Plan and mail are reached by the web's own names for them too.
      expect(mobileRouteForUrl(`https://codecast.sh/settings/${key}`)).toBe(`/settings/${key}`);
    }
    // The link the Notifications tab's own "manage devices" row opens.
    expect(mobileRouteForUrl('https://codecast.sh/settings/devices')).toBe('/settings/devices');
    expect(mobileRouteForUrl('/settings/notifications/')).toBe('/settings/notifications');
  });

  test('the Vault and a secret open the Vault settings page', () => {
    expect(mobileRouteForUrl('https://codecast.sh/vault')).toBe('/settings/vault');
    expect(mobileRouteForUrl('/vault?s=sec-4')).toBe('/settings/vault?s=sec-4');
    expect(mobileEntityRoute('secret', 'sec-12')).toBe('/settings/vault?s=sec-12');
  });

  test("the web's short page names open the same screens", () => {
    expect(mobileRouteForUrl('https://codecast.sh/approvals')).toBe('/decisions');
    expect(mobileRouteForUrl('https://codecast.sh/plan')).toBe('/settings/plan');
    expect(mobileRouteForUrl('/mail')).toBe('/settings/mail');
    expect(mobileRouteForUrl('https://codecast.sh/integrations/')).toBe('/settings/mail');
    expect(mobileRouteForUrl('https://codecast.sh/routines')).toBe('/(tabs)/tasks?segment=routines');
  });

  test('invites and chat land on the chat tab', () => {
    expect(mobileRouteForUrl('https://codecast.sh/join/abc')).toBe('/(tabs)/chat');
    expect(mobileRouteForUrl('https://codecast.sh/chat')).toBe('/(tabs)/chat');
  });

  test('calls, plans and docs open their own screens', () => {
    expect(mobileRouteForUrl('https://codecast.sh/calls')).toBe('/calls');
    expect(mobileRouteForUrl('https://codecast.sh/plans')).toBe('/(tabs)/tasks?segment=plans');
    expect(mobileRouteForUrl('/docs')).toBe('/(tabs)/tasks?segment=docs');
  });

  test('the org, a role and the root open their screens; a tab link opens the board', () => {
    expect(mobileRouteForUrl('https://codecast.sh/org')).toBe('/org');
    expect(mobileRouteForUrl('/org/or-12')).toBe('/org/or-12');
    expect(mobileRouteForUrl('https://codecast.sh/org/workspace')).toBe('/org/workspace');
    expect(mobileRouteForUrl('https://codecast.sh/org/or-12?tab=feed')).toBe('/org/or-12/board');
    expect(mobileRouteForUrl('https://example.com/org/or-12')).toBeNull();
  });

  test('a role reference opens its screen; a person opens the person screen by handle', () => {
    expect(mobileEntityRoute('role', 'or-12')).toBe('/org/or-12');
    expect(mobileEntityRoute('person', 'samvit')).toBe('/person/samvit');
    expect(mobileEntityRoute('person', '@samvit')).toBe('/person/samvit');
    expect(mobileEntityRoute('person', ' ')).toBeNull();
    expect(mobileRouteForUrl('https://codecast.sh/org/@samvit')).toBe('/person/samvit');
    expect(mobileRouteForUrl('/org/%40samvit')).toBe('/person/samvit');
    expect(mobileRouteForUrl('https://codecast.sh/team/samvit')).toBe('/person/samvit');
    expect(mobileRouteForUrl('https://codecast.sh/team/activity')).toBe('/(tabs)/chat?segment=activity');
    expect(mobileRouteForUrl('https://codecast.sh/team/charts')).toBeNull();
  });

  test('a project and a goal open their own screens from every address', () => {
    expect(mobileEntityRoute('project', 'pj-mf3k2a')).toBe('/project/pj-mf3k2a');
    expect(mobileEntityRoute('initiative', 'in-2')).toBe('/goal/in-2');
    expect(mobileRouteForUrl('https://codecast.sh/projects/pj-mf3k2a')).toBe('/project/pj-mf3k2a');
    expect(mobileRouteForUrl('https://codecast.sh/projects/pj-mf3k2a?tab=tasks')).toBe('/project/pj-mf3k2a');
    expect(mobileRouteForUrl('/goals/in-2')).toBe('/goal/in-2');
    expect(mobileRouteForUrl('https://codecast.sh/initiatives/in-2')).toBe('/goal/in-2');
    expect(mobileRouteForUrl('https://codecast.sh/org/in-2')).toBe('/goal/in-2');
    expect(mobileRouteForUrl('https://codecast.sh/org/pj-mf3k2a')).toBe('/project/pj-mf3k2a');
    // A task opened inside its project is the task.
    expect(mobileRouteForUrl('https://codecast.sh/projects/pj-mf3k2a/ct-12')).toBe('/task/ct-12');
    expect(mobileRouteForUrl('https://codecast.sh/projects')).toBeNull();
  });

  test('a published page opens its screen in the app', () => {
    expect(mobileRouteForUrl('https://codecast.sh/a/my-report')).toBe('/page/my-report');
    expect(mobileRouteForUrl('https://codecast.sh/a/my-report?c=k1')).toBe('/page/my-report?c=k1');
  });

  test('a web settings section with no phone page has no route', () => {
    expect(mobileRouteForUrl('https://codecast.sh/settings/keyboard')).toBeNull();
    expect(mobileRouteForUrl('https://codecast.sh/settings/devices/extra')).toBeNull();
  });

  test('other hosts are never captured', () => {
    expect(mobileRouteForUrl('https://example.com/tasks/ct-1')).toBeNull();
    expect(mobileRouteForUrl('https://evil.com/codecast.sh/tasks/ct-1')).toBeNull();
    expect(mobileRouteForUrl('mailto:hi@example.com')).toBeNull();
    expect(mobileRouteForUrl('not a url')).toBeNull();
  });

  test('a call opens its recording screen, at the moment or lines it names', () => {
    expect(mobileEntityRoute('call', 'cl-117')).toBe('/recording/cl-117');
    expect(mobileEntityRoute('call', 'cl-117@2:30')?.startsWith('/recording/cl-117?t=150')).toBe(true);
    expect(mobileEntityRoute('call', 'cl-117:5-9')).toBe('/recording/cl-117?turns=5-9');
    // A pasted call page link keeps its moment.
    expect(mobileRouteForUrl('https://codecast.sh/calls/cl-117?t=150')?.startsWith('/recording/cl-117?t=150')).toBe(true);
  });

  test('a trigger opens its own screen, by short id or Convex id', () => {
    expect(mobileEntityRoute('trigger', 'tr-42')).toBe('/trigger/tr-42');
    expect(mobileRouteForUrl('https://codecast.sh/triggers/tr-42')).toBe('/trigger/tr-42');
    expect(mobileRouteForUrl('https://codecast.sh/triggers?task=tr-42')).toBe('/trigger/tr-42');
    expect(mobileRouteForUrl('https://codecast.sh/triggers')).toBe('/(tabs)/tasks?segment=routines');
  });
});

describe('URL detection', () => {
  const all = (s: string) => s.match(urlPattern()) ?? [];

  test('finds the forms people actually paste', () => {
    expect(all('see https://a.com/x and www.b.org plus mailto:x@y.z')).toEqual([
      'https://a.com/x',
      'www.b.org',
      'mailto:x@y.z',
    ]);
  });

  test('leaves a bare email alone — git@github.com is not a link', () => {
    expect(all('clone git@github.com:ashot/codecast.git')).toEqual([]);
  });

  test('sentence punctuation is prose, not URL', () => {
    const [m] = all('Go to https://example.com/page.');
    expect(m).toBe('https://example.com/page.');
    expect(trimUrlTail(m)).toBe('https://example.com/page');
    expect(trimUrlTail('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });
});

describe('shortenUrl', () => {
  test('short URLs are shown whole', () => {
    expect(shortenUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  test('long URLs collapse to host plus a hint of the path', () => {
    const long = 'https://example.com/a/very/long/path/that/keeps/going/and/going/forever';
    expect(shortenUrl(long)).toBe('example.com/a/very/long/path/th…');
  });
});

describe('isMentionStart', () => {
  test('a leading or space-preceded @ is a mention', () => {
    expect(isMentionStart('@ashot ships', 0)).toBe(true);
    expect(isMentionStart('ping @ashot', 5)).toBe(true);
    expect(isMentionStart('(@ashot)', 1)).toBe(true);
  });

  test('an @ inside an address is not', () => {
    const remote = 'git@github.com:ashot/codecast.git';
    expect(isMentionStart(remote, remote.indexOf('@'))).toBe(false);
    const mail = 'write to hi.there@example.com';
    expect(isMentionStart(mail, mail.indexOf('@'))).toBe(false);
  });
});

describe('redirectSystemPath (+native-intent)', () => {
  // Imported lazily so this file keeps working if the route file moves.
  const { redirectSystemPath } = require('../app/+native-intent');

  test('web URLs re-route to their screens', () => {
    expect(redirectSystemPath({ path: 'https://codecast.sh/conversation/abc123', initial: true }))
      .toBe('/session/abc123');
    expect(redirectSystemPath({ path: 'https://codecast.sh/share/doc/1a221088-1fc3-48c8-a814-71119676adf0', initial: false }))
      .toBe('/share/doc/1a221088-1fc3-48c8-a814-71119676adf0');
  });

  test('the app scheme speaks the same vocabulary', () => {
    expect(redirectSystemPath({ path: 'codecast://tasks/ct-4102', initial: false })).toBe('/task/ct-4102');
    expect(redirectSystemPath({ path: 'codecast://share/abc123def', initial: false })).toBe('/share/abc123def');
  });

  test('everything unrecognized passes through untouched', () => {
    expect(redirectSystemPath({ path: 'codecast://auth/callback', initial: false })).toBe('codecast://auth/callback');
    expect(redirectSystemPath({ path: 'https://codecast.sh/settings/keyboard', initial: false })).toBe('https://codecast.sh/settings/keyboard');
    expect(redirectSystemPath({ path: 'exp://192.168.1.5:8081/--/session/x', initial: true })).toBe('exp://192.168.1.5:8081/--/session/x');
  });
});

describe('pull request links', () => {
  test('both web forms open the phone PR screen', () => {
    expect(mobileRouteForUrl('https://codecast.sh/pr/codecast-sh/codecast/412')).toBe('/pr/codecast-sh/codecast/412');
    expect(mobileRouteForUrl('https://codecast.sh/r/codecast-sh/codecast/pull/412')).toBe('/pr/codecast-sh/codecast/412');
    expect(mobileRouteForUrl('https://github.com/codecast-sh/codecast/pull/412')).toBe('/pr/codecast-sh/codecast/412');
  });
});

describe('commit and deploy links', () => {
  test('a commit opens the phone commit screen from every form', () => {
    expect(mobileEntityRoute('commit', 'codecast-sh/codecast@1a88ee73b')).toBe('/commit/codecast-sh/codecast/1a88ee73b');
    expect(mobileRouteForUrl('https://codecast.sh/commit/codecast-sh/codecast/1a88ee73b26d677374d8bd80da2e95361981359b')).toBe('/commit/codecast-sh/codecast/1a88ee73b26d677374d8bd80da2e95361981359b');
    expect(mobileRouteForUrl('https://github.com/Codecast-sh/codecast/commit/1A88EE73B')).toBe('/commit/codecast-sh/codecast/1a88ee73b');
    expect(mobileEntityRoute('commit', 'not-a-ref')).toBeNull();
  });

  test('a deploy opens the phone deploy screen', () => {
    expect(mobileEntityRoute('deploy', 'dp-1113')).toBe('/deploy/dp-1113');
    expect(mobileRouteForUrl('https://codecast.sh/deploys?deploy=dp-1113')).toBe('/deploy/dp-1113');
  });
});

describe('flow and proposal links', () => {
  test('a flow opens the phone flow screen by its slug, from the reference and the library link', () => {
    expect(mobileEntityRoute('flow', 'flow:change')).toBe('/flow/change');
    expect(mobileEntityRoute('flow', 'Flow:Prove-Implement')).toBe('/flow/prove-implement');
    expect(mobileRouteForUrl('https://codecast.sh/flows?view=flows&item=prove-implement')).toBe('/flow/prove-implement');
    expect(mobileRouteForUrl('/flows?item=change')).toBe('/flow/change');
    expect(mobileEntityRoute('flow', 'flow:-bad')).toBeNull();
  });

  test('a proposal opens the phone proposal screen, one change of it in focus', () => {
    expect(mobileEntityRoute('proposal', 'op-55')).toBe('/proposal/op-55');
    expect(mobileEntityRoute('proposal', 'OP-55#3')).toBe('/proposal/op-55?focus=3');
    expect(mobileRouteForUrl('https://codecast.sh/org?proposal=op-55')).toBe('/proposal/op-55');
    expect(mobileRouteForUrl('https://codecast.sh/org?proposal=op-55&focus=3')).toBe('/proposal/op-55?focus=3');
  });
});

describe('source, replay and Ops issue links', () => {
  test('a source opens the phone source screen by short id or name', () => {
    expect(mobileEntityRoute('source', 'src-13')).toBe('/source/src-13');
    expect(mobileRouteForUrl('https://codecast.sh/ops?source=src-13')).toBe('/source/src-13');
    expect(mobileRouteForUrl('https://codecast.sh/ops?source=codecast%20web')).toBe('/source/codecast%20web');
  });

  test('a replay opens the phone replay screen, keeping the moment a link names', () => {
    expect(mobileEntityRoute('replay', 'rp-10706')).toBe('/replay/rp-10706');
    expect(mobileRouteForUrl('https://codecast.sh/ops/replays/rp-10706')).toBe('/replay/rp-10706');
    expect(mobileRouteForUrl('https://codecast.sh/ops/replays/rp-10706?t=83')).toBe('/replay/rp-10706%401%3A23');
    expect(mobileEntityRoute('replay', 'rp-12@1:23')).toBe('/replay/rp-12%401%3A23');
  });

  test('an Ops issue page opens the phone issue screen', () => {
    expect(mobileRouteForUrl('https://codecast.sh/ops/issues/eg-2242')).toBe('/issue/eg-2242');
    expect(mobileRouteForUrl('/ops/issues/eg-2242')).toBe('/issue/eg-2242');
  });
});

describe('mobileNotificationRoute', () => {
  test('a stored path link opens its native screen', () => {
    expect(mobileNotificationRoute({ link: '/decisions/sd-3816', entity_type: 'task', entity_id: 'abc' })).toBe('/decisions/sd-3816');
    expect(mobileNotificationRoute({ link: '/workflows/runs/jx7run', entity_type: 'task', entity_id: 'abc' })).toBe('/run/jx7run');
    expect(mobileNotificationRoute({ link: 'https://codecast.sh/a/report-x?c=c1', entity_type: 'artifact', entity_id: 'report-x' })).toBe('/page/report-x?c=c1');
  });

  test('entity notifications open their screens, never the web', () => {
    expect(mobileNotificationRoute({ entity_type: 'task', entity_id: 'ct-1' })).toBe('/task/ct-1');
    expect(mobileNotificationRoute({ entity_type: 'chat_channel', entity_id: 'jx7abcdefghijklmnopqrstuvwxyz012', chat_message_id: 'jn7m' }))
      .toBe('/chat/jx7abcdefghijklmnopqrstuvwxyz012?m=jn7m');
    expect(mobileNotificationRoute({ entity_type: 'device', entity_id: 'd1' })).toBe('/settings/devices');
    expect(mobileNotificationRoute({ entity_type: 'machine', entity_id: 'dev-9' })).toBe('/offload/dev-9');
    expect(mobileNotificationRoute({ entity_type: 'metric_watch', entity_id: 'mw-4' })).toBe('/metric/mw-4');
    expect(mobileNotificationRoute({ entity_type: 'deploy', entity_id: 'dp-2374' })).toBe('/deploy/dp-2374');
    expect(mobileNotificationRoute({ link: '/deploys?deploy=dp-2374', entity_type: 'deploy', entity_id: 'dp-2374' })).toBe('/deploy/dp-2374');
    // A dev push dropped the work: no deploy to open, so the targets screen.
    expect(mobileNotificationRoute({ link: '/deploys' })).toBe('/deploys');
    expect(mobileRouteForUrl('https://codecast.sh/deploys')).toBe('/deploys');
    expect(mobileNotificationRoute({ entity_type: 'weekly_card', entity_id: '2026-W47' })).toBe('/week?w=2026-W47');
    expect(mobileNotificationRoute({ entity_type: 'passkey', entity_id: 'pk' })).toBe('/passkeys');
    expect(mobileNotificationRoute({ entity_type: 'team', entity_id: 't' })).toBe('/settings/team');
    expect(mobileNotificationRoute({ entity_type: 'org_role', entity_id: 'or-35' })).toBe('/org/or-35');
  });

  test('a session notification opens the session; one with nothing to name opens the inbox', () => {
    expect(mobileNotificationRoute({ conversation_id: 'jx7c6zk' })).toBe('/session/jx7c6zk');
    expect(mobileNotificationRoute({})).toBe('/(tabs)/inbox');
  });

  test('a link with no screen falls back to its entity', () => {
    expect(mobileNotificationRoute({ link: '/somewhere/unknown', entity_type: 'task', entity_id: 'ct-2' })).toBe('/task/ct-2');
  });
});
