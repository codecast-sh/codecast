// Drives the real (patched) @convex-dev/auth client through the refresh
// failures that signed phones out and then refused their next sign-in
// (patches/convex-auth-refresh-keep.mjs and convex-auth-refresh.mjs). Convex is a fake that records setAuth and
// answers fetchToken the way the real auth manager does.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ConvexAuthProvider, useAuthActions } from '@convex-dev/auth/react';
import { useConvexAuth } from 'convex/react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// React Native has a `window` with no location and no event listeners.
(globalThis as any).window ??= globalThis;

const ADDRESS = 'https://convex.test';
const ns = ADDRESS.replace(/[^a-zA-Z0-9]/g, '');
const JWT = `__convexAuthJWT_${ns}`;
const REFRESH = `__convexAuthRefreshToken_${ns}`;

function memoryStorage(initial: Record<string, string>) {
  const items = { ...initial };
  return {
    items,
    getItem: async (k: string) => items[k] ?? null,
    setItem: async (k: string, v: string) => { items[k] = v; },
    removeItem: async (k: string) => { delete items[k]; },
  };
}

type SetAuthCall = {
  fetchToken: (a: { forceRefreshToken: boolean }) => Promise<string | null>;
  onChange: (ok: boolean) => void;
};

function fakeConvex(signIn: (args: any) => any) {
  const setAuthCalls: SetAuthCall[] = [];
  const client = {
    address: ADDRESS,
    options: {},
    action: async (_name: string, args: any) => signIn(args),
    setAuth: (fetchToken: SetAuthCall['fetchToken'], onChange: SetAuthCall['onChange']) => {
      setAuthCalls.push({ fetchToken, onChange });
    },
    clearAuth: () => {},
  };
  return { client: client as any, setAuthCalls };
}

const realFetch = globalThis.fetch;
let fetchImpl: (body: any) => Promise<Response>;
beforeEach(() => {
  globalThis.fetch = (async (_url: string, init: any) => fetchImpl(JSON.parse(init.body))) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const actionAnswer = (value: unknown) =>
  new Response(JSON.stringify({ status: 'success', value, logLines: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

let seen: { auth: { isLoading: boolean; isAuthenticated: boolean }; signIn: any } | null = null;
function Probe() {
  const auth = useConvexAuth();
  const { signIn } = useAuthActions();
  seen = { auth, signIn };
  return null;
}

async function mount(client: any, storage: ReturnType<typeof memoryStorage>) {
  await act(async () => {
    TestRenderer.create(
      <ConvexAuthProvider client={client} storage={storage}>
        <Probe />
      </ConvexAuthProvider>,
    );
  });
}

describe('patched @convex-dev/auth refresh', () => {
  it('keeps the refresh token, and rejects nothing, when every refresh call fails on the network', async () => {
    const storage = memoryStorage({ [JWT]: 'old-jwt', [REFRESH]: 'refresh-1' });
    const { client, setAuthCalls } = fakeConvex(() => ({}));
    let calls = 0;
    fetchImpl = async () => {
      calls++;
      throw new TypeError('Network request failed');
    };
    await mount(client, storage);
    expect(setAuthCalls.length).toBe(1);
    let error: unknown;
    await act(async () => {
      await setAuthCalls[0].fetchToken({ forceRefreshToken: true }).catch((e) => { error = e; });
    });
    // A failure in transit is no logout: the attempts run out quietly and the token stays.
    expect(error).toBeUndefined();
    expect(calls).toBe(3);
    expect(storage.items[REFRESH]).toBe('refresh-1');
  }, 10_000);

  it('retries a network failure and refreshes', async () => {
    const storage = memoryStorage({ [JWT]: 'old-jwt', [REFRESH]: 'refresh-1' });
    const { client, setAuthCalls } = fakeConvex(() => ({}));
    let calls = 0;
    fetchImpl = async (body) => {
      calls++;
      if (calls === 1) throw new TypeError('Network request failed');
      expect(body.args[0].refreshToken).toBe('refresh-1');
      return actionAnswer({ tokens: { token: 'new-jwt', refreshToken: 'refresh-2' } });
    };
    await mount(client, storage);
    let token: string | null = null;
    await act(async () => {
      token = await setAuthCalls[0].fetchToken({ forceRefreshToken: true });
    });
    expect(token).toBe('new-jwt');
    expect(storage.items[REFRESH]).toBe('refresh-2');
  }, 10_000);

  it('lets the next sign-in through after Convex signed the socket out', async () => {
    // An expired JWT with no refresh token: what a lost refresh left behind.
    const storage = memoryStorage({ [JWT]: 'expired-jwt' });
    const { client, setAuthCalls } = fakeConvex(() => ({
      tokens: { token: 'fresh-jwt', refreshToken: 'fresh-refresh' },
    }));
    await mount(client, storage);
    expect(setAuthCalls.length).toBe(1);

    // The server rejected the JWT; the auth manager force-refreshes, gets
    // null, and reports the socket signed out.
    await act(async () => {
      const token = await setAuthCalls[0].fetchToken({ forceRefreshToken: true });
      expect(token).toBeNull();
      setAuthCalls[0].onChange(false);
    });
    expect(seen!.auth).toEqual({ isLoading: false, isAuthenticated: false });
    expect(storage.items[JWT]).toBeUndefined();

    // Signing in must hand Convex the new token.
    await act(async () => {
      await seen!.signIn('password', { email: 'a@b.c', password: 'x', flow: 'signIn' });
    });
    expect(setAuthCalls.length).toBe(2);
    expect(await setAuthCalls[1].fetchToken({ forceRefreshToken: false })).toBe('fresh-jwt');
    await act(async () => setAuthCalls[1].onChange(true));
    expect(seen!.auth).toEqual({ isLoading: false, isAuthenticated: true });
  });
});
