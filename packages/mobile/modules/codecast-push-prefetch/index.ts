// JS face of push prefetch (ios/CodecastPushPrefetchModule.swift).
//
// `requireOptionalNativeModule` so a JS bundle that ships over the air to a
// binary built before the module existed has no prefetch instead of crashing
// at import (see the guarded-native-require rule).

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

type NativeModule = {
  /** Shares the access token with the extension; null removes it. */
  setToken(token: string | null): void;
  /** {"url": backend URL, "watermarks": {conversationId: newest row ms}} */
  writeState(json: string): boolean;
  /** The extension's saved fetches (JSON strings), removed as they are read. */
  takeAll(): string[];
};

export const pushPrefetchNative: NativeModule | null =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativeModule>('CodecastPushPrefetch') : null;
