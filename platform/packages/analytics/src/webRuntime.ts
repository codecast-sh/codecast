import {
  captureException as captureSentryException,
  init as initSentry,
  setUser as setSentryUser,
} from "@sentry/react";
import posthog from "posthog-js/dist/module.slim.js";
import { AnalyticsExtensions } from "posthog-js/dist/extension-bundles.js";
import {
  createPreInitBuffer,
  resolveConfig,
  superProperties,
  type AnalyticsConfig,
  type ResolvedAnalyticsConfig,
} from "./index";

let config: ResolvedAnalyticsConfig | null = null;
let initialized = false;
const preInit = createPreInitBuffer();

export function initAnalytics(input: AnalyticsConfig) {
  if (initialized) return;
  initialized = true;
  config = resolveConfig(input);

  const isDev = config.environment === "development";

  if (config.sentryDsn) {
    initSentry({
      dsn: config.sentryDsn,
      environment: config.environment,
      enabled: !isDev,
      initialScope: {
        tags: { platform: config.platform, ...(config.appName ? { app: config.appName } : {}) },
      },
    });
  }

  if (config.posthogKey) {
    posthog.init(config.posthogKey, {
      api_host: config.posthogHost,
      autocapture: true,
      capture_pageview: "history_change",
      capture_pageleave: true,
      persistence: "localStorage",
      __extensionClasses: AnalyticsExtensions,
      disable_session_recording: true,
      capture_dead_clicks: false,
    });
    posthog.register(superProperties(config));
  }

  preInit.flush();
}

export function identifyUser(userId: string, traits?: Record<string, unknown>) {
  if (!initialized) {
    preInit.add(() => identifyUser(userId, traits));
    return;
  }
  if (config?.sentryDsn) setSentryUser({ id: userId, ...traits });
  if (config?.posthogKey) posthog.identify(userId, traits);
}

export function resetUser() {
  if (!initialized) {
    preInit.add(() => resetUser());
    return;
  }
  if (config?.sentryDsn) setSentryUser(null);
  if (config?.posthogKey) posthog.reset();
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (!initialized) {
    preInit.add(() => track(event, properties));
    return;
  }
  if (config?.posthogKey) posthog.capture(event, properties);
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  if (config?.sentryDsn) captureSentryException(error, { extra: context });
}

export function _resetRuntimeForTests() {
  config = null;
  initialized = false;
  preInit.clear();
}

export { posthog };
