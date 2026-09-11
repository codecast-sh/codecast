// JS face of the native ActivityKit bridge (ios/CodecastLiveActivityModule.swift).
//
// `requireOptionalNativeModule` so a JS bundle that ships over the air to a
// binary built before the module existed degrades to "no Live Activities"
// instead of crashing at import (see the guarded-native-require rule).

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { LiveActivityContentState } from '@codecast/shared/contracts';

export type LiveActivityEnvironment = 'production' | 'sandbox';

type EventSubscription = { remove(): void };

type NativeModule = {
  environment: LiveActivityEnvironment;
  supported: boolean;
  supportsPushToStart: boolean;
  isEnabled(): boolean;
  activityIds(): string[];
  start(state: LiveActivityContentState): Promise<string | null>;
  update(state: LiveActivityContentState): Promise<void>;
  endAll(): Promise<void>;
  addListener(event: 'onPushToStartToken', listener: (e: { token: string }) => void): EventSubscription;
  addListener(event: 'onActivity', listener: (e: { id: string; token: string }) => void): EventSubscription;
  addListener(event: 'onActivityEnded', listener: (e: { id: string }) => void): EventSubscription;
};

const native: NativeModule | null =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativeModule>('CodecastLiveActivity') : null;

export const liveActivityNative = native;

export function liveActivitySupported(): boolean {
  return !!native?.supported;
}
