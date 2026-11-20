import { describe, expect, test } from 'bun:test';
import {
  UNCONFIGURED,
  addPasskeyNative,
  classifyCeremonyError,
  confirmPresenceNative,
  toCreateRequest,
  toGetRequest,
  toResponseJSON,
  type NativePasskeyDeps,
} from './passkeyCeremony';

// What @simplewebauthn/server's generate*Options answer (convex/passkeys.ts optionsFor).
const REGISTRATION = {
  challenge: 'CEbAwFYWNEwDoRca6mMH8JkyFN4MJjU5JQn7K7xDehM',
  rp: { name: 'Codecast', id: 'codecast.sh' },
  user: { id: 'dQ', name: 'u', displayName: '' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
  timeout: 60000,
  attestation: 'none',
  excludeCredentials: [{ id: 'abc', transports: ['internal', 'hybrid'], type: 'public-key' }],
  authenticatorSelection: { residentKey: 'preferred', userVerification: 'required', requireResidentKey: false },
  extensions: { credProps: true },
  hints: [],
};
const AUTHENTICATION = {
  rpId: 'codecast.sh',
  challenge: 'ovX23zFIPDBCwxEmXPiHQDgUH9Y-h_PQ6h8fny_8FYM',
  allowCredentials: [{ id: 'abc', transports: ['internal', 'cable'], type: 'public-key' }],
  timeout: 60000,
  userVerification: 'required',
};

describe('request shaping', () => {
  test('an assertion request keeps what the sheet reads and drops transports it does not know', () => {
    expect(toGetRequest(AUTHENTICATION)).toEqual({
      challenge: AUTHENTICATION.challenge,
      rpId: 'codecast.sh',
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: [{ id: 'abc', type: 'public-key', transports: ['internal'] }],
    });
  });

  test('an empty allow list is left out, so the sheet offers any codecast.sh passkey', () => {
    expect(toGetRequest({ ...AUTHENTICATION, allowCredentials: [] })).not.toHaveProperty('allowCredentials');
  });

  test('a registration request drops none attestation, extensions and hints', () => {
    const r = toCreateRequest(REGISTRATION);
    expect(r).not.toHaveProperty('attestation');
    expect(r).not.toHaveProperty('extensions');
    expect(r).not.toHaveProperty('hints');
    expect(r.rp).toEqual({ name: 'Codecast', id: 'codecast.sh' });
    expect(r.excludeCredentials).toEqual([{ id: 'abc', type: 'public-key', transports: ['internal', 'hybrid'] }]);
    expect(toCreateRequest({ ...REGISTRATION, attestation: 'direct' }).attestation).toBe('direct');
  });

  test('base64 ids become base64url', () => {
    expect(toCreateRequest({ ...REGISTRATION, user: { ...REGISTRATION.user, id: 'a+b/c==' } }).user.id).toBe('a-b_c');
    expect(toGetRequest({ ...AUTHENTICATION, challenge: 'x+y/z=' }).challenge).toBe('x-y_z');
  });
});

describe('toResponseJSON', () => {
  test('fills rawId, type and extension results and makes every binary field base64url', () => {
    const out = toResponseJSON({
      id: 'cred+id/=',
      response: { clientDataJSON: 'ey+J/==', authenticatorData: 'AA/B', signature: 'MEU+', userHandle: 'dQ==' },
    });
    expect(out).toEqual({
      id: 'cred-id_',
      rawId: 'cred-id_',
      type: 'public-key',
      response: { clientDataJSON: 'ey-J_', authenticatorData: 'AA_B', signature: 'MEU-', userHandle: 'dQ' },
      clientExtensionResults: {},
    });
  });

  test('keeps transports and the key algorithm as they are', () => {
    const out = toResponseJSON({ id: 'a', rawId: 'a', response: { attestationObject: 'o', transports: ['internal', 'hybrid'], publicKeyAlgorithm: -7 } });
    expect(out.response.transports).toEqual(['internal', 'hybrid']);
    expect(out.response.publicKeyAlgorithm).toBe(-7);
  });
});

describe('classifyCeremonyError', () => {
  test('the person dismissing the sheet is a cancel', () => {
    expect(classifyCeremonyError({ error: 'UserCancelled', message: 'The user cancelled the request.' })).toBe('cancel');
    expect(classifyCeremonyError({ error: 'Interrupted' })).toBe('cancel');
  });

  test('a binary the OS will not vouch for codecast.sh hands off', () => {
    expect(classifyCeremonyError({ error: 'NotSupported' })).toBe(UNCONFIGURED);
    expect(classifyCeremonyError({ error: 'BadConfiguration' })).toBe(UNCONFIGURED);
    expect(
      classifyCeremonyError({ error: 'RequestFailed', message: 'Application with identifier WRG9THCK9Q.com.ashotp.codecast is not associated with domain codecast.sh' }),
    ).toBe(UNCONFIGURED);
    expect(classifyCeremonyError({ error: 'Native error', message: 'RP ID cannot be validated.' })).toBe(UNCONFIGURED);
  });

  test('anything else says why', () => {
    expect(classifyCeremonyError({ error: 'NoCredentials' })).toBe('No Codecast passkey on this phone');
    expect(classifyCeremonyError({ error: 'RequestFailed', message: 'Something broke' })).toBe('Something broke');
    expect(classifyCeremonyError(undefined)).toBe('Touch ID did not finish');
  });
});

type Call = [string, ...unknown[]];

function fake(over: Partial<NativePasskeyDeps> = {}, opts: { passkeys?: boolean } = {}) {
  const calls: Call[] = [];
  let enrolled = opts.passkeys ?? true;
  const deps: NativePasskeyDeps = {
    begin: async (action, target) => {
      calls.push(['begin', action, target]);
      return enrolled ? { challenge_id: 'p1', options: AUTHENTICATION, grant: 'grant-1' as any } : { error: 'Set up Touch ID first', needs_passkey: true };
    },
    enroll: async (grant) => {
      calls.push(['enroll', grant]);
      return { challenge_id: 'r1', options: REGISTRATION };
    },
    get: async (request) => {
      calls.push(['get', request.rpId]);
      return { id: 'abc', rawId: 'abc', response: { clientDataJSON: 'c', authenticatorData: 'a', signature: 's' } };
    },
    create: async (request) => {
      calls.push(['create', request.rp.id]);
      return { id: 'new', rawId: 'new', response: { clientDataJSON: 'c', attestationObject: 'o' } };
    },
    finishPresence: async (id, response) => {
      calls.push(['finishPresence', id, response.type]);
      return { granted: true };
    },
    finishRegistration: async (id, _response, name) => {
      calls.push(['finishRegistration', id, name]);
      enrolled = true;
      return { id: 'pk1' };
    },
    name: 'Codecast on iPhone 16',
    ...over,
  };
  return { deps, calls };
}

describe('confirmPresenceNative', () => {
  test('asserts the challenge and answers the grant the begin handed over', async () => {
    const { deps, calls } = fake();
    expect(await confirmPresenceNative('approve', 'd1', deps)).toBe('grant-1' as any);
    expect(calls).toEqual([
      ['begin', 'approve', 'd1'],
      ['get', 'codecast.sh'],
      ['finishPresence', 'p1', 'public-key'],
    ]);
  });

  test('with no passkey yet it sets one up on the phone, then confirms', async () => {
    const { deps, calls } = fake({}, { passkeys: false });
    expect(await confirmPresenceNative('reveal', 's1', deps)).toBe('grant-1' as any);
    expect(calls.map((c) => c[0])).toEqual(['begin', 'enroll', 'create', 'finishRegistration', 'begin', 'get', 'finishPresence']);
    expect(calls.find((c) => c[0] === 'finishRegistration')).toEqual(['finishRegistration', 'r1', 'Codecast on iPhone 16']);
  });

  test('a cancel answers null and finishes nothing', async () => {
    const { deps, calls } = fake({ get: async () => Promise.reject({ error: 'UserCancelled' }) });
    expect(await confirmPresenceNative('approve', 'd1', deps)).toBeNull();
    expect(calls.some((c) => c[0] === 'finishPresence')).toBe(false);
  });

  test('an unverified associated domain answers UNCONFIGURED so the caller hands off', async () => {
    const { deps } = fake({ get: async () => Promise.reject({ error: 'RequestFailed', message: 'not associated with domain codecast.sh' }) });
    expect(await confirmPresenceNative('approve', 'd1', deps)).toBe(UNCONFIGURED);
  });

  test("the server's refusal is thrown in its words", async () => {
    const { deps } = fake({ finishPresence: async () => ({ error: 'This confirmation expired: start again' }) });
    await expect(confirmPresenceNative('approve', 'd1', deps)).rejects.toThrow('This confirmation expired: start again');
    const refused = fake({ begin: async () => ({ error: 'Nothing to confirm' }) });
    await expect(confirmPresenceNative('approve', 'd1', refused.deps)).rejects.toThrow('Nothing to confirm');
  });

  test('a failed ceremony is thrown in words a person reads', async () => {
    const { deps } = fake({ get: async () => Promise.reject({ error: 'NoCredentials' }) });
    await expect(confirmPresenceNative('approve', 'd1', deps)).rejects.toThrow('No Codecast passkey on this phone');
  });
});

describe('addPasskeyNative', () => {
  test('the first passkey sets up at once, with no grant', async () => {
    const { deps, calls } = fake({}, { passkeys: false });
    expect(await addPasskeyNative(false, deps)).toBe(true);
    expect(calls).toEqual([
      ['enroll', undefined],
      ['create', 'codecast.sh'],
      ['finishRegistration', 'r1', 'Codecast on iPhone 16'],
    ]);
  });

  test('a second passkey confirms add_passkey first and spends that grant', async () => {
    const { deps, calls } = fake();
    expect(await addPasskeyNative(true, deps)).toBe(true);
    expect(calls[0]).toEqual(['begin', 'add_passkey', 'self']);
    expect(calls.find((c) => c[0] === 'enroll')).toEqual(['enroll', 'grant-1']);
  });

  test('a second passkey the person does not confirm is not added', async () => {
    const { deps, calls } = fake({ get: async () => Promise.reject({ error: 'UserCancelled' }) });
    expect(await addPasskeyNative(true, deps)).toBe(false);
    expect(calls.some((c) => c[0] === 'enroll')).toBe(false);
  });

  test('an unconfigured binary hands off', async () => {
    const { deps } = fake({ create: async () => Promise.reject({ error: 'BadConfiguration' }) }, { passkeys: false });
    expect(await addPasskeyNative(false, deps)).toBe(UNCONFIGURED);
  });
});
