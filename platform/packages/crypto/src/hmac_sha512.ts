export async function hmac_sha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key as BufferSource,
        { name: 'HMAC', hash: 'SHA-512' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource);

    return new Uint8Array(signature);
}
