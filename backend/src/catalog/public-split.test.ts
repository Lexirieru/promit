import { describe, expect, test } from "bun:test";
import { getFreePromptBody, listPublicEntries } from "./index.ts";
import type { CatalogFile, PublicCatalogEntry } from "./schema.ts";
import { CatalogFileEntrySchema, PublicCatalogEntrySchema } from "./schema.ts";

const SECRET = "TOP-SECRET-PROMPT-BODY-9f2a";

const fixtureCatalog: CatalogFile = {
  source: "motionsites.ai",
  capturedAt: "2026-08-06T19:05:20.629Z",
  generatedBy: "test-fixture",
  entries: [
    {
      id: "fixture-hero",
      title: "Fixture Hero",
      category: "Hero",
      teaser: "A fixture hero section.",
      media: "/media/fixture-hero.webp",
      mediaType: "image",
      mediaStatus: "mirrored",
      poster: null,
      priceAtomic: "0",
      tier: "free",
      contentHash: `keccak256:${"a".repeat(64)}`,
      attribution: {
        source: "motionsites.ai",
        capturedAt: "2026-08-06T19:05:20.629Z",
        note: "Seeded from the motionsites.ai free tier.",
      },
      body: `${SECRET} — the full prompt text lives here.`,
    },
  ],
};

// Compile-time half of the paywall split: the public type cannot even name
// a body field, so route code reaching for one fails `bun run typecheck`.
// @ts-expect-error — PublicCatalogEntry has no `body`
const _publicBodyIsATypeError = (entry: PublicCatalogEntry) => entry.body;

describe("public/private split", () => {
  test("the serialized public payload carries no prompt text", () => {
    const payload = JSON.stringify(listPublicEntries(fixtureCatalog));
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain('"body"');
    expect(payload).toContain('"teaser"');
  });

  test("parsing through the public schema strips a smuggled body key", () => {
    const parsed = PublicCatalogEntrySchema.parse(fixtureCatalog.entries[0]);
    expect(Object.keys(parsed)).not.toContain("body");
  });

  test("the private body is reachable only through the private lookup", () => {
    const body = getFreePromptBody(fixtureCatalog, "fixture-hero");
    expect(body?.body).toContain(SECRET);
    expect(getFreePromptBody(fixtureCatalog, "no-such-id")).toBeNull();
  });

  test("a paid body in the catalog file is a load-time error, not a leak", () => {
    const paidWithBody = {
      ...fixtureCatalog.entries[0],
      id: "paid-fixture",
      tier: "paid",
      priceAtomic: "50000",
    };
    expect(() => CatalogFileEntrySchema.parse(paidWithBody)).toThrow(
      /paid bodies must live in the SQLite store/,
    );
    const { body: _body, ...paidWithoutBody } = paidWithBody;
    expect(CatalogFileEntrySchema.parse(paidWithoutBody).tier).toBe("paid");
  });
});
