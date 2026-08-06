import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MediaPreview from "@/components/MediaPreview";
import {
  freeVideoEntry,
  makeEntry,
  stubIntersectionObserver,
  stubMatchMedia,
  stubMediaElement,
} from "./helpers";

beforeEach(stubMediaElement);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("lazy loading", () => {
  it("attaches no clip src until the card scrolls into view", () => {
    const io = stubIntersectionObserver();
    stubMatchMedia(false);
    const { container } = render(
      <MediaPreview entry={freeVideoEntry} className="aspect-video" />,
    );

    const video = container.querySelector("video")!;
    // Off-screen: only the poster is referenced, the 1–8 MB clip is not.
    expect(video.getAttribute("src")).toBeNull();
    expect(video.getAttribute("poster")).toContain(freeVideoEntry.poster);
    expect(video.getAttribute("preload")).toBe("none");

    act(() => io.intersect());
    expect(video.getAttribute("src")).toContain(freeVideoEntry.media);
  });
});

describe("prefers-reduced-motion (extends U1's guard to media)", () => {
  it("holds the poster and offers a manual play control instead of autoplaying", () => {
    const io = stubIntersectionObserver();
    stubMatchMedia(true);
    const play = window.HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>;
    const { container } = render(
      <MediaPreview entry={freeVideoEntry} className="aspect-video" />,
    );
    act(() => io.intersect());

    expect(play).not.toHaveBeenCalled();
    const video = container.querySelector("video")!;
    expect(video.getAttribute("poster")).toContain(freeVideoEntry.poster);
    expect(video.hasAttribute("autoplay")).toBe(false);

    const manualPlay = screen.getByRole("button", {
      name: `Play preview of ${freeVideoEntry.title}`,
    });
    fireEvent.click(manualPlay);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("autoplays once in view when motion is not reduced", () => {
    const io = stubIntersectionObserver();
    stubMatchMedia(false);
    const play = window.HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>;
    render(<MediaPreview entry={freeVideoEntry} className="aspect-video" />);

    expect(play).not.toHaveBeenCalled();
    act(() => io.intersect());
    expect(play).toHaveBeenCalledTimes(1);
  });
});

describe("failure after the poster is up", () => {
  it("renders a named fallback with retry instead of an empty box", async () => {
    const io = stubIntersectionObserver();
    stubMatchMedia(false);
    const { container } = render(
      <MediaPreview entry={freeVideoEntry} className="aspect-video" />,
    );
    act(() => io.intersect());

    const video = container.querySelector("video")!;
    fireEvent.error(video);

    // Poster keeps holding the slot; the failure is named on top of it.
    expect(await screen.findByText("Preview didn't load")).toBeTruthy();
    const retry = screen.getByRole("button", { name: /Retry preview/ });

    // Retry arms a fresh attempt: a new video element with the clip src.
    fireEvent.click(retry);
    expect(screen.queryByText("Preview didn't load")).toBeNull();
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("shows a placeholder, never an empty box, when the mirror failed", () => {
    stubIntersectionObserver();
    stubMatchMedia(false);
    const entry = makeEntry({ media: null, poster: null, mediaStatus: "unavailable" });
    render(<MediaPreview entry={entry} className="aspect-video" />);
    expect(
      screen.getByRole("img", { name: `Preview for ${entry.title} is unavailable` }),
    ).toBeTruthy();
  });
});
