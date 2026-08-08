import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PromptsPage from "@/app/prompts/page";
import {
  freeImageEntry,
  freeVideoEntry,
  paidEntry,
  realCatalogEntries,
  stubCatalogFetch,
  stubIntersectionObserver,
  stubMatchMedia,
  stubMediaElement,
} from "./helpers";

// Hold posters everywhere in this suite: gallery behaviour, not playback,
// is under test, and reduced-motion keeps jsdom's media stubs quiet.
beforeEach(() => {
  stubMediaElement();
  stubIntersectionObserver();
  stubMatchMedia(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("gallery grid", () => {
  it("renders one card per catalog entry with title, category, and preview", async () => {
    const entries = realCatalogEntries();
    stubCatalogFetch(entries);
    render(<PromptsPage />);

    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(entries.length);
    for (const entry of entries) {
      const card = screen.getByRole("article", {
        name: `${entry.title} — ${entry.category}`,
      });
      // Every mirrored entry shows its preview media; videos are labelled
      // via aria-label, images via alt text.
      const preview =
        entry.mediaType === "video"
          ? card.querySelector("video")
          : card.querySelector("img");
      expect(preview, `${entry.id} preview`).not.toBeNull();
    }
  });

  it("shows the pending skeleton while the catalog loads", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<never>(() => {})),
    );
    render(<PromptsPage />);
    expect(screen.getByRole("status", { name: "Loading prompts" })).toBeTruthy();
  });

  it("shows an error state with retry when the catalog fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);
    render(<PromptsPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("didn't load");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("category filter", () => {
  const entries = [freeVideoEntry, freeImageEntry, paidEntry]; // Hero, Landing Page, Finance

  it("filters the grid on selection and restores the full set on clear", async () => {
    stubCatalogFetch(entries);
    render(<PromptsPage />);
    await screen.findAllByRole("article");

    fireEvent.click(screen.getByRole("button", { name: "Hero" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Test Prompt")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Hero" }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("article")).toHaveLength(entries.length);
  });

  it("shows an empty state, not a blank grid, for a category with no entries", async () => {
    stubCatalogFetch(entries); // nothing in Travel
    render(<PromptsPage />);
    await screen.findAllByRole("article");

    fireEvent.click(screen.getByRole("button", { name: "Travel" }));
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    // Copy names every active filter now that price composes with category,
    // so a reader with two pills on knows which one to relax.
    expect(screen.getByText("No prompts match Travel")).toBeTruthy();

    // The empty state offers the way back.
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("article")).toHaveLength(entries.length);
  });
});
