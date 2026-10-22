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

type Capture = (error: Error, context?: Record<string, unknown>) => void;

// One "error" and one "unhandledrejection" listener per window, whoever asks
// for them. An app that shows toasts (setupErrorToasts) owns what a caught
// error does: its captureError reaches every backend the runtime has. A
// runtime reporting with no toasts wired (setupErrorCapture: the codecast sink
// in an app that never called setupErrorToasts) is the fallback, so the two
// never both fire and an error is never reported twice from two listeners.
let toastOptions: ErrorToastOptions | null = null;
let fallback: { capture: Capture; ignored: (string | RegExp)[] } | null = null;
let installedOn: Window | null = null;

const matches = (message: string | undefined, patterns: (string | RegExp)[]): boolean =>
  !!message && patterns.some((p) => (typeof p === "string" ? message.includes(p) : p.test(message)));

/**
 * Whether every frame of a stack ran in code no script file holds: text pasted
 * into devtools, or run through CDP's Runtime.evaluate or Electron's
 * executeJavaScript by a person or an agent inspecting the page. V8 names those
 * frames `<anonymous>`, the engine's own frames `(native)` or `(<anonymous>)`,
 * and every frame of the app's own bundle carries its URL. Such an error is a
 * bug in the injected text, not in the app, so it earns neither a toast nor a
 * report. A stack with no frames at all proves nothing and is kept.
 */
export function isInjectedScriptStack(locations: string[]): boolean {
  return locations.length > 0 && locations.every((l) => /^(<anonymous>|native)(:\d+:\d+)?$/.test(l));
}

/** Where each V8 frame ran: `at fn (where)` or `at where`. */
function stackLocations(value: unknown): string[] {
  const stack = value instanceof Error ? value.stack : undefined;
  return (stack ?? "")
    .split("\n")
    .map((line) => /^\s+at (?:.*\((.*)\)|(.*))$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => (m[1] ?? m[2]).trim());
}

function handleGlobalError(value: unknown, key: string, source: string, event: { preventDefault(): void }) {
  const options = toastOptions;
  const ignored = options ? options.ignoredErrorPatterns ?? [] : fallback?.ignored ?? [];
  if (matches(key, ignored)) {
    event.preventDefault();
    return;
  }
  // Left in the console for whoever ran it.
  if (isInjectedScriptStack(stackLocations(value))) return;
  if (!claimErrorKey(key)) return;
  const toError = options?.toError ?? defaultToError;
  if (options) {
    options.captureError(toError(value), { source });
    const describe = options.describe ?? defaultDescribe;
    const prefix = source === "unhandledrejection" ? "Unhandled rejection" : "Uncaught";
    options.showErrorToast(`${prefix}: ${key}`, describe(value));
  } else {
    fallback?.capture(toError(value), { source });
  }
}

function installListeners() {
  if (typeof window === "undefined" || installedOn === window) return;
  installedOn = window;
  const summarize = () => toastOptions?.summarize ?? defaultSummarize;

  window.addEventListener("error", (event) => {
    const key = event.error ? summarize()(event.error) : event.message;
    if (!event.error) {
      // A resource or cross-origin "Script error." carries nothing to report,
      // but an ignored message still has its default logging suppressed.
      const ignored = toastOptions ? toastOptions.ignoredErrorPatterns ?? [] : fallback?.ignored ?? [];
      if (matches(key, ignored)) event.preventDefault();
      return;
    }
    handleGlobalError(event.error, key, "window.onerror", event);
  });

  window.addEventListener("unhandledrejection", (event) => {
    handleGlobalError(event.reason, summarize()(event.reason), "unhandledrejection", event);
  });
}

export function setupErrorToasts(options: ErrorToastOptions) {
  toastOptions = options;
  installListeners();
}

/**
 * Report uncaught errors and rejections without toasts. Used by a runtime for
 * a backend that has no global handler of its own (the codecast sink; Sentry
 * installs its own). When the app also calls setupErrorToasts, the toast path
 * owns the listeners and its captureError is expected to reach the same
 * backend, so this capture stays silent.
 */
export function setupErrorCapture(capture: Capture, ignored: (string | RegExp)[] = []) {
  fallback = { capture, ignored };
  installListeners();
}

export function _resetErrorDeduperForTests() {
  seenGlobalErrors.clear();
  toastOptions = null;
  fallback = null;
  installedOn = null;
}
