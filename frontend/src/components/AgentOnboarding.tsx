"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Agent onboarding: the landing section where a visitor with an agent
 * copies ONE block and is wired into the marketplace. Every command here
 * is taken from the repo and was run before being written down — the
 * plugin path from plugin/README.md, the MCP shape from the root
 * .mcp.json, the CLI entry straight off the checkout. Nothing invented:
 * the backend is not deployed, so every surface points at
 * http://localhost:3001, and `npx promit` is only ever mentioned as
 * not-yet-published (the test suite enforces both).
 *
 * Tabs follow the WAI-ARIA tabs pattern: roving tabindex, arrow-key
 * navigation with selection following focus, labelled panels. The copy
 * control mirrors CopyPromptButton's named states + aria-live region so
 * confirmation behaves the same everywhere on the site.
 */

const REPO = "https://github.com/Lexirieru/promit.git";

export type OnboardingTarget = {
  id: string;
  label: string;
  intro: string;
  snippet: string;
  note: string;
};

export const ONBOARDING_TARGETS: OnboardingTarget[] = [
  {
    id: "claude-plugin",
    label: "Claude Code · Plugin",
    intro:
      "The smoothest path: one install wires the MCP server and the skill that knows when buying beats improvising.",
    snippet: `# Clone once — the plugin runs from the repo checkout
git clone ${REPO} && cd promit
bun install

# Agent wallet key: fund it with Base Sepolia USDC (faucet.circle.com).
# No ETH needed — the buyer signs, the facilitator pays gas.
export PROMIT_PRIVATE_KEY=0x...

# The hosted API isn't deployed yet — serve it locally on :3001
bun backend/src/index.ts &

# Launch Claude Code with the skill + MCP server in one install
claude --plugin-dir ./plugin`,
    note: "Inside the session the agent gets promit_search, promit_preview, promit_buy — plus the skill that reads a preview before paying.",
  },
  {
    id: "claude-mcp",
    label: "Claude Code · MCP",
    intro:
      "No plugin, just the tools: register the stdio server with claude mcp add.",
    snippet: `# The server needs the repo's workspace deps, so clone first
git clone ${REPO} && cd promit
bun install

# The hosted API isn't deployed yet — serve it locally on :3001
bun backend/src/index.ts &

# Key = a wallet holding Base Sepolia USDC — no ETH needed
claude mcp add promit --env PROMIT_PRIVATE_KEY=0x... -- bun "$(pwd)/mcp/src/server.ts"`,
    note: "The absolute path from $(pwd) lets the server start no matter where Claude Code runs later.",
  },
  {
    id: "mcp-json",
    label: "Cursor · Windsurf · Cline",
    intro:
      "Any MCP-speaking agent — Cursor, Windsurf, Cline, OpenClaw/Hermes — takes the same stdio server. Paste this into its MCP config.",
    snippet: `{
  "mcpServers": {
    "promit": {
      "command": "bun",
      "args": ["/absolute/path/to/promit/mcp/src/server.ts"],
      "env": {
        "PROMIT_PRIVATE_KEY": "0x<wallet holding Base Sepolia USDC, no ETH needed>",
        "PROMIT_API_URL": "http://localhost:3001"
      }
    }
  }
}`,
    note: "Clone the repo and run bun install first, then point args at your checkout. Config file names and locations differ per editor — check your editor's MCP documentation; most accept this mcpServers shape.",
  },
  {
    id: "cli",
    label: "CLI",
    intro:
      "The terminal surface: search, preview, buy, and verify against the on-chain registry.",
    snippet: `git clone ${REPO} && cd promit
bun install

# Agent wallet key: Base Sepolia USDC only — no ETH needed
export PROMIT_PRIVATE_KEY=0x...

# The hosted API isn't deployed yet — serve it locally on :3001
bun backend/src/index.ts &

# Run straight from the checkout
bun cli/src/cli.ts search "landing page"
bun cli/src/cli.ts preview email-landing-page
bun cli/src/cli.ts buy email-landing-page --yes`,
    note: "Not published to npm yet — npx promit arrives once it is. Today the checkout is the install.",
  },
];

