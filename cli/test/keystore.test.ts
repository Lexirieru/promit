import { describe, expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";

import { privateKeyToAccount } from "viem/accounts";

import {
  InvalidPrivateKeyError,
  KeystoreMissingError,
  KeystorePermissionError,
  envPrivateKey,
  keystoreAddress,
  keystorePath,
  resolveSigner,
  saveKeystore,
} from "../src/wallet/keystore";
import { TEST_PRIVATE_KEY, freshConfigDir } from "./helpers";

const KEY = TEST_PRIVATE_KEY as `0x${string}`;
const KEY_ADDRESS = privateKeyToAccount(KEY).address;
const OTHER_KEY = `0x${"22".repeat(32)}` as `0x${string}`;

/** ethers' default scrypt (N=2^17) takes ~1s per call; tests weaken it. */
const FAST_SCRYPT = { N: 1 << 10, r: 8, p: 1 };

function noPassword(): Promise<string> {
  throw new Error("password prompt must not be reached in this test");
}

describe("keystore", () => {
  test("saveKeystore writes the file with owner-only permissions", async () => {
    const dir = freshConfigDir();
    const saved = await saveKeystore("default", KEY, "hunter2", {
      configDir: dir,
      scrypt: FAST_SCRYPT,
    });
    expect(saved.address).toBe(KEY_ADDRESS);
    expect(statSync(saved.file).mode & 0o777).toBe(0o600);
    expect(keystoreAddress(saved.file)).toBe(KEY_ADDRESS);
  });

  test("a keystore with group- or world-readable permissions is refused before any read", async () => {
    const dir = freshConfigDir();
    const saved = await saveKeystore("default", KEY, "hunter2", {
      configDir: dir,
      scrypt: FAST_SCRYPT,
    });
    chmodSync(saved.file, 0o644);
    await expect(
      resolveSigner({ configDir: dir, env: {}, promptPassword: noPassword }),
    ).rejects.toThrow(KeystorePermissionError);
    // The refusal names the offending bits and the fix.
    await expect(
      resolveSigner({ configDir: dir, env: {}, promptPassword: noPassword }),
    ).rejects.toThrow(/644.*chmod 600/s);
  });

  test("group-readable alone (640) is also refused", async () => {
    const dir = freshConfigDir();
    const saved = await saveKeystore("default", KEY, "hunter2", {
      configDir: dir,
      scrypt: FAST_SCRYPT,
    });
    chmodSync(saved.file, 0o640);
    await expect(
      resolveSigner({ configDir: dir, env: {}, promptPassword: noPassword }),
    ).rejects.toThrow(KeystorePermissionError);
  });

  test("PROMIT_PRIVATE_KEY takes precedence over an existing keystore", async () => {
    const dir = freshConfigDir();
    // The keystore holds OTHER_KEY; the env var holds KEY. Env must win and
    // the password callback must never fire.
    await saveKeystore("default", OTHER_KEY, "hunter2", { configDir: dir, scrypt: FAST_SCRYPT });
    const signer = await resolveSigner({
      configDir: dir,
      env: { PROMIT_PRIVATE_KEY: KEY },
      promptPassword: noPassword,
    });
    expect(signer.source).toBe("env");
    expect(signer.account.address).toBe(KEY_ADDRESS);
  });

  test("the keystore decrypts with the password when no env key is set", async () => {
    const dir = freshConfigDir();
    await saveKeystore("default", KEY, "hunter2", { configDir: dir, scrypt: FAST_SCRYPT });
    const signer = await resolveSigner({
      configDir: dir,
      env: {},
      promptPassword: async () => "hunter2",
    });
    expect(signer.source).toBe("keystore");
    expect(signer.account.address).toBe(KEY_ADDRESS);
  });

  test("a malformed PROMIT_PRIVATE_KEY is a named error, not a fallthrough to the keystore", () => {
    expect(() => envPrivateKey({ PROMIT_PRIVATE_KEY: "not-a-key" })).toThrow(
      InvalidPrivateKeyError,
    );
  });

  test("a missing keystore names the file and the ways out", async () => {
    const dir = freshConfigDir();
    await expect(
      resolveSigner({ configDir: dir, env: {}, promptPassword: noPassword }),
    ).rejects.toThrow(KeystoreMissingError);
    await expect(
      resolveSigner({ configDir: dir, env: {}, promptPassword: noPassword }),
    ).rejects.toThrow(/wallet create.*PROMIT_PRIVATE_KEY/s);
  });

  test("keystore names cannot escape the keystores directory", () => {
    expect(() => keystorePath("../evil")).toThrow(/invalid keystore name/);
  });

  test("an existing keystore is not overwritten without overwrite", async () => {
    const dir = freshConfigDir();
    await saveKeystore("default", KEY, "a", { configDir: dir, scrypt: FAST_SCRYPT });
    await expect(
      saveKeystore("default", OTHER_KEY, "b", { configDir: dir, scrypt: FAST_SCRYPT }),
    ).rejects.toThrow(/already exists/);
  });
});
