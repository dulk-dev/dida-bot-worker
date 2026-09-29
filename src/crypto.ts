const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** TOKEN_ENCRYPTION_KEY: 32-byte key as 64 hex chars, or standard/base64url 32-byte key. */
export function decodeEncryptionKey(keyMaterial: string): Uint8Array {
  const trimmed = keyMaterial.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const bytes = base64ToBytes(padded);
    if (bytes.byteLength === 32) return bytes;
  } catch {
    throw new CryptoError("TOKEN_ENCRYPTION_KEY is not valid hex or base64");
  }
  throw new CryptoError(
    "TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)",
  );
}

async function importAesKey(keyMaterial: string): Promise<CryptoKey> {
  const raw = decodeEncryptionKey(keyMaterial);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface EncryptedBlob {
  v: 1;
  iv: string;
  ciphertext: string;
}

export async function encryptString(
  plaintext: string,
  keyMaterial: string,
): Promise<EncryptedBlob> {
  const key = await importAesKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return {
    v: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptString(
  blob: EncryptedBlob,
  keyMaterial: string,
): Promise<string> {
  if (blob.v !== 1 || !blob.iv || !blob.ciphertext) {
    throw new CryptoError("Unsupported ciphertext blob");
  }
  const key = await importAesKey(keyMaterial);
  const iv = base64ToBytes(blob.iv);
  const ciphertext = base64ToBytes(blob.ciphertext);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return decoder.decode(plaintext);
  } catch {
    throw new CryptoError("Decryption failed");
  }
}

/** Compare secrets without leaking length via early return on the digest. */
export async function timingSafeEqualString(
  a: string,
  b: string,
): Promise<boolean> {
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return timingSafeEqualBytes(aHash, bHash);
}

function timingSafeEqualBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}
