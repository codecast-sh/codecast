// Vault payloads: the size limit counts bytes, and a value at the limit
// survives encryption whole.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { decryptSecret, encryptSecret } from "./secrets";
import { SECRET_PAYLOAD_MAX, validatePayload } from "@codecast/shared/contracts/secrets";

const KEY_ENV = "CONNECTION_SECRETS_KEY";
let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "test-deployment-key-0123456789abcdef";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
});

test("a value at the size limit encrypts and decrypts whole, and the limit counts bytes", async () => {
  const workspace = "team:t1";
  const ascii = { content: "a".repeat(SECRET_PAYLOAD_MAX - 100) };
  expect(validatePayload("file", ascii)).toEqual({ payload: ascii });
  expect(await decryptSecret(await encryptSecret(ascii, workspace), workspace)).toEqual(ascii);
  const cjk = { content: "漢".repeat(Math.floor((SECRET_PAYLOAD_MAX - 100) / 3)) };
  expect(validatePayload("file", cjk)).toEqual({ payload: cjk });
  expect(await decryptSecret(await encryptSecret(cjk, workspace), workspace)).toEqual(cjk);
  // 200,000 characters of CJK text is 600 KB: past the limit, whatever its length in characters.
  expect(validatePayload("file", { content: "漢".repeat(200_000) })).toMatchObject({ error: expect.stringMatching(/at most 512 KB/) });
});
