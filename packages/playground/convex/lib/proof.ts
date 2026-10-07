// The work a browser does to become a visitor (visitors.register). Minting
// an identity is otherwise free, and every per-visitor limit is only as
// strong as a visitor is costly, so registering asks for a small proof of
// work over the new secret's hash: a nonce whose hash with it starts with
// `bits` zero bits. A person's browser pays a fraction of a second once; a
// script minting thousands pays that thousands of times, and more while the
// deployment sees a flood. Both sides use the synchronous
// SHA-256 here, which is many times faster than crypto.subtle for millions
// of tiny inputs.

export const PROOF_BITS = 16;
export const PROOF_BITS_FLOOD = 18;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);

/** SHA-256 of an ASCII string, as eight 32-bit words. */
export function sha256Words(text: string): Uint32Array {
  const len = text.length;
  const blocks = ((len + 8) >> 6) + 1;
  const bytes = new Uint8Array(blocks * 64);
  for (let i = 0; i < len; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  bytes[len] = 0x80;
  const bitLen = len * 8;
  const end = blocks * 64;
  bytes[end - 4] = bitLen >>> 24;
  bytes[end - 3] = bitLen >>> 16;
  bytes[end - 2] = bitLen >>> 8;
  bytes[end - 1] = bitLen;
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  for (let off = 0; off < end; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15];
      const b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return h;
}

/** Leading zero bits of a digest. */
export function zeroBits(words: Uint32Array): number {
  let n = 0;
  for (const w of words) {
    if (w === 0) {
      n += 32;
      continue;
    }
    return n + Math.clz32(w);
  }
  return n;
}

const proofInput = (secretHash: string, nonce: number) => `clayground:${secretHash}:${nonce}`;

/** Whether `nonce` proves `bits` of work over a secret's hash. */
export function proofHolds(secretHash: string, nonce: number, bits: number): boolean {
  return Number.isSafeInteger(nonce) && nonce >= 0 && zeroBits(sha256Words(proofInput(secretHash, nonce))) >= bits;
}

/** A macrotask turn, so the page can paint between slices of work. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Find a nonce for `bits`, yielding to the page every `slice` tries. */
export async function solveProof(secretHash: string, bits: number, slice = 20_000): Promise<number> {
  for (let nonce = 0; ; nonce++) {
    if (zeroBits(sha256Words(proofInput(secretHash, nonce))) >= bits) return nonce;
    if (nonce % slice === slice - 1) await nextTask();
  }
}
