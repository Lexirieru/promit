"use client";

import { CATEGORIES, type Category } from "@/lib/api";

/**
 * Pill-style category filter. Renders the full canonical category list —
 * including categories that currently have no entries, which is what makes
 * the gallery's empty state reachable. Selection state is exposed through
 * `aria-pressed` so assistive tech hears which pill is active.
 */
export default function CategoryFilter({
  selected,
  onSelect,
}: {
  /** null = no filter (show everything). */
  selected: Category | null;
  onSelect: (category: Category | null) => void;
}) {
  const pill = (active: boolean) =>
    `rounded-full border px-4 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none ${
      active
        ? "border-black bg-black text-white"
        : "border-gray-300 bg-white text-gray-700 hover:border-black hover:text-black"
    }`;

  return (
    <div role="group" aria-label="Filter prompts by category" className="flex flex-wrap gap-2">
      <button
        type="button"
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
        className={pill(selected === null)}
      >
        All
      </button>
      {CATEGORIES.map((category) => (
        <button
          key={category}
          type="button"
          aria-pressed={selected === category}
          onClick={() => onSelect(selected === category ? null : category)}
          className={pill(selected === category)}
        >
          {category}
        </button>
      ))}
    </div>
  );
}
