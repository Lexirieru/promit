import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { formatUsdc } from "@promit/x402-client";

import { fetchEntry } from "../api";
import type { McpConfig } from "../env";

const attribution = z.object({
  source: z.string(),
  capturedAt: z.string(),
  note: z.string(),
});

/** The full public entry: everything the catalog serves without payment. */
const outputSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  teaser: z.string(),
  media: z.string().nullable(),
  mediaType: z.enum(["image", "video"]),
  mediaStatus: z.enum(["mirrored", "unavailable"]),
  poster: z.string().nullable(),
  priceAtomic: z.string(),
  priceUsdc: z.string(),
  tier: z.enum(["free", "paid"]),
  contentHash: z.string(),
  attribution,
});

const inputSchema = z.object({
  id: z.string().describe("Prompt id, e.g. email-landing-page"),
});

export function registerPreviewTool(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "promit_preview",
    {
      title: "Preview a Promit prompt",
      description:
        "Fetch one prompt's public details: teaser, price, preview media, content hash, and " +
        "source attribution. The preview media is that prompt's own output. Never returns " +
        "prompt text — use promit_buy to unlock it.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const entry = await fetchEntry(config.apiBase, id);
      const structuredContent = {
        ...entry,
        priceUsdc: entry.tier === "free" ? "free" : formatUsdc(BigInt(entry.priceAtomic)),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  );
}
