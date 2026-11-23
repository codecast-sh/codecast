// JS face of the share inbox (ios/CodecastShareInboxModule.swift).
//
// `requireOptionalNativeModule` so a JS bundle that ships over the air to a
// binary built before the module existed has no share inbox instead of
// crashing at import (see the guarded-native-require rule).

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

type NativeModule = {
  /** The images shared to the app since the last call, as file URLs in the
   *  order they were shared. Each is handed over once. */
  takeAll(): string[];
};

export const shareInboxNative: NativeModule | null =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativeModule>('CodecastShareInbox') : null;
