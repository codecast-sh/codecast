// bun's toMatchObject with an asymmetric matcher writes the matcher into the
// received object. A test fake that kept a request body by reference later
// threw DataCloneError from an unrelated structuredClone (2026-10-02,
// orgTemplate.test.ts). Fakes store structuredClone(body), never the caller's
// object.
import { expect, test } from "bun:test";

test("toMatchObject leaves the asymmetric matcher in the received object", () => {
  const received: Record<string, unknown> = { host: "box-1" };
  expect(received).toMatchObject({ host: expect.any(String) });
  expect(received.host).not.toBe("box-1");
  expect(() => structuredClone(received)).toThrow("can not be cloned");
});
