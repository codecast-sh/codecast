import { encodeHex } from './hex';
import { encodeUTF8 } from './text';

export async function hmac_sha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource);

    return new Uint8Array(signature);
}

/** The lowercase hex HMAC-SHA256 of the text `data` under the text `secret`:
 *  the signature Stripe, Slack, Linear and Sentry webhooks carry, and the
 *  form an app signs its own state in. */
export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
    return encodeHex(await hmac_sha256(encodeUTF8(secret), encodeUTF8(data)));
}
