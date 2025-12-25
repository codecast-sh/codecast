# Encryption Utilities

Cross-platform encryption utilities for end-to-end encryption of conversation data.

## Features

- **AES-256-GCM**: String and binary encryption
- **HMAC-SHA512**: Key derivation and integrity
- **BIP32-style key derivation**: Hierarchical key generation
- **Base64 encoding**: Standard and URL-safe encoding

## Usage

```typescript
import { encryptAESGCMString, decryptAESGCMString, deriveKey, encodeBase64 } from '@codecast/shared/encryption';

const masterKey = crypto.getRandomValues(new Uint8Array(32));
const masterKeyBase64 = encodeBase64(masterKey);

const sessionKey = await deriveKey(masterKey, 'messages', ['session-123']);
const sessionKeyBase64 = encodeBase64(sessionKey);

const encrypted = await encryptAESGCMString('secret message', sessionKeyBase64);
const decrypted = await decryptAESGCMString(encrypted, sessionKeyBase64);
```

## Implementation Notes

- Uses Web Crypto API (works in browsers and Node.js)
- All keys are 32 bytes (256 bits)
- IV is randomly generated per encryption (12 bytes for GCM)
- Returns null on decryption failure (invalid key or corrupted data)
