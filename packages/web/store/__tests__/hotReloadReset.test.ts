import { expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

it("keeps account data out of the reset floor when a populated store is hot replaced", async () => {
  const priorState = useInboxStore.getState();
  const globals = globalThis as any;
  const priorDocument = globals.document;
  const priorStore = globals.__codecastInboxStore;
  let scans = 0;
  const sessions = new Proxy({ private: { _id: "private", title: "Prior account" } }, {
    ownKeys(target) { scans++; return Reflect.ownKeys(target); },
  });
  useInboxStore.setState({ sessions } as any);
  globals.document = {};
  globals.__codecastInboxStore = useInboxStore;
  try {
    const reloaded = await import(`../inboxStore.ts?reset-test=${Date.now()}`);
    expect(reloaded.useInboxStore).toBe(useInboxStore);
    expect(scans).toBe(0);
    expect(useInboxStore.getState().sessions).toBe(sessions);
    reloaded.clearProtectedInboxMemory();
    expect(useInboxStore.getState().sessions).toEqual({});
    expect(useInboxStore.getState().currentUser).toBeNull();
    expect(useInboxStore.getState().clientStateInitialized).toBe(false);
  } finally {
    useInboxStore.setState(priorState, true);
    if (priorDocument === undefined) delete globals.document;
    else globals.document = priorDocument;
    if (priorStore === undefined) delete globals.__codecastInboxStore;
    else globals.__codecastInboxStore = priorStore;
  }
});
