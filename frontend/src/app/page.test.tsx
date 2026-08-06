import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Home from "./page";

afterEach(cleanup);

describe("landing page branding", () => {
  it("renders the Promit wordmark and no occurrence of Stellar.ai", () => {
    const { container } = render(<Home />);
    expect(screen.getAllByText("Promit").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Stellar.ai");
    expect(container.textContent).not.toContain("Stellar");
  });

  it("carries the pay-per-prompt thesis in the headline", () => {
    render(<Home />);
    const headline = screen.getByRole("heading", { level: 1 });
    expect(headline.textContent).toContain("Pay per prompt");
  });
});

describe("landing page media", () => {
  it("loads no media from a host outside the app's own origin", () => {
    const { container } = render(<Home />);
    const urls = Array.from(
      container.querySelectorAll("video, source, img, audio"),
    )
      .flatMap((el) => [el.getAttribute("src"), el.getAttribute("poster")])
      .filter((url): url is string => Boolean(url));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      // Root-relative only: rejects absolute http(s) and protocol-relative //host.
      expect(url).toMatch(/^\/(?!\/)/);
    }
  });
});

describe("mobile menu", () => {
  it("toggles open and closed", () => {
    render(<Home />);
    expect(screen.queryByLabelText("Close menu")).toBeNull();
    expect(screen.getAllByText("Gallery")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("Open menu"));
    expect(screen.getByLabelText("Close menu")).toBeTruthy();
    expect(screen.getAllByText("Gallery")).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("Close menu"));
    expect(screen.queryByLabelText("Close menu")).toBeNull();
    expect(screen.getAllByText("Gallery")).toHaveLength(1);
  });
});
