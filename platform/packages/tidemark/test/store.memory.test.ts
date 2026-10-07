import { describe, test, setDefaultTimeout } from 'bun:test';

import { storeContract } from '../src/stores/contract';
import { memoryStore } from '../src/stores/memory';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

describe('store contract: memory', () => {
  for (const c of storeContract(async () => {
    const store = memoryStore();
    return { store, addLegacyLeaf: store.addLegacyLeaf };
  })) {
    test(c.name, c.run);
  }
});
