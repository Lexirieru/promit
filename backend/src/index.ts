import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogFile } from "./catalog/index.ts";
import { loadCatalogFile } from "./catalog/index.ts";
import { openDb } from "./db.ts";
import { paymentCors } from "./middleware/cors.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { listingRoutes } from "./routes/listings.ts";
import { unlockRoutes } from "./routes/unlock.ts";
import { unlocksRoutes } from "./routes/unlocks.ts";

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

  // U4: the x402-gated unlock route. payTo/facilitator come from
  // PAY_TO_ADDRESS / FACILITATOR_URL; paymentCors above already exposes the
  // PAYMENT-* headers this route depends on.
  app.route("/v1/prompts", unlockRoutes({ catalog, db }));

  // Kepemilikan: daftar unlock delivered per wallet, supaya pembeli yang
  // kembali (browser/CLI) tahu apa yang sudah dia miliki sebelum menyentuh
  // jalur bayar. Teks tidak pernah lewat sini — itu tetap urusan
  // /v1/prompts/:id dengan bukti entitlement bertanda tangan.
  app.route("/v1/unlocks", unlocksRoutes({ db }));

  // U7: creator listing — bounds terpublikasi, prepare (hash+duplikat), dan
  // submit multipart bertanda tangan EIP-191. Upload media mendarat di
  // media/uploads/ (gitignored) dan tersaji lewat route /media/* di bawah.
  app.route("/v1/listings", listingRoutes({ catalog, db }));

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
    // never changes an id, so a day of caching is safe. nosniff karena
    // media/uploads/ (U7) berisi byte kiriman pengguna: tanpa ini, browser
    // lama bisa menebak-nebak konten menjadi HTML pada origin API.
    return new Response(file, {
      headers: {
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
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
