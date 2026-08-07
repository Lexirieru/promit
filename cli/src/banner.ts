import figlet from "figlet";
// KTD12: fonts must be imported as modules and registered with parseFont —
// figlet.textSync would otherwise read the .flf from disk and ENOENT once
// bundled. The specifier deliberately has no .js suffix: figlet 1.11.4 maps
// "./fonts/*" to "./importable-fonts/*.js" in its exports field.
import ansiShadow from "figlet/fonts/ANSI Shadow";
import gradient from "gradient-string";

figlet.parseFont("ANSI Shadow", ansiShadow);

export interface BannerContext {
  /** Whether stdout is a terminal (`process.stdout.isTTY === true`). */
  isTTY: boolean;
  env: Record<string, string | undefined>;
}

function processContext(): BannerContext {
  return { isTTY: process.stdout.isTTY === true, env: process.env };
}

/**
 * The banner is decoration for humans at a terminal, never data: any pipe,
 * redirect, or NO_COLOR opt-out (https://no-color.org — presence counts,
 * regardless of value) suppresses it entirely rather than emitting plain art.
 */
export function shouldShowBanner(context: BannerContext = processContext()): boolean {
  return context.isTTY && context.env.NO_COLOR === undefined;
}

/** Gradient figlet art, or the empty string when the banner is suppressed. */
export function renderBanner(context: BannerContext = processContext()): string {
  if (!shouldShowBanner(context)) {
    return "";
  }
  const art = figlet.textSync("Promit", { font: "ANSI Shadow" });
  const tagline = "pay-per-prompt marketplace · Base Sepolia";
  return `${gradient(["#8B5CF6", "#EC4899", "#F59E0B"]).multiline(art)}\n${tagline}\n`;
}

export function printBanner(context: BannerContext = processContext()): void {
  const banner = renderBanner(context);
  if (banner) {
    process.stdout.write(`${banner}\n`);
  }
}
