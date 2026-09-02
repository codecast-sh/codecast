// Minimal ambient types for bun's test runner. The repo does not carry
// @types/bun, and the package installs no new dependencies, so the few symbols
// the suite uses are declared here to keep `tsc --noEmit` covering the tests
// instead of excluding them.
declare module "bun:test" {
  export const describe: (name: string, fn: () => void) => void;
  export const it: (name: string, fn: () => unknown) => void;
  export const test: (name: string, fn: () => unknown) => void;
  export const beforeEach: (fn: () => unknown) => void;
  export const afterEach: (fn: () => unknown) => void;
  export const beforeAll: (fn: () => unknown) => void;
  export const afterAll: (fn: () => unknown) => void;
  export const expect: any;
}
declare module "bun:test" {
  export const mock: any;
}
