import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// KTD15: viem has no keystore encrypt/decrypt, so ethers@6 supplies exactly
// these two calls. Everything else key-shaped stays on viem.
import { decryptKeystoreJson, encryptKeystoreJson } from "ethers";
import { getAddress } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { defaultConfigDir } from "@promit/x402-client";

/** ~/.config/promit/keystores (PROMIT_CONFIG_DIR moves the root). */
export function keystoreDir(configDir: string = defaultConfigDir()): string {
  return join(configDir, "keystores");
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function keystorePath(name: string, configDir?: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid keystore name ${JSON.stringify(name)}: use letters, digits, "-" or "_" only`,
    );
  }
  return join(keystoreDir(configDir), `${name}.json`);
}

export class KeystorePermissionError extends Error {
  constructor(
    readonly file: string,
    readonly mode: number,
  ) {
    super(
      `refusing keystore ${file}: permission bits ${mode.toString(8).padStart(3, "0")} allow ` +
        `group or world access to an encrypted key. Run: chmod 600 ${file}`,
    );
    this.name = "KeystorePermissionError";
  }
}

export class KeystoreMissingError extends Error {
  constructor(readonly file: string) {
    super(
      `no keystore at ${file}. Create one with "promit wallet create", import an existing key ` +
        `with "promit wallet import", or set PROMIT_PRIVATE_KEY.`,
    );
    this.name = "KeystoreMissingError";
  }
}

export class InvalidPrivateKeyError extends Error {
  constructor(source: string) {
    super(`${source} is not a private key: expected 0x followed by 64 hex characters`);
    this.name = "InvalidPrivateKeyError";
  }
}

const GROUP_OR_WORLD_BITS = 0o077;

/**
 * The permission check runs BEFORE the file is read (plan U11): a keystore
 * readable by other users is treated as compromised-by-configuration, and
 * loading it anyway would normalize exactly the state the check exists to
 * catch. Windows has no POSIX mode bits, but every Promit surface targets
 * darwin/linux.
 */
export function assertPrivatePermissions(file: string): void {
  if (process.platform === "win32") return;
  const mode = statSync(file).mode & 0o777;
  if ((mode & GROUP_OR_WORLD_BITS) !== 0) {
    throw new KeystorePermissionError(file, mode);
  }
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** PROMIT_PRIVATE_KEY, validated; null when unset or blank. */
export function envPrivateKey(
  env: Record<string, string | undefined> = process.env,
): `0x${string}` | null {
  const raw = env.PROMIT_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (!PRIVATE_KEY_PATTERN.test(raw)) {
    throw new InvalidPrivateKeyError("PROMIT_PRIVATE_KEY");
  }
  return raw as `0x${string}`;
}

export interface ResolvedSigner {
  account: PrivateKeyAccount;
  source: "env" | "keystore";
  /** Set when source is "keystore". */
  file?: string;
}

export interface ResolveSignerOptions {
  /** Keystore basename; defaults to PROMIT_KEYSTORE or "default". */
  keystoreName?: string;
  configDir?: string;
  env?: Record<string, string | undefined>;
  /**
   * Asked for the keystore password. Callers without an interactive stdin
   * must throw a named error here rather than hang — the MCP/pipeline path
   * is PROMIT_PRIVATE_KEY, never a prompt.
   */
  promptPassword: (file: string) => Promise<string>;
}

/**
 * Key resolution order (KTD15): PROMIT_PRIVATE_KEY wins over the encrypted
 * keystore whenever both are present, because the env var is the automation
 * override and automation cannot answer a password prompt.
 */
export async function resolveSigner(options: ResolveSignerOptions): Promise<ResolvedSigner> {
  const env = options.env ?? process.env;
  const fromEnv = envPrivateKey(env);
  if (fromEnv) {
    return { account: privateKeyToAccount(fromEnv), source: "env" };
  }

  const name = options.keystoreName ?? env.PROMIT_KEYSTORE ?? "default";
  const file = keystorePath(name, options.configDir);
  if (!existsSync(file)) {
    throw new KeystoreMissingError(file);
  }
  assertPrivatePermissions(file);
  const json = readFileSync(file, "utf8");
  const password = await options.promptPassword(file);
  const decrypted = await decryptKeystoreJson(json, password);
  if (!PRIVATE_KEY_PATTERN.test(decrypted.privateKey)) {
    throw new InvalidPrivateKeyError(`keystore ${file}`);
  }
  return {
    account: privateKeyToAccount(decrypted.privateKey as `0x${string}`),
    source: "keystore",
    file,
  };
}

export interface SaveKeystoreOptions {
  configDir?: string;
  overwrite?: boolean;
  /** Weakened KDF cost for tests only; production callers omit it. */
  scrypt?: { N: number; r: number; p: number };
}

/** Encrypts and writes a keystore with owner-only permissions (0600/0700). */
export async function saveKeystore(
  name: string,
  privateKey: `0x${string}`,
  password: string,
  options: SaveKeystoreOptions = {},
): Promise<{ file: string; address: string }> {
  if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new InvalidPrivateKeyError("the provided key");
  }
  const file = keystorePath(name, options.configDir);
  if (existsSync(file) && !options.overwrite) {
    throw new Error(`keystore ${file} already exists; pass --force to overwrite it`);
  }
  const account = privateKeyToAccount(privateKey);
  const json = await encryptKeystoreJson(
    { address: account.address, privateKey },
    password,
    options.scrypt ? { scrypt: options.scrypt } : undefined,
  );
  const dir = keystoreDir(options.configDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, json, { encoding: "utf8", mode: 0o600 });
  // mkdir/writeFile modes are masked by umask; chmod sets them absolutely.
  chmodSync(dir, 0o700);
  chmodSync(file, 0o600);
  return { file, address: account.address };
}

/**
 * The address stored in the (cleartext) keystore envelope, for display
 * without a password. Never use this to sign — decrypt for that.
 */
export function keystoreAddress(file: string): string {
  assertPrivatePermissions(file);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { address?: string };
  if (typeof parsed.address !== "string") {
    throw new Error(`keystore ${file} carries no address field`);
  }
  return getAddress(parsed.address.startsWith("0x") ? parsed.address : `0x${parsed.address}`);
}
