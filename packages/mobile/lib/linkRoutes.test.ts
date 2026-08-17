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
  });

  test('share tokens open the session screen', () => {
    expect(mobileRouteForUrl('https://codecast.sh/share/Tok123')).toBe('/session/Tok123');
  });

  test('invites land on the team tab', () => {
    expect(mobileRouteForUrl('https://codecast.sh/join/abc')).toBe('/(tabs)/team');
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
