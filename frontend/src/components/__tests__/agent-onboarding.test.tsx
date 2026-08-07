import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AgentOnboarding, {
  ONBOARDING_TARGETS,
} from "../AgentOnboarding";
import Home from "@/app/page";
import { stubClipboard } from "./helpers";

afterEach(cleanup);

/**
 * The one command (or config fragment) that proves the right block is on
 * screen for each target — taken from the repo, not invented:
 * plugin/README.md, the root .mcp.json, and the CLI entry point.
 */
const MARKERS: Record<string, string> = {
  "claude-plugin": "claude --plugin-dir ./plugin",
  "claude-mcp": "claude mcp add promit",
  "mcp-json": '"mcpServers"',
  cli: "bun cli/src/cli.ts",
};

describe("target honesty", () => {
  it("covers every marker and keeps ids in sync", () => {
    expect(ONBOARDING_TARGETS.map((t) => t.id).sort()).toEqual(
      Object.keys(MARKERS).sort(),
    );
  });

  it("never presents npx promit as a runnable command — it is not on npm", () => {
    for (const target of ONBOARDING_TARGETS) {
      expect(target.snippet).not.toContain("npx promit");
    }
  });

  it("tells every target the wallet needs Base Sepolia USDC and no ETH", () => {
    for (const target of ONBOARDING_TARGETS) {
      expect(target.snippet).toContain("Base Sepolia USDC");
      expect(target.snippet).toMatch(/no ETH/i);
    }
  });

  it("points at no invented host — only the deployed API, github, and the faucet", () => {
    for (const target of ONBOARDING_TARGETS) {
      const hosts =
        `${target.snippet}\n${target.note}`.match(/https?:\/\/[^\s"'`]+/g) ??
        [];
      for (const host of hosts) {
        expect(host).toMatch(
          /^(https:\/\/github\.com\/Lexirieru\/promit\.git|https:\/\/promitbackend-production\.up\.railway\.app|https:\/\/faucet\.circle\.com)/,
        );
      }
    }
  });
});

describe("tabs", () => {
  it("renders an accessible tablist and shows the plugin path first", () => {
    render(<AgentOnboarding />);
    const tablist = screen.getByRole("tablist", { name: "Choose your agent" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(ONBOARDING_TARGETS.length);

    // Roving tabindex: the selected tab is the only tab stop.
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(0);
    for (const tab of tabs.slice(1)) {
      expect(tab.getAttribute("aria-selected")).toBe("false");
      expect(tab.tabIndex).toBe(-1);
    }

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    expect(tabs[0].getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.textContent).toContain(MARKERS["claude-plugin"]);
    expect(tablist).toBeTruthy();
  });

  it("shows the matching snippet for every target when clicked", () => {
    render(<AgentOnboarding />);
    for (const target of ONBOARDING_TARGETS) {
      fireEvent.click(screen.getByRole("tab", { name: target.label }));
      const panel = screen.getByRole("tabpanel");
      expect(panel.textContent).toContain(MARKERS[target.id]);
      // The full snippet is on screen, not a truncation of it.
      expect(panel.textContent).toContain(target.snippet);
    }
  });

  it("moves selection with arrow keys, Home, and End — selection follows focus", () => {
    render(<AgentOnboarding />);
    const tabs = screen.getAllByRole("tab");

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getByRole("tabpanel").textContent).toContain(
      MARKERS[ONBOARDING_TARGETS[1].id],
    );

    fireEvent.keyDown(tabs[1], { key: "ArrowLeft" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[0]);

    // Arrows wrap at both ends.
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tabs[tabs.length - 1], { key: "Home" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[tabs.length - 1]);
  });
});

describe("copy button", () => {
  it("copies the ACTIVE tab's snippet and announces it via aria-live", async () => {
    const writeText = stubClipboard();
    render(<AgentOnboarding />);

    const cliTarget = ONBOARDING_TARGETS.find((t) => t.id === "cli")!;
    fireEvent.click(screen.getByRole("tab", { name: cliTarget.label }));
    fireEvent.click(
      screen.getByRole("button", {
        name: `Copy the ${cliTarget.label} setup block`,
      }),
    );

    expect(await screen.findByText("Copied!")).toBeTruthy();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(cliTarget.snippet);
    expect(screen.getByRole("status").textContent).toContain(
      `${cliTarget.label} setup block copied to clipboard`,
    );
  });

  it("names the failure and stays retryable when the clipboard refuses", async () => {
    const writeText = stubClipboard();
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<AgentOnboarding />);

    const button = screen.getByRole("button", {
      name: `Copy the ${ONBOARDING_TARGETS[0].label} setup block`,
    });
    fireEvent.click(button);
    expect(await screen.findByText("Copy failed — retry")).toBeTruthy();

    fireEvent.click(button);
    expect(await screen.findByText("Copied!")).toBeTruthy();
  });
});

describe("landing integration", () => {
  it("mounts the onboarding section and the why-buy sentence on the home page", () => {
    render(<Home />);
    expect(
      screen.getByRole("tablist", { name: "Choose your agent" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/running that exact prompt/i),
    ).toBeTruthy();
  });
});
