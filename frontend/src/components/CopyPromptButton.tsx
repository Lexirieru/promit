"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { fetchPromptText } from "@/lib/api";

/**
 * Copy control for FREE entries: fetches the full body from the unlock
 * route (free tier pays nothing, R3) and puts it on the clipboard.
 *
 * States are named (R27): idle → copying → copied / error, and the
 * outcome is announced through an `aria-live` status region so screen
 * reader users hear the confirmation the sighted user sees.
 */

type CopyState = "idle" | "copying" | "copied" | "error";

const RESET_MS = 2500;

export default function CopyPromptButton({
  promptId,
  title,
}: {
  promptId: string;
  title: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const settle = (next: CopyState) => {
    setState(next);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState("idle"), RESET_MS);
  };

  const copy = async () => {
    if (state === "copying") return;
    setState("copying");
    try {
      const text = await fetchPromptText(promptId);
      await navigator.clipboard.writeText(text);
      settle("copied");
    } catch {
      settle("error");
    }
  };

  const label =
    state === "copied"
      ? "Copied!"
      : state === "error"
        ? "Copy failed — retry"
        : state === "copying"
          ? "Copying…"
          : "Copy prompt";

  return (
    <>
      <button
        type="button"
        onClick={copy}
        disabled={state === "copying"}
        aria-label={`Copy the full prompt text of ${title}`}
        className="inline-flex items-center gap-1.5 rounded-full bg-black px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
      >
        {state === "copied" ? (
          <Check aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <Copy aria-hidden className="h-3.5 w-3.5" />
        )}
        {label}
      </button>
      {/* Announced to assistive tech; visually the button text already changed. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" && `Prompt text of ${title} copied to clipboard`}
        {state === "error" && `Copying ${title} failed`}
      </span>
    </>
  );
}
