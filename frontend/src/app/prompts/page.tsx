"use client";

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import Nav from "@/components/Nav";
import CategoryFilter from "@/components/CategoryFilter";
import TierFilter from "@/components/TierFilter";
import PromptCard from "@/components/PromptCard";
import { fetchCatalog, type Category, type PublicCatalogEntry, type Tier } from "@/lib/api";

/**
 * The gallery. Fetches the full public catalog once and filters
 * client-side — 23 entries make a round-trip per pill pointless.
 *
 * Named states (R27):
 * - pending: skeleton grid + polite live announcement
 * - error:   message + retry (the backend may simply not be running)
 * - empty:   a selected category with no entries gets prose and a way
 *            back, never a silent blank grid
 * - ready:   the card grid
 */

type LoadState =
  | { phase: "pending" }
  | { phase: "error" }
  | { phase: "ready"; entries: PublicCatalogEntry[] };

export default function PromptsPage() {
  const [load, setLoad] = useState<LoadState>({ phase: "pending" });
  const [category, setCategory] = useState<Category | null>(null);
  const [tier, setTier] = useState<Tier | null>(null);
  // Bumped by the retry control; the effect refetches on every bump.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchCatalog()
      .then((entries) => {
        if (!cancelled) setLoad({ phase: "ready", entries });
      })
      .catch(() => {
        if (!cancelled) setLoad({ phase: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = () => {
    setLoad({ phase: "pending" });
    setAttempt((n) => n + 1);
  };

  // Category and tier compose: both null shows everything, either one narrows,
  // both narrow together. Filtering client-side keeps every pill instant — the
  // catalog is fetched once and is small enough that a round-trip per pill
  // would be slower and could fail where a local filter cannot.
  const visible =
    load.phase === "ready"
      ? load.entries.filter(
          (e) =>
            (category === null || e.category === category) &&
            (tier === null || e.tier === tier),
        )
      : [];

  const activeFilters = [category, tier === null ? null : tier === "free" ? "Free" : "Premium"]
    .filter(Boolean)
    .join(" + ");
  const clearAll = () => {
    setCategory(null);
    setTier(null);
  };

  return (
    <div className="min-h-screen bg-white">
      <Nav />

      <main className="mx-auto max-w-7xl px-4 pt-8 pb-24 sm:px-6">
        <header
          className="animate-fade-in-up mb-8"
          style={{ animationDelay: "0.1s", opacity: 0 }}
        >
          <h1 className="mb-2 text-3xl font-normal tracking-tight sm:text-4xl">
            Prompt gallery
          </h1>
          <p className="max-w-2xl text-sm text-gray-600 sm:text-base">
            Every preview below is real output. Free prompts copy straight to
            your clipboard; paid prompts unlock for cents of USDC over x402.
          </p>
        </header>

        <div
          className="animate-fade-in-up mb-8"
          style={{ animationDelay: "0.2s", opacity: 0 }}
        >
          <CategoryFilter selected={category} onSelect={setCategory} />
          <div className="mt-3">
            <TierFilter selected={tier} onSelect={setTier} />
          </div>
        </div>

        {load.phase === "pending" && (
          <div role="status" aria-label="Loading prompts" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                aria-hidden
                className="aspect-[4/3] animate-pulse rounded-2xl bg-gray-100"
              />
            ))}
            <span className="sr-only">Loading prompts…</span>
          </div>
        )}

        {load.phase === "error" && (
          <div role="alert" className="rounded-2xl border border-gray-200 px-6 py-16 text-center">
            <p className="mb-1 text-sm font-medium text-black">
              The catalog didn&apos;t load
            </p>
            <p className="mb-5 text-sm text-gray-600">
              The Prom It API isn&apos;t reachable right now. Check that the
              backend is running, then try again.
            </p>
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1.5 rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <RotateCcw aria-hidden className="h-4 w-4" />
              Retry
            </button>
          </div>
        )}

        {load.phase === "ready" && visible.length === 0 && (
          <div className="rounded-2xl border border-gray-200 px-6 py-16 text-center">
            <p className="mb-1 text-sm font-medium text-black">
              {activeFilters === ""
                ? "The catalog is empty"
                : `No prompts match ${activeFilters}`}
            </p>
            <p className="mb-5 text-sm text-gray-600">
              {activeFilters === ""
                ? "Nothing has been listed yet. Check back soon."
                : "Nobody has listed a prompt matching that combination so far."}
            </p>
            {activeFilters !== "" && (
              <button
                type="button"
                onClick={clearAll}
                className="rounded-full border border-gray-300 px-5 py-2.5 text-sm font-medium text-black transition-colors hover:border-black focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {load.phase === "ready" && visible.length > 0 && (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((entry) => (
              <PromptCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
