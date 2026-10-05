# @platform/crypto

End to end encryption primitives, lifted unchanged from codecast's
`packages/shared/encryption`. AES-256-GCM, HMAC-SHA-512, a key derivation tree,
base64 and UTF-8 helpers. It also holds HMAC-SHA-256 with hex output and a
constant-time compare (`hmac_sha256`, `hmacSha256Hex` for a text secret and
text data, `encodeHex`, `timingSafeEqual`), which
webhook signatures and AWS request signing share. Pure Web Crypto: it runs in
a browser, in bun, in node and in a worker, with no dependency on any other platform package.

## Wire compatible with the donor

The files were copied from codecast's `packages/shared/encryption` and then two
defects were repaired, described under "Two repairs" below. Nothing about the
cryptography itself was reviewed, tuned or improved: the algorithms, the key
sizes, the IV length, the tag length, the tree labels and the error handling are
exactly what encrypts codecast's data today, because changing any of them makes
existing ciphertext unreadable.

The repairs do not touch the format. A ciphertext the donor wrote still opens
here, and gives back exactly what the donor gave back. The test suite proves it
with ciphertexts frozen from a run of the donor code.

## API

```ts
import { deriveKey, encodeBase64, encryptAESGCMString, decryptAESGCMString } from "@platform/crypto";

const master = crypto.getRandomValues(new Uint8Array(32));
const sessionKey = encodeBase64(await deriveKey(master, "messages", ["session-123"]));

const sealed = await encryptAESGCMString("secret message", sessionKey);
const opened = await decryptAESGCMString(sealed, sessionKey); // null if it cannot
```

**AES-256-GCM** (`src/aes.ts`). `encryptAESGCMString(text, key64)` generates a
random 12 byte IV, encrypts, and returns base64 of the IV followed by the
ciphertext with its 16 byte tag appended. `decryptAESGCMString(sealed, key64)`
returns the text, or **null** on any failure: wrong key, tampered ciphertext,
malformed base64. It does not say which, and it does not throw.
`encryptAESGCM` / `decryptAESGCM` are the `Uint8Array` pair underneath. They
write and read the same layout, they take and return the bytes you give them,
and they are safe for arbitrary binary: files, images, compressed payloads.
All four take an optional last argument, `additionalData` (a string for the
text pair, bytes for the binary pair). It is authenticated but not encrypted,
and decrypting needs the same value again, so a ciphertext sealed for one row
and field returns null if it is copied into another. Leave it out and the
output is exactly what it was before the option existed.

**HMAC-SHA-512** (`src/hmac_sha512.ts`). `hmac_sha512(key, data)` returns 64
bytes. It matches the published RFC 4231 vectors, which the tests assert.

**Key derivation** (`src/deriveKey.ts`). A BIP32 shaped tree over HMAC-SHA-512.
`deriveSecretKeyTreeRoot(seed, usage)` hashes the seed under the label
`` `${usage} Master Seed` `` and splits the 64 bytes into a 32 byte key and a 32
byte chain code. `deriveSecretKeyTreeChild(chainCode, index)` hashes a `0x00`
byte followed by the index string under the chain code, and splits the same
way. `deriveKey(master, usage, path)` walks the path and returns the last key,
so an empty path returns the root key. Every key is the 32 bytes AES-256 wants.
Derivation is deterministic: the same seed, usage and path always give the same
key, and any change to any of them gives an unrelated one.

**base64** (`src/base64.ts`). `encodeBase64(bytes, "base64" | "base64url")` and
`decodeBase64(text, encoding)`. The url form swaps `+/` for `-_` and drops the
padding on encode, and restores it on decode. Decoding is strict about its
encoding: a url encoded string read as standard base64 throws, as does anything
that is not base64.

**text** (`src/text.ts`). `encodeUTF8`, `decodeUTF8`, `normalizeNFKD`.

## Two repairs

The donor code passed binary through a UTF-8 string on both the encrypt and the
decrypt side, so any byte sequence that is not valid UTF-8 became the
replacement character and the original bytes were lost. The four bytes
`ff fe 00 41` came back as the eight bytes `ef bf bd ef bf bd 00 41`. The byte
functions now call Web Crypto directly, and the string functions are thin
wrappers over them that encode to UTF-8 on the way in and decode on the way out.

The repair changes what gets encrypted, never how it is written. The layout is
the same random 12 byte nonce, ciphertext, and 16 byte tag as before, so old
ciphertext still opens and still yields the same bytes it always did. Everything
the donor sealed held valid UTF-8, and valid UTF-8 survived the old round trip
untouched, which is why nothing needs migrating and no version marker was added.

Two smaller behaviours changed with it. `decryptAESGCM` used to return null for
an empty payload, because it tested the decrypted text for truthiness and the
empty string is falsy; it now returns zero bytes, and reserves null for real
failures. And `encodeBase64` used to build its string with
`String.fromCharCode.apply`, which spreads every byte as an argument and
overflows the call stack above roughly half a million bytes; it now reads the
buffer in 32768 byte pieces. Its output is unchanged for every input that
worked before.

## How codecast adopts it

`packages/shared/encryption/` deletes entirely: `aes.ts`, `base64.ts`,
`deriveKey.ts`, `hmac_sha512.ts`, `text.ts`, `index.ts` and its README. Every
`@codecast/shared/encryption` import becomes `@platform/crypto`. Nothing else
changes: the signatures match, the format matches, and every ciphertext codecast
has already stored opens the same way.

The adoption is safe to verify by decryption rather than by reading: this
package's test suite decrypts a ciphertext produced by the donor module, and
asserts the derivation vectors the donor produces from a fixed seed. If a
future edit breaks compatibility, those tests fail.

`packages/shared/contracts/providerKeyCrypto.ts` stays in codecast. It is the
wire contract for one codecast feature, not a primitive: it names an HKDF info
string of `codecast-provider-key-v1` and a payload shaped around codecast's
daemon commands. An app that wants a sealed box over ECDH keeps its own such
contract module and uses this package for the pieces underneath.

## How another app wires it

Nothing to wire. Import the functions and hold your own master key; there is no
client, no configuration and no state. The one decision an app must make is
where the master key lives and how it reaches each surface, which is the app's
problem and not this package's.

A useful shape, and the one codecast uses: keep one master key per account,
derive a key per usage and object with `deriveKey(master, usage, path)`, and
store only the base64 ciphertext. Derivation is cheap and deterministic, so
nothing needs a key table; the path is the key.

## Tests

`bun test` — 39 tests, no network. They cover round trips, published RFC 4231
vectors for HMAC-SHA-512, RFC 4648 vectors and padding edge cases for base64,
frozen derivation vectors taken from the donor implementation, and ciphertexts
the donor wrote that this package must still open and must still read the same
way. Binary is covered end to end: bytes that are not valid UTF-8, a one
megabyte payload, and a base64 payload past the size that used to overflow the
stack. `npx tsc --noEmit` covers src and the tests.
