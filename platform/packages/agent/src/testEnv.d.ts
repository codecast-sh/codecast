// The few Node and runtime names the tests touch. The package installs no
// @types/node on purpose (its code must not need Node), so they are declared
// here for `tsc --noEmit` to cover the tests.
declare module "node:module" {
  export const builtinModules: string[];
}
declare const process: { env: Record<string, string | undefined> };
