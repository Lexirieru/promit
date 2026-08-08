import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PromptsPage from "@/app/prompts/page";
import {
  freeImageEntry,
  freeVideoEntry,
  makeEntry,
  paidEntry,
  stubCatalogFetch,
  stubIntersectionObserver,
  stubMatchMedia,
  stubMediaElement,
} from "./helpers";

/**
 * The Free / Premium filter.
 *
 * The behaviour worth pinning is not that a pill highlights — it is that tier
 * and category COMPOSE. They are orthogonal dimensions rendered as two rows,
 * and a reader who picks "Hero" then "Premium" expects both to apply. An
 * implementation that let the second selection clear the first would still
 * look correct in a screenshot.
 */

beforeEach(() => {
  stubMediaElement();
  stubIntersectionObserver();
  stubMatchMedia(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const clickPill = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

const titles = () =>
  screen.queryAllByRole("article").map((card) => card.getAttribute("aria-label") ?? "");

describe("tier filter", () => {
  it("shows both tiers until a price pill is picked", async () => {
    stubCatalogFetch([freeImageEntry, paidEntry]);
    render(<PromptsPage />);

    expect(await screen.findAllByRole("article")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "All prices" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("narrows to free entries", async () => {
    const free = freeImageEntry;
    stubCatalogFetch([free, paidEntry]);
    render(<PromptsPage />);
    await screen.findAllByRole("article");

    clickPill("Free");

    expect(titles()).toEqual([`${free.title} — ${free.category}`]);
  });

  it("narrows to premium entries", async () => {
    const paid = paidEntry;
    stubCatalogFetch([freeImageEntry, paid]);
    render(<PromptsPage />);
    await screen.findAllByRole("article");

    clickPill("Premium");

    expect(titles()).toEqual([`${paid.title} — ${paid.category}`]);
  });

  it("clicking the active pill again clears the filter", async () => {
    stubCatalogFetch([freeImageEntry, paidEntry]);
    render(<PromptsPage />);
    await screen.findAllByRole("article");

    clickPill("Premium");
    expect(screen.queryAllByRole("article")).toHaveLength(1);
    clickPill("Premium");

    expect(screen.queryAllByRole("article")).toHaveLength(2);
  });

  it("composes with the category filter instead of replacing it", async () => {
    // Two free entries in different categories plus one paid entry. Picking
    // the paid entry's category AND Premium must leave exactly it standing.
    const paid = paidEntry;
    const sameCategoryFree = makeEntry({ ...freeVideoEntry, id: "free-twin", category: paid.category });
    stubCatalogFetch([freeImageEntry, sameCategoryFree, paid]);
    render(<PromptsPage />);
    await screen.findAllByRole("article");

    clickPill(paid.category);
    expect(screen.queryAllByRole("article")).toHaveLength(2); // both in that category

    clickPill("Premium");

    expect(titles()).toEqual([`${paid.title} — ${paid.category}`]);
  });

  it("an impossible combination explains itself and offers a way out", async () => {
    const paid = paidEntry;
    const freeElsewhere = makeEntry({
      ...freeImageEntry,
      category: paid.category === "Hero" ? "Travel" : "Hero",
    });
    stubCatalogFetch([freeElsewhere, paid]);
    render(<PromptsPage />);
    await screen.findAllByRole("article");

    clickPill(freeElsewhere.category);
    clickPill("Premium");

    expect(screen.queryAllByRole("article")).toHaveLength(0);
    // Names both filters, so the reader knows which one to relax.
    const message = screen.getByText(/No prompts match/).textContent ?? "";
    expect(message).toContain(freeElsewhere.category);
    expect(message).toContain("Premium");

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.queryAllByRole("article")).toHaveLength(2);
  });
});
