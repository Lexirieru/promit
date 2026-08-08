import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogFile } from "./catalog/index.ts";
import { loadCatalogFile } from "./catalog/index.ts";
import { openDb } from "./db.ts";
import { paymentCors } from "./middleware/cors.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { creatorRoutes } from "./routes/creators.ts";
import { listingRoutes } from "./routes/listings.ts";
import { createPayoutChain } from "./payouts/chain";
import { runPayouts } from "./payouts/index";
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

/**
 * Creator uploads (U7) are the only media written at runtime, so they are the
 * only media a container rebuild can lose. `PROMIT_UPLOADS_ROOT` points them
 * at a persistent disk; unset, they stay where they have always been.
 *
 * Kept as a SEPARATE root from MEDIA_DIR: a volume mounted over `backend/media`
 * would shadow the committed seed media with an empty directory and break every
 * other preview. Mirrors `DEFAULT_LISTING_MEDIA_DIR` in catalog/listing.ts,
 * which is where the same files get written.
 */
const UPLOADS_ROOT = process.env.PROMIT_UPLOADS_ROOT ?? MEDIA_DIR;
const UPLOADS_PREFIX = "uploads/";

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

  // Sisi kreator dari data yang sama: apa yang dia list, siapa yang
  // membeli, berapa yang terkumpul. Tanpa ini kreator buta terhadap
  // penjualannya sendiri.
  app.route("/v1/creators", creatorRoutes({ db }));

  // R5: previews come from Promit-owned storage. backend/media/ is the
  // mirror output U2 committed; catalog media fields are /media/<file>.
  app.get("/media/*", async (c) => {
    const requested = decodeURIComponent(c.req.path.slice("/media/".length));
    // Runtime uploads may live on a different disk than the committed seed
    // media; the URL space stays one namespace so catalog `media` fields and
    // the traversal guard below are unchanged.
    // Uploads are looked up on the mounted disk first, then in the committed
    // tree. The fallback is what makes a lost upload recoverable: a volume
    // cannot be written to from a deploy, so restoring a file any other way
    // means shell access to production. Committing it under the same relative
    // path ships it with the build instead, and a later runtime upload of the
    // same id still wins because the disk is consulted first.
    const roots =
      requested.startsWith(UPLOADS_PREFIX) && UPLOADS_ROOT !== MEDIA_DIR
        ? [UPLOADS_ROOT, MEDIA_DIR]
        : [requested.startsWith(UPLOADS_PREFIX) ? UPLOADS_ROOT : MEDIA_DIR];

    let found: ReturnType<typeof Bun.file> | null = null;
    for (const root of roots) {
      const resolved = normalize(join(root, requested));
      // join() collapses "..", so anything escaping the root no longer carries
      // the prefix — reject instead of serving files outside it. Checked per
      // root: a traversal must not be rescued by the next candidate.
      if (!resolved.startsWith(root + sep)) {
        return c.json(
          { error: "invalid_media_path", message: "Media path is not valid." },
          404,
        );
      }
      const candidate = Bun.file(resolved);
      if (await candidate.exists()) {
        found = candidate;
        break;
      }
    }
    const file = found;
    if (!file) {
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

/**
 * Rebuild the request URL from `X-Forwarded-Proto` when a TLS-terminating
 * proxy is in front of us.
 *
 * Railway (and every similar host) terminates TLS at the edge and forwards
 * plain HTTP inwards, so `request.url` arrives as `http://…` even though the
 * browser asked for `https://…`. x402 copies that URL verbatim into
 * `resource.url` inside the 402 payload, and a browser client compares it
 * against the URL it actually requested. The schemes disagree, the client
 * refuses before it ever asks the wallet to sign, and the UI reports a
 * generic "unlock failed" — a config artefact that reads like a payment bug.
 *
 * Only trust the header when it says https: downgrading on an attacker-set
 * header would be a way to make us mint requirements for the wrong resource.
 */
export function forwardedProtoFetch(handler: (req: Request) => Response | Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    let req = request;
    if (request.headers.get("x-forwarded-proto") === "https") {
      const url = new URL(request.url);
      if (url.protocol !== "https:") {
        url.protocol = "https:";
        req = new Request(url.toString(), request);
      }
    }

    try {
      return await handler(req);
    } catch (error) {
      // An error that escapes Hono never passes through the CORS middleware,
      // so the runtime answers with a bare 500 and the browser reports it as
      // a CORS failure. That is how a crash on the settle path came to look
      // like a cross-origin misconfiguration. Answer with CORS headers so the
      // real message reaches the client, and log it server-side.
      console.error("[fatal] unhandled error escaped the app:", error);
      return new Response(
        JSON.stringify({
          error: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "PAYMENT-REQUIRED,PAYMENT-RESPONSE",
          },
        },
      );
    }
  };
}

/**
 * How often the payout worker looks for newly delivered unlocks. Creators are
 * paid within a minute of a sale without the buyer ever waiting on a transfer.
 */
const PAYOUT_INTERVAL_MS = 60_000;

/**
 * Starts the creator payout worker when a treasury key is configured.
 *
 * Opt-in by env: with no key the API runs exactly as before and payouts simply
 * accrue in the table, which is what keeps local development and tests from
 * needing a funded wallet.
 *
 * Running in-process is a deliberate trade the operator made. It means the
 * server holds a hot wallet that controls all revenue, so a compromised
 * backend can drain the treasury — the settler is kept deliberately weaker
 * than this for exactly that reason. It buys automatic payouts on a host that
 * runs one process. Moving this to its own service costs nothing but a second
 * start command, and is the first thing to do if this stops being a testnet.
 */
function startPayoutWorker(db: ReturnType<typeof openDb>): void {
  const treasuryPrivateKey = process.env.TREASURY_PRIVATE_KEY as `0x${string}` | undefined;
  const payTo = process.env.PAY_TO_ADDRESS;
  if (!treasuryPrivateKey || !payTo) {
    console.log("[payouts] no TREASURY_PRIVATE_KEY/PAY_TO_ADDRESS — creator payouts will accrue unpaid");
    return;
  }

  const chain = createPayoutChain({
    treasuryPrivateKey,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
  });

  const tick = async () => {
    try {
      await runPayouts({ db, chain, payTo });
    } catch (error) {
      // Never let a payout failure take the API down with it: the buyer's
      // path does not depend on this, and a row left owed is recoverable.
      console.error("[payouts] run failed:", error);
    }
  };

  void tick();
  setInterval(() => void tick(), PAYOUT_INTERVAL_MS).unref();
}

if (import.meta.main) {
  const db = openDb();
  const app = createApp({ db });
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  Bun.serve({ port, fetch: forwardedProtoFetch(app.fetch) });
  console.log(`Promit API listening on http://localhost:${port}`);
  startPayoutWorker(db);
}
