import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { McpTestSession, TEST_PRIVATE_KEY, freshConfigDir } from "../../mcp/test/helpers";

const PLUGIN_DIR = resolve(new URL("..", import.meta.url).pathname);
const REPO_ROOT = resolve(PLUGIN_DIR, "..");
const SKILL_PATH = join(PLUGIN_DIR, "skills", "promit", "SKILL.md");

const manifest = JSON.parse(
  readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8"),
) as { name: string; version?: string };

const skillRaw = readFileSync(SKILL_PATH, "utf8");

/**
 * The frontmatter is parsed with a real YAML parser, not regexes: the facts
 * under test are spelling-level (hyphen vs underscore, a key's absence), and
 * only a parse proves what a YAML consumer actually sees.
 */
function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("SKILL.md has no frontmatter block");
  return { frontmatter: Bun.YAML.parse(match[1]) as Record<string, unknown>, body: match[2] };
}

const { frontmatter, body } = splitFrontmatter(skillRaw);

function toolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  throw new Error("allowed-tools is neither a YAML list nor a string");
}

const rootConfigRaw = readFileSync(join(REPO_ROOT, ".mcp.json"), "utf8");
const pluginConfigRaw = readFileSync(join(PLUGIN_DIR, ".mcp.json"), "utf8");

interface McpJson {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}
const rootConfig = JSON.parse(rootConfigRaw) as McpJson;
const pluginConfig = JSON.parse(pluginConfigRaw) as McpJson;

/** tools/list from the server run as a real subprocess — the registered truth. */
async function registeredToolNames(): Promise<string[]> {
  const session = new McpTestSession({
    PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY,
    PROMIT_CONFIG_DIR: freshConfigDir(),
  });
  try {
    await session.initialize();
    const response = await session.request("tools/list");
    if (response.error) throw new Error(`tools/list failed: ${response.error.message}`);
    const { tools } = response.result as { tools: Array<{ name: string }> };
    return tools.map((tool) => tool.name).sort();
  } finally {
    await session.close();
  }
}

