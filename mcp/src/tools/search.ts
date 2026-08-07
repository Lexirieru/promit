import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { formatUsdc } from "@promit/x402-client";

import { fetchCatalog, type PublicEntry } from "../api";
import type { McpConfig } from "../env";

/**
 * What search returns per hit: catalog metadata only, never prompt text.
 * priceUsdc is pre-formatted so the model can quote it without knowing
 * atomic USDC arithmetic.
 */
const entrySummary = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  teaser: z.string(),
  tier: z.enum(["free", "paid"]),
  priceAtomic: z.string(),
  priceUsdc: z.string(),
  contentHash: z.string(),
});

const outputSchema = z.object({
  entries: z.array(entrySummary),
  total: z.number(),
});

const inputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Substring matched against id, title, teaser, and category (omit to list everything)"),
  category: z.string().optional().describe('Exact category filter, e.g. "Landing Page"'),
  tier: z.enum(["free", "paid"]).optional().describe("Tier filter"),
});

function matches(entry: PublicEntry, query: string): boolean {
  const haystack = `${entry.id} ${entry.title} ${entry.teaser} ${entry.category}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function summarize(entry: PublicEntry): z.infer<typeof entrySummary> {
  return {
    id: entry.id,
    title: entry.title,
    category: entry.category,
    teaser: entry.teaser,
    tier: entry.tier,
    priceAtomic: entry.priceAtomic,
    priceUsdc: entry.tier === "free" ? "free" : formatUsdc(BigInt(entry.priceAtomic)),
    contentHash: entry.contentHash,
  };
}

export function registerSearchTool(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "promit_search",
    {
      title: "Search Promit prompts",
      description:
        "Search the Promit prompt marketplace catalog by keyword, category, or tier. " +
        "Returns public metadata only (title, teaser, price, content hash) — never prompt text.",
      inputSchema,
      outputSchema,
      // The host decides what needs confirmation from these hints: search
      // reads a public catalog and pays nothing.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, category, tier }) => {
      const catalog = await fetchCatalog(config.apiBase, { category, tier });
      const entries = (query ? catalog.entries.filter((e) => matches(e, query)) : catalog.entries).map(
        summarize,
      );
      const structuredContent = { entries, total: entries.length };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  );
}
