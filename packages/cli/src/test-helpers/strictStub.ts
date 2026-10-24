// A test double that fails loudly on any call the test did not plan for.
//
// A partial fake cast to the full type (`{ createConversation } as unknown as
// SyncService`) answers every other method with `undefined`, so code under
// test that grows a new dependency keeps passing while it skips the work that
// dependency did. strictStub returns the methods given and makes every other
// one throw, naming the stub and the method.

export function strictStub<T extends object>(name: string, impl: Partial<T> = {}): T {
  return new Proxy(impl as T, {
    get(target, key, receiver) {
      if (key in target) return Reflect.get(target, key, receiver);
      // Probes that are not calls: `await stub` reads `then`, inspectors read symbols.
      if (key === "then" || typeof key === "symbol") return undefined;
      return () => {
        throw new Error(`${name}.${String(key)}() was called, but this test does not expect it`);
      };
    },
  });
}
