import { expect, test } from "bun:test";
import { toWslPath, wslCastArgs } from "./wsl";

test("a Windows drive path maps to its /mnt twin in the default distro", () => {
  expect(toWslPath("C:\\code\\repo\\a.ts")).toEqual({ path: "/mnt/c/code/repo/a.ts" });
  expect(toWslPath("D:\\")).toEqual({ path: "/mnt/d" });
});

test("a \\\\wsl.localhost path maps to the distro's own path and names the distro", () => {
  expect(toWslPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj")).toEqual({ path: "/home/me/proj", distro: "Ubuntu" });
  expect(toWslPath("\\\\wsl$\\Debian\\srv")).toEqual({ path: "/srv", distro: "Debian" });
});

test("cast runs in the file's distro and folder, with path arguments translated and line suffixes kept", () => {
  expect(wslCastArgs(["blame", "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\a.ts:12", "--open"], "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj")).toEqual([
    "-d", "Ubuntu", "--cd", "/home/me/proj", "-e", "sh", "-lc", 'exec cast "$@"', "cast",
    "blame", "/home/me/proj/a.ts:12", "--open",
  ]);
  expect(wslCastArgs(["blame", "--line-porcelain", "--", "C:\\r\\x.ts"], "C:\\r")).toEqual([
    "--cd", "/mnt/c/r", "-e", "sh", "-lc", 'exec cast "$@"', "cast",
    "blame", "--line-porcelain", "--", "/mnt/c/r/x.ts",
  ]);
});
