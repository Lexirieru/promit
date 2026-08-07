"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useSignTypedData, useSwitchChain } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  PenLine,
  ShieldCheck,
  Unlock,
} from "lucide-react";
import { PaymentRefusedError } from "@promit/x402-client";
import WalletButton from "@/components/WalletButton";
import { formatUsdc, type PublicCatalogEntry } from "@/lib/api";
import {
  SignatureRejectedError,
  UnlockFailedError,
  unlockPrompt,
  wagmiClientSigner,
  type UnlockedPrompt,
} from "@/lib/unlock";

/**
 * The paid unlock control (U6). Every state is named, and the two that the
 * design review called out get first-class homes:
 *
 * - The "this is a signature, not a transaction, and needs no gas" message
 *   is INLINE copy rendered in every pre-unlock state — visible before the
 *   wallet dialog opens, never a tooltip.
 * - `settling` is the named window between the wallet returning a signature
 *   and the verify+settle round trip answering; past a few seconds it says
 *   so instead of leaving an unexplained spinner.
 *
 * After unlock, the delivered text is checked against the content hash the
 * catalog advertised BEFORE purchase; a mismatch renders as a prominent
 * alert, never a silent acceptance.
 */

type Notice = { kind: "rejected" | "refused" | "failed"; message: string };

type Phase =
  | { name: "idle"; notice?: Notice }
  | { name: "signing" }
  | { name: "settling"; slow: boolean }
  | { name: "unlocked"; result: UnlockedPrompt };

/** After this long in `settling`, say explicitly that settling takes time. */
const SETTLE_SLOW_MS = 5000;
const COPY_RESET_MS = 2500;

const BASESCAN_TX_BASE = `${baseSepolia.blockExplorers.default.url}/tx`;

export default function UnlockButton({ entry }: { entry: PublicCatalogEntry }) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();

  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (slowTimer.current) clearTimeout(slowTimer.current);
    },
    [],
  );

  const price = formatUsdc(entry.priceAtomic);
  const wrongChain = isConnected && chainId !== baseSepolia.id;

  const unlock = async () => {
    if (!address) return;
    setPhase({ name: "signing" });
    try {
      const result = await unlockPrompt({
        promptId: entry.id,
        advertisedContentHash: entry.contentHash,
        priceAtomic: entry.priceAtomic,
        signer: wagmiClientSigner(address, (payload) =>
          // x402 hands loosely-typed EIP-712 payloads; wagmi wants its
          // generic-typed form of the same four fields.
          signTypedDataAsync(payload as unknown as Parameters<typeof signTypedDataAsync>[0]),
        ),
        onSigned: () => {
          setPhase({ name: "settling", slow: false });
          slowTimer.current = setTimeout(
            () =>
              setPhase((current) =>
                current.name === "settling" ? { ...current, slow: true } : current,
              ),
            SETTLE_SLOW_MS,
          );
        },
      });
      setPhase({ name: "unlocked", result });
    } catch (error) {
      if (error instanceof SignatureRejectedError) {
        setPhase({ name: "idle", notice: { kind: "rejected", message: error.message } });
      } else if (error instanceof PaymentRefusedError) {
        setPhase({ name: "idle", notice: { kind: "refused", message: error.message } });
      } else if (error instanceof UnlockFailedError) {
        setPhase({
          name: "idle",
          notice: {
            kind: "failed",
            message: `The unlock failed and the prompt stays locked: ${error.message}`,
          },
        });
      } else {
        setPhase({
          name: "idle",
          notice: {
            kind: "failed",
            message: "The unlock failed unexpectedly and the prompt stays locked. Try again.",
          },
        });
      }
    } finally {
      if (slowTimer.current) clearTimeout(slowTimer.current);
    }
  };

  if (phase.name === "unlocked") {
    return <UnlockedView entry={entry} result={phase.result} />;
  }

  const busy = phase.name === "signing" || phase.name === "settling";

  return (
    <div className="flex flex-col gap-2">
      {/* The product's actual argument, inline and ALWAYS visible before the
          wallet dialog opens (design review) — never only a tooltip. */}
      <p className="flex items-start gap-1.5 text-xs text-gray-600">
        <PenLine aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Unlocking asks your wallet for a <strong>signature</strong> on a USDC
          payment message — it is not a transaction, and it needs no gas.
        </span>
      </p>

      {!isConnected && (
        <p className="text-sm text-gray-600">
          Connect a browser wallet to unlock this prompt for {price}.
        </p>
      )}

      {/* Disconnected: the connect control IS the unlock control's next step.
          Connected: a compact address + disconnect row above the button. */}
      <WalletButton />

      {wrongChain && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-gray-600">
            Your wallet is on the wrong network — Promit pays on Base Sepolia
            only.
          </p>
          <button
            type="button"
            disabled={switching}
            onClick={() => switchChain({ chainId: baseSepolia.id })}
            className="inline-flex w-fit items-center gap-2 rounded-full bg-black px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-wait disabled:bg-gray-400"
          >
            {switching ? "Switching…" : "Switch to Base Sepolia"}
          </button>
        </div>
      )}

      {isConnected && !wrongChain && (
        <button
          type="button"
          disabled={busy}
          onClick={unlock}
          aria-label={`Unlock ${entry.title} for ${price} in USDC`}
          className="inline-flex w-fit items-center gap-2 rounded-full bg-black px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-wait disabled:bg-gray-500"
        >
          {busy ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          ) : (
            <Unlock aria-hidden className="h-4 w-4" />
          )}
          {phase.name === "signing" && "Waiting for your signature…"}
          {phase.name === "settling" && "Verifying & settling payment…"}
          {phase.name === "idle" && `Unlock for ${price}`}
        </button>
      )}

      {/* Named processing states, announced as they change. */}
      <div role="status" aria-live="polite" className="flex flex-col gap-1">
        {phase.name === "signing" && (
          <p className="text-xs text-gray-600">
            Check your wallet — approve the payment signature to continue.
          </p>
        )}
        {phase.name === "settling" && (
          <p className="text-xs text-gray-600">
            Signature received. The facilitator is verifying and settling your
            USDC payment on Base Sepolia…
          </p>
        )}
        {phase.name === "settling" && phase.slow && (
          <p className="text-xs text-gray-600">
            Still settling — this round trip can take a few more seconds. Keep
            this page open.
          </p>
        )}
      </div>

      {phase.name === "idle" && phase.notice && (
        <p
          role={phase.notice.kind === "rejected" ? "status" : "alert"}
          className={
            phase.notice.kind === "rejected"
              ? "text-xs text-gray-600"
              : "rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          }
        >
          {phase.notice.message}
        </p>
      )}
    </div>
  );
}

