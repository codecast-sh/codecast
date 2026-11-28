// `:w` saves; `:w!` asks to overwrite a file its mode refuses (file.overwrite),
// as vim's bang forces past a read-only file.
import { expect, test } from "bun:test";
import { resolveEx } from "../exAdapters";

const ctx = { word: () => "" };

test(":w saves and :w! goes through the overwrite", () => {
  expect(resolveEx("w", "", false, ctx)).toMatchObject({ command: "file.save" });
  expect(resolveEx("w", "", true, ctx)).toMatchObject({ command: "file.overwrite" });
  expect(resolveEx("write", "", true, ctx)).toMatchObject({ command: "file.overwrite" });
});
