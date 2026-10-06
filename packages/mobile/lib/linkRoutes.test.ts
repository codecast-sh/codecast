import { test, expect, describe } from 'bun:test';
import {
  mobileRouteForUrl,
  mobileEntityRoute,
  trimUrlTail,
  shortenUrl,
  urlPattern,
  isMentionStart,
} from './linkRoutes';

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

  test('the retired assistant lane leads to the main app screens', () => {
    expect(mobileRouteForUrl('https://codecast.sh/simple')).toBe('/(tabs)/inbox');
    expect(mobileRouteForUrl('https://codecast.sh/simple/approvals')).toBe('/decisions');
    expect(mobileRouteForUrl('https://codecast.sh/simple/routines')).toBe('/(tabs)/tasks?segment=routines');
    expect(mobileRouteForUrl('https://codecast.sh/triggers')).toBe('/(tabs)/tasks?segment=routines');
    expect(mobileRouteForUrl('https://codecast.sh/simple/c/jx7abc123?x=1')).toBe('/session/jx7abc123');
    expect(mobileRouteForUrl('/simple/plan/')).toBe('/settings/plan');
    expect(mobileRouteForUrl('https://codecast.sh/simple/connections?whisk=connected')).toBe('/settings/mail');
    expect(mobileRouteForUrl('https://codecast.sh/simpler')).toBeNull();
  });

  test('web pages the phone has a screen for open there', () => {
    expect(mobileRouteForUrl('https://codecast.sh/inbox')).toBe('/(tabs)/inbox');
    expect(mobileRouteForUrl('https://codecast.sh/questions')).toBe('/decisions');
    expect(mobileRouteForUrl('https://codecast.sh/settings/plan?billing=done')).toBe('/settings/plan');
    expect(mobileRouteForUrl('https://codecast.sh/settings/integrations')).toBe('/settings/mail');
  });

  test('invites, chat and calls land on the chat tab', () => {
    expect(mobileRouteForUrl('https://codecast.sh/join/abc')).toBe('/(tabs)/chat');
    expect(mobileRouteForUrl('https://codecast.sh/chat')).toBe('/(tabs)/chat');
    expect(mobileRouteForUrl('https://codecast.sh/calls')).toBe('/(tabs)/chat');
  });

  test('the org, a role and the root open their screens; a tab link opens the board', () => {
    expect(mobileRouteForUrl('https://codecast.sh/org')).toBe('/org');
    expect(mobileRouteForUrl('/org/or-12')).toBe('/org/or-12');
    expect(mobileRouteForUrl('https://codecast.sh/org/workspace')).toBe('/org/workspace');
    expect(mobileRouteForUrl('https://codecast.sh/org/or-12?tab=feed')).toBe('/org/or-12/board');
    expect(mobileRouteForUrl('https://example.com/org/or-12')).toBeNull();
  });

  test('app pages that are not objects stay external', () => {
    // A published artifact is a web page, not a mobile screen — sending it to a
    // route would 404 inside the app.
    expect(mobileRouteForUrl('https://codecast.sh/a/my-report')).toBeNull();
    expect(mobileRouteForUrl('https://codecast.sh/settings')).toBeNull();
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

  test('triggers have no mobile screen yet, so they stay external', () => {
    expect(mobileEntityRoute('trigger', 'tr-42')).toBeNull();
    expect(mobileRouteForUrl('https://codecast.sh/triggers?task=tr-42')).toBeNull();
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
    expect(redirectSystemPath({ path: 'https://codecast.sh/settings', initial: false })).toBe('https://codecast.sh/settings');
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
