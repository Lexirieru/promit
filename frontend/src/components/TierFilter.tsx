"use client";

import { Lock, Sparkles } from "lucide-react";
import type { Tier } from "@/lib/api";

/**
 * Free / Premium filter for the gallery.
 *
 * Deliberately a SEPARATE control from {@link CategoryFilter} rather than
 * three more pills in that row: tier and category are orthogonal, and putting
 * them on one row would tell the eye they are mutually exclusive — picking
 * "Free" would look like it cleared "Hero". They compose instead, and the two
 * rows are what says so.
 *
 * "Premium" is the label; `paid` is the field. The catalog's own word is
 * `tier: "free" | "paid"`, but "Paid" next to "Free" reads like a warning,
 * and the price is already on every card. Keep the mapping in this one place.
 */
export default function TierFilter({
  selected,
  onSelect,
}: {
  /** null = both tiers. */
  selected: Tier | null;
  onSelect: (tier: Tier | null) => void;
}) {
  const pill = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none ${
      active
        ? "border-black bg-black text-white"
        : "border-gray-300 bg-white text-gray-700 hover:border-black hover:text-black"
    }`;

  return (
    <div role="group" aria-label="Filter prompts by price" className="flex flex-wrap gap-2">
      <button
        type="button"
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
        className={pill(selected === null)}
      >
        All prices
      </button>
      <button
        type="button"
        aria-pressed={selected === "free"}
        onClick={() => onSelect(selected === "free" ? null : "free")}
        className={pill(selected === "free")}
      >
        <Sparkles aria-hidden className="h-3.5 w-3.5" />
        Free
      </button>
      <button
        type="button"
        aria-pressed={selected === "paid"}
        onClick={() => onSelect(selected === "paid" ? null : "paid")}
        className={pill(selected === "paid")}
      >
        <Lock aria-hidden className="h-3.5 w-3.5" />
        Premium
      </button>
    </div>
  );
}