type CopyState = "idle" | "copied" | "error";

const RESET_MS = 2500;

function CopySnippetButton({ text, label }: { text: string; label: string }) {
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
    try {
      await navigator.clipboard.writeText(text);
      settle("copied");
    } catch {
      settle("error");
    }
  };

  const caption =
    state === "copied"
      ? "Copied!"
      : state === "error"
        ? "Copy failed — retry"
        : "Copy";

  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy the ${label} setup block`}
        className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 focus-visible:outline-none"
      >
        {state === "copied" ? (
          <Check aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <Copy aria-hidden className="h-3.5 w-3.5" />
        )}
        {caption}
      </button>
      {/* Announced to assistive tech; visually the button text already changed. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" && `${label} setup block copied to clipboard`}
        {state === "error" && `Copying the ${label} setup block failed`}
      </span>
    </>
  );
}

export default function AgentOnboarding() {
  const [activeId, setActiveId] = useState(ONBOARDING_TARGETS[0].id);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const active =
    ONBOARDING_TARGETS.find((t) => t.id === activeId) ?? ONBOARDING_TARGETS[0];

  // Selection follows focus (WAI-ARIA tabs, automatic activation).
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const count = ONBOARDING_TARGETS.length;
    const index = ONBOARDING_TARGETS.findIndex((t) => t.id === activeId);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % count;
        break;
      case "ArrowLeft":
        next = (index - 1 + count) % count;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = ONBOARDING_TARGETS[next];
    setActiveId(target.id);
    tabRefs.current[target.id]?.focus();
  };

  return (
    <section
      id="for-agents"
      className="relative z-20 mx-auto max-w-4xl px-4 py-16 sm:px-6 sm:py-24"
    >
      <p className="mb-3 text-xs font-medium tracking-widest text-gray-500 uppercase">
        For agents
      </p>
      <h2 className="mb-4 text-3xl leading-tight font-normal tracking-tight sm:text-4xl md:text-5xl">
        Wire your agent in one paste
      </h2>
      <p className="mb-3 max-w-2xl text-base text-gray-600 sm:text-lg">
        Why buy instead of improvising? A paid listing carries a preview
        generated by running that exact prompt — the buyer pays for proven
        output, not for text a model could invent in a second.
      </p>
      <p className="mb-8 max-w-2xl text-sm text-gray-500">
        The hosted backend is not deployed yet, so every setup below talks to
        a local API at http://localhost:3001. The wallet only needs Base
        Sepolia USDC — never ETH.
      </p>

      <div
        role="tablist"
        aria-label="Choose your agent"
        onKeyDown={onKeyDown}
        className="mb-6 flex flex-wrap gap-2"
      >
        {ONBOARDING_TARGETS.map((target) => {
          const selected = target.id === activeId;
          return (
            <button
              key={target.id}
              ref={(el) => {
                tabRefs.current[target.id] = el;
              }}
              type="button"
              role="tab"
              id={`agent-tab-${target.id}`}
              aria-selected={selected}
              aria-controls={`agent-panel-${target.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(target.id)}
              className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none ${
                selected
                  ? "border-black bg-black text-white"
                  : "border-gray-300 bg-white text-gray-700 hover:border-gray-500 hover:text-black"
              }`}
            >
              {target.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`agent-panel-${active.id}`}
        aria-labelledby={`agent-tab-${active.id}`}
      >
        <p className="mb-4 max-w-2xl text-sm text-gray-600">{active.intro}</p>

        <div className="overflow-hidden rounded-2xl bg-gray-950">
          <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-2.5">
            <span className="truncate text-xs text-gray-400">
              {active.label}
            </span>
            <CopySnippetButton text={active.snippet} label={active.label} />
          </div>
          <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-gray-100">
            <code>{active.snippet}</code>
          </pre>
        </div>

        <p className="mt-3 max-w-2xl text-xs text-gray-500">{active.note}</p>
      </div>
    </section>
  );
}
