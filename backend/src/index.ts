import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogFile } from "./catalog/index.ts";
import { loadCatalogFile } from "./catalog/index.ts";
import { openDb } from "./db.ts";
import { paymentCors } from "./middleware/cors.ts";
import { catalogRoutes } from "./routes/catalog.ts";

/**
 * The Promit API (U3): public catalog + health + mirrored media, with the
 * x402 unlock route (/v1/prompts/:id) arriving in U4. Paths and response
 * shapes are the coordinator-locked U3<->U5 contract — the frontend
 * hardcodes them in frontend/src/lib/api.ts, so changing one here without
 * a decision_gate breaks the seam silently.
 */

const MEDIA_DIR = fileURLToPath(new URL("../media", import.meta.url));

/** Frontend default base URL is http://localhost:3001 (locked contract). */
export const DEFAULT_PORT = 3001;

export interface AppOptions {
  catalog?: CatalogFile;
  db?: Database;
}

export function createApp(options: AppOptions = {}) {
  const catalog = options.catalog ?? loadCatalogFile();
  const db = options.db ?? openDb();

  const app = new Hono();
  app.use("*", paymentCors());

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/v1/catalog", catalogRoutes({ catalog, db }));

  // R5: previews come from Promit-owned storage. backend/media/ is the
  // mirror output U2 committed; catalog media fields are /media/<file>.
  app.get("/media/*", async (c) => {
    const requested = decodeURIComponent(c.req.path.slice("/media/".length));
    const resolved = normalize(join(MEDIA_DIR, requested));
    // join() collapses "..", so anything escaping MEDIA_DIR no longer
    // carries the prefix — reject instead of serving files outside it.
    if (!resolved.startsWith(MEDIA_DIR + sep)) {
      return c.json(
        { error: "invalid_media_path", message: "Media path is not valid." },
        404,
      );
    }
    const file = Bun.file(resolved);
    if (!(await file.exists())) {
      return c.json(
        { error: "media_not_found", message: "No such media file." },
        404,
      );
    }
    // Media files are id-keyed mirror outputs; re-running the pipeline
    // never changes an id, so a day of caching is safe.
    return new Response(file, {
      headers: { "Cache-Control": "public, max-age=86400" },
    });
  });

  return app;
}

if (import.meta.main) {
  const app = createApp();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  Bun.serve({ port, fetch: app.fetch });
  console.log(`Promit API listening on http://localhost:${port}`);
}
