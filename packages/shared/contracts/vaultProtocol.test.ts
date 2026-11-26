import { describe, expect, test } from "bun:test";
import {
  isVaultAssetPath,
  isVaultMarkdownPath,
  isVaultTextPath,
  vaultFileKind,
  VAULT_MAX_PREVIEW_BYTES,
  VAULT_MAX_SERVE_BYTES,
} from "./vaultProtocol";

describe("vaultFileKind", () => {
  test("markdown outranks everything — it is the one kind that also edits", () => {
    expect(vaultFileKind("notes/Sleep.md")).toBe("markdown");
    expect(vaultFileKind("README.MARKDOWN")).toBe("markdown");
  });

  test("attachments render inline", () => {
    expect(vaultFileKind("assets/pic.PNG")).toBe("asset");
    expect(vaultFileKind("clip.mp4")).toBe("asset");
    expect(vaultFileKind("paper.pdf")).toBe("asset");
  });

  test("source and config open in the read-only viewer", () => {
    for (const p of [
      "src/index.ts",
      "src/App.tsx",
      "main.py",
      "cmd/server.go",
      "styles/app.css",
      "config.yaml",
      "Cargo.toml",
      "query.sql",
      "scripts/build.sh",
    ]) {
      expect(vaultFileKind(p)).toBe("text");
    }
  });

  test("dotfiles and extensionless names are text, matched case-insensitively", () => {
    expect(vaultFileKind(".gitignore")).toBe("text");
    expect(vaultFileKind("packages/web/.env")).toBe("text");
    expect(vaultFileKind("Makefile")).toBe("text");
    expect(vaultFileKind("docker/dockerfile")).toBe("text");
    expect(vaultFileKind("LICENSE")).toBe("text");
  });

  test("anything else is binary, so the viewer says so instead of decoding it", () => {
    // The whole point of this branch: a wall of mojibake is worse than "no
    // preview", and these are exactly what a repo is full of.
    expect(vaultFileKind("db.sqlite")).toBe("binary");
    expect(vaultFileKind("app.wasm")).toBe("binary");
    expect(vaultFileKind("fonts/Inter.woff2")).toBe("binary");
    expect(vaultFileKind("archive.zip")).toBe("binary");
    expect(vaultFileKind("noextension")).toBe("binary");
  });

  test("the kinds partition: every path is exactly one of them", () => {
    for (const p of ["a.md", "a.png", "a.ts", "a.bin", "Makefile", ".gitignore"]) {
      const flags = [isVaultMarkdownPath(p), isVaultAssetPath(p), isVaultTextPath(p)];
      const kind = vaultFileKind(p);
      // A path may match more than one predicate (".md" is not text, but a
      // future overlap must not change what kind() answers), so assert the
      // resolution order rather than mutual exclusion.
      if (flags[0]) expect(kind).toBe("markdown");
      else if (flags[1]) expect(kind).toBe("asset");
      else if (flags[2]) expect(kind).toBe("text");
      else expect(kind).toBe("binary");
    }
  });
});

describe("size caps", () => {
  test("the browser's preview cap sits far below the daemon's read cap", () => {
    // Two different jobs: the preview cap keeps a bundle out of the highlighter,
    // the serve cap keeps a multi-gigabyte file out of the daemon's memory.
    // Inverting them would mean the daemon refuses files the client asks for.
    expect(VAULT_MAX_PREVIEW_BYTES).toBeLessThan(VAULT_MAX_SERVE_BYTES);
    expect(VAULT_MAX_PREVIEW_BYTES).toBe(2 * 1024 * 1024);
  });
});
