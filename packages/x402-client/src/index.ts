export {
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_USDC,
  DEFAULT_PER_PROMPT_CAP_ATOMIC,
  DEFAULT_SESSION_CAP_ATOMIC,
  EXACT_SCHEME,
  USDC_DECIMALS,
  formatUsdc,
  usdcToAtomic,
} from "./constants";
export {
  ContentHashMismatchError,
  PaymentRefusedError,
  PerPromptCapExceededError,
  PolicyRefusalError,
  SessionCapExceededError,
  SpendLedgerCorruptError,
  type PolicyViolation,
  type PolicyViolationField,
} from "./errors";
export { SpendLedger, defaultConfigDir } from "./caps";
export {
  createPromitFetch,
  selectPaymentRequirement,
  type FetchLike,
  type PromitFetchHandle,
  type PromitFetchOptions,
  type SpendPolicy,
} from "./client";
export {
  assertContentHash,
  hashPromptText,
  normalizePromptText,
  verifyContentHash,
  type ContentHashCheck,
} from "./verify";

export type { BeforePaymentCreationHook, PaymentCreationContext } from "@x402/core/client";
export type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
export type { ClientEvmSigner } from "@x402/evm";
