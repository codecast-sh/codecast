#!/usr/bin/env bun
// Sign a release manifest (latest.json) with the release signing key and
// write the detached signature file beside it. Runs in the release pipeline
// only; a client never holds the private key.
//
//   bun release/sign-manifest.ts --manifest /tmp/latest.json --key-id cli-release-2026 \
//       [--out /tmp/latest.json.sig] [--append]
//
// The private key (PKCS#8 PEM, Ed25519) is read from RELEASE_MANIFEST_SIGNING_KEY
// in the environment, never from the command line. With --append an existing
// signature file keeps its other signatures, which is how a key rotates: the
// pipeline signs with the old key and the new one until every client in the
// field pins the new one.
//
//   bun release/sign-manifest.ts --keygen
//
// prints a fresh key pair: the PEM to store as the pipeline secret, and the
// base64 public key a client pins. It writes nothing.
//
//   bun release/sign-manifest.ts --verify --manifest latest.json --sig latest.json.sig --public-key <base64>
//
// checks a signature file against a public key and exits 1 when no signature verifies.

import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isManifestSignatureFile, publicKeyToBase64, signManifest, verifyDetached, type ManifestSignatureFile } from "../src/update/signing.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

if (flag("keygen")) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  process.stdout.write(
    [
      "# private key: store as the RELEASE_MANIFEST_SIGNING_KEY secret, never in the repo",
      privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      "# public key (base64 raw): pin in the client's manifestSigning.keys under the key id",
      publicKeyToBase64(publicKey),
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const manifestPath = arg("manifest");
if (!manifestPath) {
  console.error("--manifest <path> is required");
  process.exit(2);
}
const manifest = new Uint8Array(readFileSync(manifestPath));

if (flag("verify")) {
  const sigPath = arg("sig") ?? `${manifestPath}.sig`;
  const publicKey = arg("public-key");
  if (!publicKey) {
    console.error("--public-key <base64> is required with --verify");
    process.exit(2);
  }
  const file: unknown = JSON.parse(readFileSync(sigPath, "utf8"));
  if (!isManifestSignatureFile(file)) {
    console.error(`${sigPath} is not a signature file`);
    process.exit(1);
  }
  const ok = file.signatures.find((s) => verifyDetached(manifest, s.sig, publicKey));
  if (!ok) {
    console.error("no signature in the file verifies against the key");
    process.exit(1);
  }
  console.log(`verified: key id ${ok.keyId}`);
  process.exit(0);
}

const keyId = arg("key-id");
const pem = process.env.RELEASE_MANIFEST_SIGNING_KEY;
if (!keyId || !pem) {
  console.error("--key-id and RELEASE_MANIFEST_SIGNING_KEY in the environment are required");
  process.exit(2);
}
const out = arg("out") ?? `${manifestPath}.sig`;
let file: ManifestSignatureFile = { signatures: [] };
if (flag("append")) {
  try {
    const prev: unknown = JSON.parse(readFileSync(out, "utf8"));
    if (isManifestSignatureFile(prev)) file = { signatures: prev.signatures.filter((s) => s.keyId !== keyId) };
  } catch {}
}
const signature = signManifest(manifest, pem, keyId);
file.signatures.push(signature);
// Self check before anything is written: the signature must verify with the
// public half of the key that made it.
const { createPrivateKey, createPublicKey } = await import("node:crypto");
const publicKey = publicKeyToBase64(createPublicKey(createPrivateKey(pem)));
if (!verifyDetached(manifest, signature.sig, publicKey)) {
  console.error("self check failed: the signature does not verify");
  process.exit(1);
}
writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
console.log(`signed ${manifestPath} as ${keyId} -> ${out} (public key ${publicKey})`);
