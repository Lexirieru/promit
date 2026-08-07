import { describe, expect, test } from "bun:test";

import { renderBanner, shouldShowBanner } from "../src/banner";

describe("banner", () => {
  test("renders gradient figlet art on an interactive stdout with colours enabled", () => {
    const banner = renderBanner({ isTTY: true, env: {} });
    expect(banner).toContain("█");
    expect(banner).toContain("pay-per-prompt marketplace");
  });

  test("is suppressed entirely when stdout is not a TTY", () => {
    expect(shouldShowBanner({ isTTY: false, env: {} })).toBe(false);
    expect(renderBanner({ isTTY: false, env: {} })).toBe("");
  });

  test("is suppressed when NO_COLOR is set, even on a TTY", () => {
    expect(shouldShowBanner({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(renderBanner({ isTTY: true, env: { NO_COLOR: "1" } })).toBe("");
  });

  test("NO_COLOR counts by presence, not value (https://no-color.org)", () => {
    expect(renderBanner({ isTTY: true, env: { NO_COLOR: "" } })).toBe("");
  });
});
