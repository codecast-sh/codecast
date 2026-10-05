export function encodeUTF8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

export function decodeUTF8(value: Uint8Array): string {
    return new TextDecoder().decode(value);
}

export function normalizeNFKD(value: string): string {
    return value.normalize('NFKD');
}
