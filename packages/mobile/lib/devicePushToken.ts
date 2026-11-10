// This device's Expo push token, once the system has issued it. It is held
// outside React so sign-out (lib/auth) can name the token it is leaving
// behind without mounting the notifications hook.
let current: string | null = null;

export function setDevicePushToken(token: string | null): void {
  current = token;
}

export function getDevicePushToken(): string | null {
  return current;
}