function UnlockedView({
  entry,
  result,
}: {
  entry: PublicCatalogEntry;
  result: UnlockedPrompt;
}) {
  const hashOk =
    result.hashCheck.ok &&
    (result.responseContentHash === "" || result.responseContentHash === entry.contentHash);

  return (
    <div className="flex flex-col gap-3" data-testid="unlocked">
      <p role="status" className="flex items-center gap-1.5 text-sm font-medium text-green-700">
        <Check aria-hidden className="h-4 w-4" />
        Unlocked — the full prompt is yours.
      </p>

      {hashOk ? (
        <p className="flex items-start gap-1.5 text-xs text-gray-600">
          <ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-700" />
          <span>
            Content hash verified: the delivered text matches the published
            hash{" "}
            <span className="font-mono break-all">{result.hashCheck.expectedHash}</span>.
          </span>
        </p>
      ) : (
        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-lg border-2 border-red-400 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <p className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle aria-hidden className="h-4 w-4" />
            Content hash MISMATCH
          </p>
          <p className="text-xs">
            The delivered text does not hash to the value published in the
            catalog. Treat this prompt as tampered with and do not rely on it.
          </p>
          <dl className="text-xs">
            <div className="flex gap-1">
              <dt className="shrink-0 font-medium">Published:</dt>
              <dd className="font-mono break-all">{result.hashCheck.expectedHash}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="shrink-0 font-medium">Delivered:</dt>
              <dd className="font-mono break-all">{result.hashCheck.actualHash}</dd>
            </div>
          </dl>
        </div>
      )}

      <pre className="max-h-96 overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs leading-relaxed whitespace-pre-wrap text-gray-800">
        {result.text}
      </pre>

      <div className="flex flex-wrap items-center gap-3">
        <CopyUnlockedText title={entry.title} text={result.text} />
        <a
          href={`${BASESCAN_TX_BASE}/${result.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 px-4 py-2 text-xs font-medium text-black transition-colors hover:border-black focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          View settlement on Basescan
        </a>
      </div>
    </div>
  );
}

/** Copies text that is already in memory — no refetch of the paid route. */
function CopyUnlockedText({ title, text }: { title: string; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("error");
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState("idle"), COPY_RESET_MS);
  };

  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy the unlocked prompt text of ${title}`}
        className="inline-flex items-center gap-1.5 rounded-full bg-black px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        {state === "copied" ? (
          <Check aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <Copy aria-hidden className="h-3.5 w-3.5" />
        )}
        {state === "copied" ? "Copied!" : state === "error" ? "Copy failed — retry" : "Copy prompt"}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" && `Prompt text of ${title} copied to clipboard`}
        {state === "error" && `Copying ${title} failed`}
      </span>
    </>
  );
}
