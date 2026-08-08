"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { useAccount } from "wagmi";
import Nav from "@/components/Nav";
import WalletButton from "@/components/WalletButton";
import ClaimButton from "@/components/ClaimButton";
import {
  fetchCreatorDashboard,
  formatUsdc,
  type CreatorDashboard,
} from "@/lib/api";

/**
 * The creator's side of the marketplace: what they listed, who bought it, and
 * what they have earned.
 *
 * Until now a creator could list a prompt and then learn nothing — sales were
 * only legible to whoever could read the database. Every number here is
 * already public on-chain, so the page needs a connected wallet to know WHOSE
 * dashboard to show, not as an authorisation.
 *
 * Named states, same as the gallery: connect, pending, error, empty, ready.
 */

type LoadState =
  | { phase: "pending" }
  | { phase: "error" }
  | { phase: "ready"; data: CreatorDashboard };

export default function EarningsPage() {
  const { address, isConnected } = useAccount();
  const [load, setLoad] = useState<LoadState>({ phase: "pending" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setLoad({ phase: "pending" });
    fetchCreatorDashboard(address)
      .then((data) => {
        if (!cancelled) setLoad({ phase: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setLoad({ phase: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [address, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <div className="min-h-screen bg-white">
      <Nav />

      <main className="mx-auto max-w-5xl px-4 pt-8 pb-24 sm:px-6">
        <header className="mb-8">
          <h1 className="mb-2 text-3xl font-normal tracking-tight sm:text-4xl">
            Your earnings
          </h1>
          <p className="max-w-2xl text-sm text-gray-600 sm:text-base">
            Every prompt you have listed, how many people bought it, and what it
            earned. Amounts settle in USDC on Base Sepolia.
          </p>
        </header>

        {!isConnected && (
          <div className="rounded-2xl border border-gray-200 px-6 py-16 text-center">
            <p className="mb-1 text-sm font-medium text-black">
              Connect a wallet to see your listings
            </p>
            <p className="mb-5 text-sm text-gray-600">
              Your wallet address is the creator identity, so there is nothing
              to log into. Nothing here is private, it just needs to know whose
              earnings to show.
            </p>
            <div className="flex justify-center">
              <WalletButton />
            </div>
          </div>
        )}

        {isConnected && load.phase === "pending" && (
          <div role="status" aria-label="Loading your earnings" className="space-y-4">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} aria-hidden className="h-24 animate-pulse rounded-2xl bg-gray-100" />
            ))}
            <span className="sr-only">Loading your earnings…</span>
          </div>
        )}

        {isConnected && load.phase === "error" && (
          <div role="alert" className="rounded-2xl border border-gray-200 px-6 py-16 text-center">
            <p className="mb-1 text-sm font-medium text-black">
              Your earnings didn&apos;t load
            </p>
            <p className="mb-5 text-sm text-gray-600">
              The Prom It API isn&apos;t reachable right now. Nothing is lost —
              try again in a moment.
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

        {isConnected && load.phase === "ready" && load.data.listings.length === 0 && (
          <div className="rounded-2xl border border-gray-200 px-6 py-16 text-center">
            <p className="mb-1 text-sm font-medium text-black">
              You haven&apos;t listed a prompt yet
            </p>
            <p className="mb-5 text-sm text-gray-600">
              List one and this page fills in as people buy it.
            </p>
            <Link
              href="/list"
              className="inline-block rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
            >
              List a prompt
            </Link>
          </div>
        )}

        {isConnected && load.phase === "ready" && load.data.listings.length > 0 && (
          <>
            {/* dl, because dt/dd are only valid inside one. */}
            <dl
              aria-label="Totals"
              className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4"
            >
              <Stat label="Prompts listed" value={String(load.data.totals.listings)} />
              <Stat label="Purchases" value={String(load.data.totals.sales)} />
              <Stat label="Earned" value={formatUsdc(load.data.totals.netAtomic)} />
              <Stat
                label="Unclaimed"
                value={formatUsdc(load.data.totals.claimableAtomic)}
                emphasis
              />
            </dl>

            <p className="mb-4 text-xs text-gray-500">
              Earned is what buyers paid minus the {load.data.feeLabel} protocol
              fee. Unclaimed is what has not reached your wallet yet.
            </p>

            <div className="overflow-x-auto rounded-2xl border border-gray-200">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-xs text-gray-600">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Prompt</th>
                    <th scope="col" className="px-4 py-3 font-medium">Price</th>
                    <th scope="col" className="px-4 py-3 font-medium">Buyers</th>
                    <th scope="col" className="px-4 py-3 font-medium">Purchases</th>
                    <th scope="col" className="px-4 py-3 font-medium">Earned</th>
                    <th scope="col" className="px-4 py-3 font-medium">Unclaimed</th>
                  </tr>
                </thead>
                <tbody>
                  {load.data.listings.map((listing) => (
                    <tr key={listing.id} className="border-b border-gray-100 last:border-0">
                      <th scope="row" className="px-4 py-3 font-medium text-black">
                        <Link href={`/prompts/${listing.id}`} className="hover:underline">
                          {listing.title}
                        </Link>
                      </th>
                      <td className="px-4 py-3 text-gray-600">
                        {formatUsdc(listing.priceAtomic)}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{listing.buyers}</td>
                      <td className="px-4 py-3 text-gray-600">{listing.sales}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {formatUsdc(listing.netAtomic)}
                      </td>
                      <td className="px-4 py-3 font-medium text-black">
                        {formatUsdc(listing.claimableAtomic)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* The claim reads its figure from the contract, not from the
                table above: the table is Prom It's accounting, the contract is
                what will actually pay. */}
            <div className="mt-6">
              <ClaimButton />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`rounded-2xl border px-4 py-4 ${emphasis ? "border-black" : "border-gray-200"}`}>
      <dt className="mb-1 text-xs text-gray-600">{label}</dt>
      <dd className="text-xl font-medium tracking-tight text-black">{value}</dd>
    </div>
  );
}
