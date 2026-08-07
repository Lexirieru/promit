"use client";

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import Nav from "@/components/Nav";
import CategoryFilter from "@/components/CategoryFilter";
import PromptCard from "@/components/PromptCard";
import { fetchCatalog, type Category, type PublicCatalogEntry } from "@/lib/api";

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

  const visible =
    load.phase === "ready"
      ? category === null
        ? load.entries
        : load.entries.filter((e) => e.category === category)
      : [];

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
              {category === null
                ? "The catalog is empty"
                : `No prompts in ${category} yet`}
            </p>
            <p className="mb-5 text-sm text-gray-600">
              {category === null
                ? "Nothing has been listed yet. Check back soon."
                : "Nobody has listed a prompt in this category so far."}
            </p>
            {category !== null && (
              <button
                type="button"
                onClick={() => setCategory(null)}
                className="rounded-full border border-gray-300 px-5 py-2.5 text-sm font-medium text-black transition-colors hover:border-black focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                Show all categories
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
