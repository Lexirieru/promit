"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Sparkles } from "lucide-react";
import Nav from "@/components/Nav";
import MediaPreview from "@/components/MediaPreview";
import CopyPromptButton from "@/components/CopyPromptButton";
import UnlockButton from "@/components/UnlockButton";
import {
  ApiError,
  fetchCatalogEntry,
  formatUsdc,
  type PublicCatalogEntry,
} from "@/lib/api";

/**
 * Prompt detail. Named states (R27): pending skeleton, not-found for an
 * unknown id (a 404 from the catalog, not an error), error + retry for
 * everything else, and the loaded entry.
 *
 * The unlock control is U6's `UnlockButton` (wallet connect, x402 payment,
 * hash check). Free entries reuse the same copy control as the card.
 */

type LoadState =
  | { phase: "pending" }
  | { phase: "not-found" }
  | { phase: "error" }
  | { phase: "ready"; entry: PublicCatalogEntry };

export default function PromptDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  // The state remembers which id it belongs to, so navigating between two
  // detail pages derives back to pending instead of resetting state
  // synchronously inside the effect (react-hooks/set-state-in-effect).
  const [loaded, setLoaded] = useState<{ forId: string; state: LoadState } | null>(null);
  const load: LoadState =
    loaded?.forId === id ? loaded.state : { phase: "pending" };

  useEffect(() => {
    let cancelled = false;
    const settle = (state: LoadState) => {
      if (!cancelled) setLoaded({ forId: id, state });
    };
    fetchCatalogEntry(id)
      .then((entry) => settle({ phase: "ready", entry }))
      .catch((err) =>
        settle(
          err instanceof ApiError && err.status === 404
            ? { phase: "not-found" }
            : { phase: "error" },
        ),
      );
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="min-h-screen bg-white">
      <Nav />

      <main className="mx-auto max-w-5xl px-4 pt-8 pb-24 sm:px-6">
        <Link
          href="/prompts"
          className="mb-8 inline-flex items-center gap-1.5 rounded text-sm text-gray-600 transition-colors hover:text-black focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Back to gallery
        </Link>

        {load.phase === "pending" && (
          <div role="status" aria-label="Loading prompt">
            <div className="aspect-video animate-pulse rounded-2xl bg-gray-100" />
            <span className="sr-only">Loading prompt…</span>
          </div>
        )}

        {load.phase === "not-found" && (
          <div className="rounded-2xl border border-gray-200 px-6 py-20 text-center">
            <h1 className="mb-2 text-2xl font-normal tracking-tight">
              Prompt not found
            </h1>
            <p className="mb-6 text-sm text-gray-600">
              Nothing in the catalog answers to “{id}”. It may have been
              removed, or the link is wrong.
            </p>
            <Link
              href="/prompts"
              className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Browse the gallery
            </Link>
          </div>
        )}

        {load.phase === "error" && (
          <div role="alert" className="rounded-2xl border border-gray-200 px-6 py-20 text-center">
            <h1 className="mb-2 text-2xl font-normal tracking-tight">
              This prompt didn&apos;t load
            </h1>
            <p className="mb-6 text-sm text-gray-600">
              The Promit API isn&apos;t reachable right now. Try again in a
              moment.
            </p>
            <Link
              href="/prompts"
              className="rounded-full border border-gray-300 px-5 py-2.5 text-sm font-medium text-black transition-colors hover:border-black focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Back to gallery
            </Link>
          </div>
        )}

        {load.phase === "ready" && <PromptDetail entry={load.entry} />}
      </main>
    </div>
  );
}

function PromptDetail({ entry }: { entry: PublicCatalogEntry }) {
  const paid = entry.tier === "paid";

  return (
    <article className="grid gap-8 lg:grid-cols-[3fr_2fr]">
      <MediaPreview entry={entry} className="aspect-video rounded-2xl" />

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-gray-200 px-2.5 py-0.5 text-[11px] font-medium text-gray-600">
            {entry.category}
          </span>
          {paid ? (
            <span
              aria-label={`Price: ${formatUsdc(entry.priceAtomic)} in USDC`}
              className="rounded-full bg-black px-2.5 py-1 text-xs font-semibold text-white"
            >
              {formatUsdc(entry.priceAtomic)}
            </span>
          ) : (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
              Free
            </span>
          )}
        </div>

        <h1 className="text-3xl font-normal tracking-tight">{entry.title}</h1>

        {paid && (
          <p className="flex items-center gap-1.5 text-xs text-gray-500">
            <Sparkles aria-hidden className="h-3.5 w-3.5" />
            The preview you&apos;re watching was generated by running this
            exact prompt.
          </p>
        )}

        <p className="text-sm leading-relaxed text-gray-600">{entry.teaser}</p>

        <div className="mt-2">
          {paid ? (
            <UnlockButton entry={entry} />
          ) : (
            <CopyPromptButton promptId={entry.id} title={entry.title} />
          )}
        </div>

        <dl className="mt-4 flex flex-col gap-2 border-t border-gray-100 pt-4 text-xs text-gray-500">
          <div className="flex gap-2">
            <dt className="font-medium text-gray-600">Source</dt>
            <dd>{entry.attribution.source}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 font-medium text-gray-600">Note</dt>
            <dd>{entry.attribution.note}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-gray-600">Content hash</dt>
            <dd className="truncate font-mono" title={entry.contentHash}>
              {entry.contentHash}
            </dd>
          </div>
        </dl>
      </div>
    </article>
  );
}
