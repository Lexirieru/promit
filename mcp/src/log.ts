/**
 * Every log line goes to stderr (plan U12). stdout is the JSON-RPC channel:
 * one stray write there and the host's parser dies. Nothing in this package
 * may call console.log, process.stdout.write, or anything else that touches
 * stdout — this module is the only sanctioned way to say something.
 */
export function log(message: string): void {
  process.stderr.write(`[promit-mcp] ${message}\n`);
}

export function logError(context: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log(`${context}: ${detail}`);
}
