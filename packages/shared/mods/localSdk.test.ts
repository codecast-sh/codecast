import { expect, test } from "bun:test";
import { AGENT_NOTES_KEY as contractKey } from "../contracts/mods";
import { AGENT_NOTES_KEY as sdkKey } from "./localSdk";

test("the local SDK writes agent instructions under the key the guide reads", () => {
  expect(sdkKey).toBe(contractKey);
});
