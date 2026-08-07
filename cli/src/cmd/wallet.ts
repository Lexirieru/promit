import { existsSync } from "node:fs";

import { defineCommand } from "citty";
import { isCancel, password } from "@clack/prompts";
import pc from "picocolors";
import { erc20Abi } from "viem";
import { generatePrivateKey } from "viem/accounts";

import { BASE_SEPOLIA_USDC, formatUsdc } from "@promit/x402-client";

import { emit, fail, note, stdinIsInteractive, success } from "../output";
import { registryClient, rpcUrl } from "../registry";
import {
  envPrivateKey,
  keystoreAddress,
  keystorePath,
  saveKeystore,
} from "../wallet/keystore";

/**
 * Key custody for the CLI (KTD15): an encrypted keystore under
 * ~/.config/promit/keystores by default, PROMIT_PRIVATE_KEY as the
 * automation override. Creation and import are interactive-only because a
 * password gathered from a pipe is a password logged somewhere.
 */

async function askPassword(purpose: string): Promise<string> {
  const first = await password({ message: `Choose a password to encrypt ${purpose}:` });
  if (isCancel(first) || !first) {
    fail("a non-empty keystore password is required");
  }
  const second = await password({ message: "Repeat the password:" });
  if (isCancel(second) || second !== first) {
    fail("the passwords do not match");
  }
  return first;
}

function requireInteractive(action: string): void {
  if (!stdinIsInteractive()) {
    fail(
      `"promit wallet ${action}" is interactive (it gathers a keystore password) and stdin is not ` +
        `a terminal.`,
      "For unattended use set PROMIT_PRIVATE_KEY instead of a keystore.",
    );
  }
}

const create = defineCommand({
  meta: { name: "create", description: "Generate a new key and store it encrypted" },
  args: {
    name: { type: "string", description: "Keystore name (default: default)" },
    force: { type: "boolean", description: "Overwrite an existing keystore of the same name" },
  },
  async run({ args }) {
    requireInteractive("create");
    const name = args.name ?? "default";
    const pass = await askPassword(`keystore "${name}"`);
    try {
      const saved = await saveKeystore(name, generatePrivateKey(), pass, {
        overwrite: args.force === true,
      });
      success(`created ${saved.file} (permissions 600)`);
      emit(saved.address);
      note(pc.dim("Fund this address with Base Sepolia USDC; buyer wallets never need ETH (R17)."));
    } catch (error) {
      fail((error as Error).message);
    }
  },
});

const importCmd = defineCommand({
  meta: { name: "import", description: "Encrypt an existing private key into the keystore" },
  args: {
    name: { type: "string", description: "Keystore name (default: default)" },
    force: { type: "boolean", description: "Overwrite an existing keystore of the same name" },
  },
  async run({ args }) {
    requireInteractive("import");
    const name = args.name ?? "default";
    const key = await password({ message: "Private key to import (0x + 64 hex, input hidden):" });
    if (isCancel(key) || !key) {
      fail("no private key entered");
    }
    const pass = await askPassword(`keystore "${name}"`);
    try {
      const saved = await saveKeystore(name, key.trim() as `0x${string}`, pass, {
        overwrite: args.force === true,
      });
      success(`imported into ${saved.file} (permissions 600)`);
      emit(saved.address);
    } catch (error) {
      fail((error as Error).message);
    }
  },
});

const show = defineCommand({
  meta: { name: "show", description: "Show the active wallet address and key source" },
  args: {
    keystore: { type: "string", description: "Keystore name (default: PROMIT_KEYSTORE or default)" },
    balance: { type: "boolean", description: "Also query the USDC balance over RPC" },
    rpc: { type: "string", description: "Base Sepolia RPC URL" },
  },
  async run({ args }) {
    let address: string;
    let source: string;
    try {
      const fromEnv = envPrivateKey();
      if (fromEnv) {
        const { privateKeyToAccount } = await import("viem/accounts");
        address = privateKeyToAccount(fromEnv).address;
        source = "PROMIT_PRIVATE_KEY (overrides any keystore)";
      } else {
        const file = keystorePath(args.keystore ?? process.env.PROMIT_KEYSTORE ?? "default");
        if (!existsSync(file)) {
          fail(
            `no key configured: PROMIT_PRIVATE_KEY is unset and there is no keystore at ${file}.`,
            'Create one with "promit wallet create".',
          );
        }
        // Address display only needs the cleartext envelope, never a password.
        address = keystoreAddress(file);
        source = file;
      }
    } catch (error) {
      fail((error as Error).message);
    }
    emit(address);
    note(pc.dim(`source: ${source}`));

    if (args.balance) {
      try {
        const client = registryClient(rpcUrl(args.rpc));
        const balance = await client.readContract({
          address: BASE_SEPOLIA_USDC as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address as `0x${string}`],
        });
        note(`USDC balance: ${formatUsdc(balance)}`);
      } catch (error) {
        fail(`could not read the USDC balance over RPC: ${(error as Error).message}`);
      }
    }
  },
});

export default defineCommand({
  meta: { name: "wallet", description: "Create, import, and inspect the Promit wallet key" },
  subCommands: { create, import: importCmd, show },
});
