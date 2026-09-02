#!/usr/bin/env bun
// Minimal runnable CLI. Gates live in a JSON file (scope -> flags) and the
// catalog comes from a JSON file of descriptors, so the verbs can be tried
// without an app. PostHog reads use the HTTP evaluator.
//
//   POSTHOG_API_KEY   project API key (phc_...)
//   POSTHOG_HOST      default https://us.i.posthog.com
//   FLAGS_CATALOG     path to a JSON array of {key,name,desc,defaultOn?}
//   FLAGS_STORE       path to the JSON gate store, default ./flags-store.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { defineFeatures, type FeatureDescriptor, type StoredFlags } from "./catalog";
import { createFlagsCommands, type GateStore } from "./commands";
import { createServerFlagsClient } from "./posthog/server";

const env = process.env;
const catalogPath = env.FLAGS_CATALOG;
const storePath = env.FLAGS_STORE ?? "./flags-store.json";

const descriptors: FeatureDescriptor[] = catalogPath
  ? (JSON.parse(readFileSync(catalogPath, "utf8")) as FeatureDescriptor[])
  : [];
const catalog = defineFeatures(descriptors);

type Store = Record<string, StoredFlags>;
const readStore = (): Store => (existsSync(storePath) ? (JSON.parse(readFileSync(storePath, "utf8")) as Store) : {});
const gates: GateStore<string> = {
  load: async (scope) => readStore()[scope] ?? null,
  save: async (scope, key, enabled) => {
    const store = readStore();
    store[scope] = { ...(store[scope] ?? {}), [key]: enabled };
    writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n");
  },
};

const commands = createFlagsCommands({
  catalog,
  gates,
  posthog: env.POSTHOG_API_KEY
    ? (distinctId) =>
        createServerFlagsClient({
          apiKey: env.POSTHOG_API_KEY as string,
          host: env.POSTHOG_HOST ?? "https://us.i.posthog.com",
          distinctId,
          fetch: (url, init) => globalThis.fetch(url, init),
        })
    : undefined,
  write: (l) => console.log(l),
  writeError: (l) => console.error(l),
});

commands.run(process.argv.slice(2)).then((code) => process.exit(code));
