import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `PROMIT_UPLOADS_ROOT` moves creator uploads onto a persistent disk.
 *
 * Uploads are the only media written at runtime — seed media is committed and
 * returns with every build — so a container rebuild loses uploads alone. The
 * listing row survives in SQLite while its preview 404s, which reads like a
 * broken listing rather than missing storage. That is the bug these pin.
 *
 * The second test is the one that matters most: the upload root is DELIBERATELY
 * separate from `backend/media`. Mounting a volume over the committed media
 * directory would shadow every seed preview with an empty directory, trading
 * one dead preview for twenty-three.
 */

const created: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "promit-uploads-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.PROMIT_UPLOADS_ROOT;
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Imported fresh so the module-level root re-reads the current env. */
async function freshApp() {
  const suffix = Math.random().toString(36).slice(2);
  return (await import(`./index.ts?uploads-root=${suffix}`)).createApp();
}

describe("PROMIT_UPLOADS_ROOT", () => {
  test("serves an upload from the configured root", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "demo.mp4"), "video-bytes");
    process.env.PROMIT_UPLOADS_ROOT = root;

    const response = await (await freshApp()).request("/media/uploads/demo.mp4");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("video-bytes");
    // User-submitted bytes on the API origin — never let a browser sniff them.
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("committed seed media still serves when uploads live elsewhere", async () => {
    const root = await tempRoot();
    process.env.PROMIT_UPLOADS_ROOT = root;

    // A real committed entry: pointing uploads at an empty volume must not
    // shadow backend/media, which is exactly what mounting over it would do.
    const response = await (await freshApp()).request("/media/vex-ventures.mp4");

    expect(response.status).toBe(200);
  });

  test("a missing upload is a 404, not a fall-through to committed media", async () => {
    const root = await tempRoot();
    process.env.PROMIT_UPLOADS_ROOT = root;

    const response = await (await freshApp()).request("/media/uploads/gone.mp4");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "media_not_found" });
  });

  test("traversal out of the upload root is refused", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "secret.txt"), "nope");
    process.env.PROMIT_UPLOADS_ROOT = root;

    const response = await (await freshApp()).request("/media/uploads/../secret.txt");

    expect(response.status).toBe(404);
  });

  test("unset, uploads stay under the committed media directory", async () => {
    delete process.env.PROMIT_UPLOADS_ROOT;
    const { DEFAULT_LISTING_MEDIA_DIR } = await import(
      `./catalog/listing.ts?uploads-root=${Math.random().toString(36).slice(2)}`
    );

    expect(DEFAULT_LISTING_MEDIA_DIR.endsWith(join("backend", "media"))).toBe(true);
  });
});
