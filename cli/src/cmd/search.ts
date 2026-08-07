import { defineCommand } from "citty";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { formatUsdc } from "@promit/x402-client";

import { apiBaseUrl, fetchCatalog, type PublicEntry } from "../api";
import { emit, fail, note } from "../output";

function matches(entry: PublicEntry, query: string): boolean {
  const haystack = `${entry.id} ${entry.title} ${entry.teaser} ${entry.category}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function priceLabel(entry: PublicEntry): string {
  return entry.tier === "free" ? "free" : formatUsdc(BigInt(entry.priceAtomic));
}

export default defineCommand({
  meta: {
    name: "search",
    description: "Search the prompt catalog by title, teaser, or category",
  },
  args: {
    query: {
      type: "positional",
      required: false,
      description: "Substring to match (omit to list everything)",
    },
    category: { type: "string", description: "Exact category filter, e.g. \"Landing Page\"" },
    tier: { type: "string", description: "Tier filter: free or paid" },
    api: { type: "string", description: "Promit API base URL (default: PROMIT_API_URL or https://promitbackend-production.up.railway.app)" },
    json: { type: "boolean", description: "Print machine-readable JSON instead of a table" },
  },
  async run({ args }) {
    if (args.tier && args.tier !== "free" && args.tier !== "paid") {
      fail(`unknown tier ${JSON.stringify(args.tier)}: expected "free" or "paid"`);
    }
    const base = apiBaseUrl(args.api);
    note(pc.dim(`searching ${base} …`));

    let entries: PublicEntry[];
    try {
      const catalog = await fetchCatalog(base, { category: args.category, tier: args.tier });
      entries = catalog.entries;
    } catch (error) {
      fail((error as Error).message);
    }
    if (args.query) {
      entries = entries.filter((entry) => matches(entry, args.query as string));
    }

    if (args.json) {
      emit(JSON.stringify({ entries, total: entries.length }, null, 2));
      return;
    }

    // The named empty state (R27): a message, never a bare table frame with
    // zero rows that reads as a rendering bug.
    if (entries.length === 0) {
      const criteria = [
        args.query && `query ${JSON.stringify(args.query)}`,
        args.category && `category ${JSON.stringify(args.category)}`,
        args.tier && `tier ${JSON.stringify(args.tier)}`,
      ]
        .filter(Boolean)
        .join(", ");
      emit(`No prompts match ${criteria || "the catalog filters"}. Try "promit search" with no arguments to list everything.`);
      return;
    }

    const table = new Table({
      columns: [
        { name: "id", alignment: "left" },
        { name: "title", alignment: "left", maxLen: 32 },
        { name: "category", alignment: "left" },
        { name: "tier", alignment: "left" },
        { name: "price", alignment: "right" },
      ],
      shouldDisableColors: process.stdout.isTTY !== true || process.env.NO_COLOR !== undefined,
    });
    for (const entry of entries) {
      table.addRow({
        id: entry.id,
        title: entry.title,
        category: entry.category,
        tier: entry.tier,
        price: priceLabel(entry),
      });
    }
    emit(table.render());
    note(pc.dim(`${entries.length} prompt${entries.length === 1 ? "" : "s"} · "promit preview <id>" for details`));
  },
});
