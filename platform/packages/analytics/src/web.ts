import { captureError, _resetRuntimeForTests } from "./webRuntime";
import {
  _resetErrorDeduperForTests,
  claimErrorKey,
  setupErrorToasts as setupBaseErrorToasts,
  type ErrorToastOptions as BaseErrorToastOptions,
} from "./errors";

export * from "./webRuntime";

export type ErrorToastOptions = Omit<BaseErrorToastOptions, "captureError">;

export function setupErrorToasts(options: ErrorToastOptions) {
  setupBaseErrorToasts({ ...options, captureError });
}

export function _resetForTests() {
  _resetRuntimeForTests();
  _resetErrorDeduperForTests();
}

export { claimErrorKey };
