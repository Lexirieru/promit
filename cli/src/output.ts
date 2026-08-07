import pc from "picocolors";

/**
 * Prompt text goes to stdout so `promit buy … > prompt.txt` captures exactly
 * the purchased content; everything a human reads around it (status, receipts,
 * errors) goes to stderr. These helpers keep that split honest.
 */

export function emit(data: string): void {
  process.stdout.write(data.endsWith("\n") ? data : `${data}\n`);
}

export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function success(message: string): void {
  note(pc.green(`✓ ${message}`));
}

export function warn(message: string): void {
  note(pc.yellow(`! ${message}`));
}

/** Prints a named error to stderr and exits non-zero. Never returns. */
export function fail(message: string, hint?: string): never {
  note(pc.red(`error: ${message}`));
  if (hint) {
    note(pc.dim(hint));
  }
  process.exit(1);
}

export function stdinIsInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/** Reads stdin to completion; used by `verify` when no file is given. */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
