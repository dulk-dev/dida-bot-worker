import {
  DEFAULT_TOKEN_TTL_SECONDS,
  KV_EXPIRY_REMINDER,
  KV_LOCK,
  KV_OAUTH_STATE_PREFIX,
  KV_PROCESSED_PREFIX,
  KV_TOKEN,
  MERGE_LOCK_TTL_SECONDS,
  OAUTH_STATE_TTL_SECONDS,
  PROCESSED_TTL_SECONDS,
} from "./constants.ts";
import {
  decryptString,
  encryptString,
  type EncryptedBlob,
} from "./crypto.ts";

export interface StoredToken {
  issued_at: string;
  expires_at: string;
}

interface TokenRecord extends EncryptedBlob {
  issued_at: string;
  expires_at: string;
}

export interface TokenBundle extends StoredToken {
  access_token: string;
}

export async function putOAuthState(
  kv: KVNamespace,
  state: string,
): Promise<void> {
  await kv.put(`${KV_OAUTH_STATE_PREFIX}${state}`, "1", {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });
}

export async function consumeOAuthState(
  kv: KVNamespace,
  state: string,
): Promise<boolean> {
  const key = `${KV_OAUTH_STATE_PREFIX}${state}`;
  const existing = await kv.get(key);
  if (!existing) return false;
  await kv.delete(key);
  return true;
}

export async function storeAccessToken(
  kv: KVNamespace,
  encryptionKey: string,
  accessToken: string,
  expiresInSeconds: number | undefined,
  now = new Date(),
): Promise<StoredToken> {
  const ttl =
    typeof expiresInSeconds === "number" &&
    Number.isFinite(expiresInSeconds) &&
    expiresInSeconds > 0
      ? expiresInSeconds
      : DEFAULT_TOKEN_TTL_SECONDS;
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  const blob = await encryptString(accessToken, encryptionKey);
  const record: TokenRecord = {
    ...blob,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  await kv.put(KV_TOKEN, JSON.stringify(record));
  return { issued_at: issuedAt, expires_at: expiresAt };
}

export async function loadAccessToken(
  kv: KVNamespace,
  encryptionKey: string,
): Promise<TokenBundle | null> {
  const raw = await kv.get(KV_TOKEN);
  if (!raw) return null;
  let record: TokenRecord;
  try {
    record = JSON.parse(raw) as TokenRecord;
  } catch {
    return null;
  }
  if (
    record.v !== 1 ||
    typeof record.iv !== "string" ||
    typeof record.ciphertext !== "string"
  ) {
    return null;
  }
  const access_token = await decryptString(
    { v: 1, iv: record.iv, ciphertext: record.ciphertext },
    encryptionKey,
  );
  return {
    access_token,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
  };
}

export async function isFragmentProcessed(
  kv: KVNamespace,
  fragmentId: string,
): Promise<boolean> {
  const value = await kv.get(`${KV_PROCESSED_PREFIX}${fragmentId}`);
  return value !== null;
}

export async function markFragmentProcessed(
  kv: KVNamespace,
  fragmentId: string,
): Promise<void> {
  await kv.put(`${KV_PROCESSED_PREFIX}${fragmentId}`, "1", {
    expirationTtl: PROCESSED_TTL_SECONDS,
  });
}

export async function getExpiryReminderDate(
  kv: KVNamespace,
): Promise<string | null> {
  return kv.get(KV_EXPIRY_REMINDER);
}

export async function setExpiryReminderDate(
  kv: KVNamespace,
  shanghaiDate: string,
): Promise<void> {
  await kv.put(KV_EXPIRY_REMINDER, shanghaiDate);
}

export async function acquireMergeLock(kv: KVNamespace): Promise<boolean> {
  const existing = await kv.get(KV_LOCK);
  if (existing) return false;
  await kv.put(KV_LOCK, String(Date.now()), {
    expirationTtl: MERGE_LOCK_TTL_SECONDS,
  });
  return true;
}

export async function releaseMergeLock(kv: KVNamespace): Promise<void> {
  await kv.delete(KV_LOCK);
}
