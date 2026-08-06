"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ImageOff, Play, Pause, RotateCcw } from "lucide-react";
import { mediaUrl, type PublicCatalogEntry } from "@/lib/api";

/**
 * Inline preview for a catalog entry. Every state is named (R27):
 *
 * - `unavailable` — the mirror failed (`media: null`); static placeholder,
 *   never an empty box.
 * - `poster`      — video not started; the poster frame holds the slot.
 * - `loading`     — clip requested but not yet playing; poster stays up
 *   with a subtle indicator.
 * - `playing`     — the clip loops, muted and inline.
 * - `failed`      — the clip errored or stalled >{STALL_MS}ms after the
 *   poster showed; poster stays up with a "Preview unavailable" badge and
 *   a retry control.
 *
 * Videos are 1–8 MB, so the clip's `src` is only attached once the card
 * scrolls into view (IntersectionObserver). Under
 * `prefers-reduced-motion: reduce` nothing ever autoplays: the poster
 * holds and a manual play control appears (extends U1's guard to media).
 */

const STALL_MS = 10_000;

type VideoState = "poster" | "loading" | "playing" | "failed";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const mql = window.matchMedia?.(REDUCED_MOTION_QUERY);
  if (!mql?.addEventListener) return () => {};
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia?.(REDUCED_MOTION_QUERY)?.matches ?? false,
    () => false, // SSR: no preference known; the client snapshot corrects it
  );
}

/** True once the element has entered the viewport (sticky — we never unload). */
function useInView<T extends Element>(ref: React.RefObject<T | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // No IO (old browser / unmocked test DOM): degrade to eager, async so
      // hydration stays consistent and no setState lands inside the effect.
      const t = setTimeout(() => setInView(true), 0);
      return () => clearTimeout(t);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

function Unavailable({ title }: { title: string }) {
  return (
    <div
      role="img"
      aria-label={`Preview for ${title} is unavailable`}
      className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gray-100 text-gray-400"
    >
      <ImageOff aria-hidden className="h-6 w-6" />
      <span className="text-xs font-medium">Preview unavailable</span>
    </div>
  );
}

export default function MediaPreview({
  entry,
  className = "",
}: {
  entry: Pick<
    PublicCatalogEntry,
    "id" | "title" | "media" | "mediaType" | "mediaStatus" | "poster"
  >;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inView = useInView(containerRef);

  const [videoState, setVideoState] = useState<VideoState>("poster");
  const [imageFailed, setImageFailed] = useState(false);
  // Bumped by the retry control to force a fresh load after a failure.
  const [attempt, setAttempt] = useState(0);

  const clearStallTimer = useCallback(() => {
    if (stallTimer.current) {
      clearTimeout(stallTimer.current);
      stallTimer.current = null;
    }
  }, []);

  const armStallTimer = useCallback(() => {
    clearStallTimer();
    stallTimer.current = setTimeout(() => setVideoState("failed"), STALL_MS);
  }, [clearStallTimer]);

  useEffect(() => clearStallTimer, [clearStallTimer]);

  const startPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setVideoState("loading");
    armStallTimer();
    // play() rejections (power saving, autoplay policy) land in the failed
    // state instead of an unhandled promise — the poster is still up.
    video.play()?.catch(() => setVideoState("failed"));
  }, [armStallTimer]);

  const pausePlayback = useCallback(() => {
    videoRef.current?.pause();
    clearStallTimer();
    setVideoState("poster");
  }, [clearStallTimer]);

  // Autoplay path: only without reduced motion, only once in view.
  const wantsAutoplay = !reducedMotion && inView;
  useEffect(() => {
    if (!wantsAutoplay) return;
    if (videoState !== "poster") return;
    startPlayback();
    // videoState is deliberately read, not depended on: re-running on every
    // state change would restart a clip the user paused or that failed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsAutoplay, attempt, startPlayback]);

  if (
    entry.mediaStatus === "unavailable" ||
    entry.media === null ||
    (entry.mediaType === "image" && imageFailed)
  ) {
    return (
      <div ref={containerRef} className={`overflow-hidden bg-gray-100 ${className}`}>
        <Unavailable title={entry.title} />
      </div>
    );
  }

  if (entry.mediaType === "image") {
    return (
      <div ref={containerRef} className={`overflow-hidden bg-gray-100 ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- backend-served media, next/image needs a configured loader for cross-origin */}
        <img
          src={mediaUrl(entry.media)}
          alt={`Preview of ${entry.title}`}
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="h-full w-full object-cover"
        />
      </div>
    );
  }

  const poster = entry.poster ? mediaUrl(entry.poster) : undefined;
  const failed = videoState === "failed";
  const showManualPlay =
    !failed && videoState !== "playing" && (reducedMotion || videoState === "poster");

  return (
    <div
      ref={containerRef}
      className={`group/media relative overflow-hidden bg-gray-100 ${className}`}
    >
      <video
        key={attempt}
        ref={videoRef}
        // The clip only gets a src once in view — posters are a few KB,
        // clips are megabytes, and a 23-card grid must not fetch them all.
        src={inView ? mediaUrl(entry.media) : undefined}
        poster={poster}
        preload="none"
        muted
        loop
        playsInline
        aria-label={`Video preview of ${entry.title}`}
        onPlaying={() => {
          clearStallTimer();
          setVideoState("playing");
        }}
        onWaiting={armStallTimer}
        onStalled={armStallTimer}
        onError={() => {
          clearStallTimer();
          setVideoState("failed");
        }}
        className="h-full w-full object-cover"
      />

      {videoState === "loading" && (
        <span
          role="status"
          aria-label={`Loading preview of ${entry.title}`}
          className="absolute right-2 bottom-2 h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
        />
      )}

      {failed && (
        // The poster (or dark slot) stays behind this badge — never an empty box.
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-white"
        >
          <span className="text-xs font-medium">Preview didn&apos;t load</span>
          <button
            type="button"
            onClick={() => {
              setVideoState("poster");
              setAttempt((n) => n + 1);
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1.5 text-xs font-medium backdrop-blur-sm transition-colors hover:bg-white/30 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
          >
            <RotateCcw aria-hidden className="h-3 w-3" />
            Retry preview
          </button>
        </div>
      )}

      {showManualPlay && (
        <button
          type="button"
          onClick={startPlayback}
          aria-label={`Play preview of ${entry.title}`}
          className="absolute inset-0 flex items-center justify-center focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-inset focus-visible:outline-none"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-black shadow-sm backdrop-blur-sm transition-transform group-hover/media:scale-105">
            <Play aria-hidden className="ml-0.5 h-5 w-5 fill-black" />
          </span>
        </button>
      )}

      {videoState === "playing" && (
        <button
          type="button"
          onClick={pausePlayback}
          aria-label={`Pause preview of ${entry.title}`}
          className="absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/media:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
        >
          <Pause aria-hidden className="h-4 w-4 fill-white" />
        </button>
      )}
    </div>
  );
}
