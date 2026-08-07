# Promit plugin for Claude Code

One install that gives an agent both the tools and the judgment to use them:

- **MCP server** (`.mcp.json`) — the stdio server from `../mcp`, exposing
  `promit_search`, `promit_preview`, and `promit_buy`.
- **Skill** (`skills/promit/SKILL.md`) — the judgment layer the tools cannot
  carry: when buying beats improvising, how to read a preview before paying,
  how to respect budgets across sessions, and how to report a purchase in
  terms the user can check (tx hash + Basescan link).

## Install / load

The plugin runs **from the repo checkout** — the MCP server entry is
`${CLAUDE_PLUGIN_ROOT}/../mcp/src/server.ts` and needs the repo's workspace
dependencies, so a copied-out plugin cannot carry it alone.

```sh
bun install                      # once, at the repo root
export PROMIT_PRIVATE_KEY=0x…    # the agent wallet's key — never committed
claude --plugin-dir ./plugin
```

For local development without the plugin, the repo root's project-scoped
`.mcp.json` wires the same server directly (Claude Code asks for approval on
first use in the project).

## Tool names

The same three server tools surface under a different prefix depending on how
the server was wired — the skill's `allowed-tools` lists both on purpose:

| Wiring | Server name | Tool names |
|---|---|---|
| Plugin (`--plugin-dir ./plugin`) | `plugin:promit:promit` | `mcp__plugin_promit_promit__promit_*` |
| Project `.mcp.json` (repo root) | `promit` | `mcp__promit__promit_*` |

The skill's slash-command name comes from its **directory** (`skills/promit/`
→ listed as `promit:promit` from the plugin), not from the frontmatter
`name:` field.

## Environment

| Variable | Meaning |
|---|---|
| `PROMIT_PRIVATE_KEY` | Signing key, **required**. Both committed `.mcp.json` files reference it as `${PROMIT_PRIVATE_KEY}` (expanded by Claude Code); a missing/invalid key is a named startup error from the server. |
| `PROMIT_API_URL` | Backend base URL (default `http://localhost:3001`). |
| `PROMIT_MAX_PRICE` | Per-prompt cap in human USDC, e.g. `0.10`. |
| `PROMIT_SESSION_CAP` | Cumulative session cap in human USDC. Spend is ledgered on disk and shared with the CLI, so it survives restarts. |
| `PROMIT_CONFIG_DIR` | Moves the ledger/config dir (default `~/.config/promit`). |

## Tests

```sh
cd plugin && bun test
```

The suite checks what silently breaks discovery when wrong: the manifest and
frontmatter parse; `allowed-tools` (hyphen) and `when_to_use` (underscore)
spellings; no `version:` frontmatter key (ignored — the version lives in the
manifest and `metadata`); the description leads with the phrases a user would
type and fits the listing budget; every `allowed-tools` entry names a tool the
server **actually registers** (checked against `tools/list` over real stdio);
and neither committed `.mcp.json` contains a literal key.