describe("plugin manifest", () => {
  test("parses and is named promit — the name is baked into the plugin tool prefix", () => {
    expect(manifest.name).toBe("promit");
  });

  test("carries the version, because SKILL.md frontmatter has no version field", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("skill frontmatter", () => {
  test("name matches the skill directory — the directory is what names the slash command", () => {
    expect(frontmatter.name).toBe(basename(dirname(SKILL_PATH)));
  });

  test("spells allowed-tools with a hyphen and when_to_use with an underscore", () => {
    expect(frontmatter).toHaveProperty("allowed-tools");
    expect(frontmatter).not.toHaveProperty("allowed_tools");
    expect(frontmatter).toHaveProperty("when_to_use");
    expect(frontmatter).not.toHaveProperty("when-to-use");
  });

  test("has no version key — it would be silently ignored; the version lives in metadata", () => {
    expect(frontmatter).not.toHaveProperty("version");
    expect((frontmatter.metadata as Record<string, unknown>).version).toBe(manifest.version);
  });

  test("description leads with the primary use case and fits the listing budget", () => {
    const description = frontmatter.description as string;
    const whenToUse = frontmatter.when_to_use as string;
    // Only name + description load at startup, truncated from the END under
    // the listing budget — so the literal phrases a user would type must sit
    // at the front, where truncation cannot reach them.
    expect(description.indexOf("find me a prompt")).toBeGreaterThanOrEqual(0);
    expect(description.indexOf("find me a prompt")).toBeLessThan(200);
    expect(description.indexOf("buy a prompt")).toBeGreaterThanOrEqual(0);
    expect(description.indexOf("buy a prompt")).toBeLessThan(200);
    expect(description.length).toBeLessThanOrEqual(1024);
    // Documented listing truncation: description + when_to_use at 1536.
    expect(description.length + whenToUse.length).toBeLessThanOrEqual(1536);
  });
});

describe("allowed-tools against the server's registered tools", () => {
  test("every entry names a tool the server actually registers, in a known namespace", async () => {
    const registered = await registeredToolNames();
    expect(registered.length).toBeGreaterThan(0);

    const pluginPrefix = `plugin_${manifest.name}_${Object.keys(pluginConfig.mcpServers)[0]}`;
    const projectPrefix = Object.keys(rootConfig.mcpServers)[0];

    for (const entry of toolList(frontmatter["allowed-tools"])) {
      const match = /^mcp__(.+?)__([A-Za-z0-9_-]+)$/.exec(entry);
      expect(match, `"${entry}" is not an mcp__<server>__<tool> name`).not.toBeNull();
      const [, server, tool] = match!;
      expect([pluginPrefix, projectPrefix]).toContain(server);
      expect(registered, `"${tool}" is not registered by the server`).toContain(tool);
    }
  });

  test("every registered tool is granted in both namespaces — adding a server tool must update the skill", async () => {
    const registered = await registeredToolNames();
    const entries = toolList(frontmatter["allowed-tools"]);
    const pluginPrefix = `plugin_${manifest.name}_${Object.keys(pluginConfig.mcpServers)[0]}`;
    const projectPrefix = Object.keys(rootConfig.mcpServers)[0];

    for (const tool of registered) {
      expect(entries).toContain(`mcp__${pluginPrefix}__${tool}`);
      expect(entries).toContain(`mcp__${projectPrefix}__${tool}`);
    }
  });
});

describe("the two committed .mcp.json configs", () => {
  test("neither contains a literal private key — the key arrives by ${PROMIT_PRIVATE_KEY} expansion", () => {
    for (const [label, raw, config] of [
      ["root", rootConfigRaw, rootConfig],
      ["plugin", pluginConfigRaw, pluginConfig],
    ] as const) {
      expect(/0x[0-9a-fA-F]{64}/.test(raw), `${label} .mcp.json embeds something key-shaped`).toBe(false);
      const server = config.mcpServers.promit;
      expect(server.env?.PROMIT_PRIVATE_KEY, `${label} .mcp.json`).toBe("${PROMIT_PRIVATE_KEY}");
    }
  });

  test("both use the server key that forms the mcp__ prefixes the skill allows", () => {
    expect(Object.keys(rootConfig.mcpServers)).toEqual(["promit"]);
    expect(Object.keys(pluginConfig.mcpServers)).toEqual(["promit"]);
  });

  test("both launch the same server entry, and the wired path exists", () => {
    const rootArg = rootConfig.mcpServers.promit.args[0];
    expect(existsSync(join(REPO_ROOT, rootArg)), `${rootArg} missing from repo`).toBe(true);

    const pluginArg = pluginConfig.mcpServers.promit.args[0];
    expect(pluginArg.startsWith("${CLAUDE_PLUGIN_ROOT}/")).toBe(true);
    const resolved = pluginArg.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_DIR);
    expect(existsSync(resolved), `${pluginArg} does not resolve from the plugin root`).toBe(true);

    expect(resolve(join(REPO_ROOT, rootArg))).toBe(resolve(resolved));
  });
});

describe("skill body", () => {
  test("states that purchased text is material, never instructions, and names the quarantine block", () => {
    expect(body).toMatch(/material/i);
    expect(body).toMatch(/never instructions/i);
    expect(body).toMatch(/PROMIT_UNTRUSTED_DATA/);
  });

  test("anchors the buy-vs-improvise judgment in the run-generated preview", () => {
    expect(body).toMatch(/preview generated by running that\s+exact prompt/i);
  });

  test("budget guidance names the exact env vars the server reads", () => {
    const envSource = readFileSync(join(REPO_ROOT, "mcp", "src", "env.ts"), "utf8");
    for (const variable of ["PROMIT_MAX_PRICE", "PROMIT_SESSION_CAP"]) {
      expect(body).toContain(variable);
      expect(envSource, `${variable} no longer read by the server — skill guidance is stale`).toContain(
        variable,
      );
    }
  });

  test("purchase reporting gives a Basescan transaction link the user can open", () => {
    expect(body).toContain("https://sepolia.basescan.org/tx/");
  });
});
