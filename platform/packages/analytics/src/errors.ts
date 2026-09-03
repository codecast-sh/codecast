const seenGlobalErrors = new Set<string>();

export function claimErrorKey(key: string): boolean {
  if (seenGlobalErrors.has(key)) return false;
  seenGlobalErrors.add(key);
  setTimeout(() => seenGlobalErrors.delete(key), 30_000);
  return true;
}

const defaultToError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));
const defaultSummarize = (value: unknown): string => defaultToError(value).message;
const defaultDescribe = (value: unknown): string => {
  const error = defaultToError(value);
  return `${error.message}\n\n${error.stack || ""}`;
};

export interface ErrorToastOptions {
  showErrorToast: (title: string, fullTrace: string) => void;
  captureError: (error: Error, context?: Record<string, unknown>) => void;
  ignoredErrorPatterns?: RegExp[];
  summarize?: (error: unknown) => string;
  describe?: (error: unknown) => string;
  toError?: (error: unknown) => Error;
}

export function setupErrorToasts(options: ErrorToastOptions) {
  const {
    showErrorToast,
    captureError,
    ignoredErrorPatterns = [],
    summarize = defaultSummarize,
    describe = defaultDescribe,
    toError = defaultToError,
  } = options;
  const isIgnoredError = (message: string | undefined): boolean =>
    !!message && ignoredErrorPatterns.some((pattern) => pattern.test(message));

  window.addEventListener("error", (event) => {
    const key = event.error ? summarize(event.error) : event.message;
    if (isIgnoredError(key)) {
      event.preventDefault();
      return;
    }
    if (!event.error || !claimErrorKey(key)) return;
    captureError(toError(event.error), { source: "window.onerror" });
    showErrorToast(`Uncaught: ${key}`, describe(event.error));
  });

  window.addEventListener("unhandledrejection", (event) => {
    const key = summarize(event.reason);
    if (isIgnoredError(key)) {
      event.preventDefault();
      return;
    }
    if (!claimErrorKey(key)) return;
    captureError(toError(event.reason), { source: "unhandledrejection" });
    showErrorToast(`Unhandled rejection: ${key}`, describe(event.reason));
  });
}

export function _resetErrorDeduperForTests() {
  seenGlobalErrors.clear();
}
