import { describe, expect, it } from "vitest";
import {
  decryptString,
  decodeEncryptionKey,
  encryptString,
  timingSafeEqualString,
} from "../src/crypto.ts";

const HEX_KEY = "ab".repeat(32);

describe("AES-GCM encrypt/decrypt", () => {
  it("round-trips a token string with a hex key", async () => {
    const blob = await encryptString("dida-access-token", HEX_KEY);
    expect(blob.v).toBe(1);
    expect(blob.iv).not.toContain("dida-access-token");
    expect(blob.ciphertext).not.toContain("dida-access-token");
    await expect(decryptString(blob, HEX_KEY)).resolves.toBe(
      "dida-access-token",
    );
  });

  it("rejects a wrong key", async () => {
    const blob = await encryptString("secret", HEX_KEY);
    await expect(decryptString(blob, "cd".repeat(32))).rejects.toThrow(
      /Decryption failed/,
    );
  });

  it("accepts a 32-byte base64 key", () => {
    const bytes = new Uint8Array(32).fill(7);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const b64 = btoa(binary);
    expect(decodeEncryptionKey(b64).byteLength).toBe(32);
  });
});

describe("timingSafeEqualString", () => {
  it("matches equal secrets", async () => {
    await expect(timingSafeEqualString("abc", "abc")).resolves.toBe(true);
  });

  it("rejects different secrets even when lengths differ", async () => {
    await expect(timingSafeEqualString("abc", "ab")).resolves.toBe(false);
  });
});
