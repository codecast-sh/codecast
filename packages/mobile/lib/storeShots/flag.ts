// Store shots: a dev-only mode that runs the real app over the Acme fixture
// world (lib/storeShots/world.ts) with no server, for App Store screenshots
// and preview video (packages/mobile/store-shots). Start Metro with
// EXPO_PUBLIC_STORE_SHOTS=1. Never on in a release build: `__DEV__` is false
// there, so every `if (STORE_SHOTS)` folds away with the require inside it.
export const STORE_SHOTS = __DEV__ && process.env.EXPO_PUBLIC_STORE_SHOTS === "1";
