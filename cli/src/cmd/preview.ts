import { defineCommand } from "citty";
import pc from "picocolors";

import { formatUsdc } from "@promit/x402-client";

import { apiBaseUrl, fetchEntry } from "../api";
import { emit, fail, note } from "../output";

export default defineCommand({
  meta: {
    name: "preview",
    description: "Show a prompt's public details: teaser, price, and content hash",
  },
  args: {
    id: { type: "positional", required: true, description: "Prompt id, e.g. email-landing-page" },
    api: { type: "string", description: "Promit API base URL (default: PROMIT_API_URL or https://promitbackend-production.up.railway.app)" },
    json: { type: "boolean", description: "Print machine-readable JSON" },
  },
  async run({ args }) {
    const base = apiBaseUrl(args.api);
    note(pc.dim(`fetching ${args.id} from ${base} …`));

    let entry;
    try {
      entry = await fetchEntry(base, args.id);
    } catch (error) {
      fail((error as Error).message);
    }

    if (args.json) {
      emit(JSON.stringify(entry, null, 2));
      return;
    }

    const price = entry.tier === "free" ? "free" : formatUsdc(BigInt(entry.priceAtomic));
    const lines = [
      `${pc.bold(entry.title)}  ${pc.dim(`(${entry.id})`)}`,
      "",
      `  category   ${entry.category}`,
      `  tier       ${entry.tier}`,
      `  price      ${price}`,
      `  hash       ${entry.contentHash}`,
      `  media      ${entry.media ?? `none (${entry.mediaStatus})`}`,
      `  source     ${entry.attribution.source} (captured ${entry.attribution.capturedAt})`,
      `  note       ${entry.attribution.note}`,
      "",
      `  ${entry.teaser}`,
      "",
      pc.dim(
        entry.tier === "free"
          ? `full text: promit buy ${entry.id}`
          : `unlock: promit buy ${entry.id}   (pays ${price} in Base Sepolia USDC via x402)`,
      ),
    ];
    emit(lines.join("\n"));
  },
});
