# Prom It

## The problem

Prompt libraries sell lifetime bundles. MotionSites charges over 300 dollars for its catalog, so a buyer who needs one prompt still pays for all of them.

That is arithmetic, not greed. Stripe takes about 30 cents plus 2.9 percent per transaction, which means processing a 5 cent sale costs six times the price of the good. Bundling is the only shape that clears the fee. Micropayments for digital goods died for cost reasons, not for lack of demand.

## What Prom It does

Prom It turns any prompt into a resource you can buy over HTTP for cents of USDC, using x402 on Base Sepolia. There is no account, no card, and no API key. A creator lists a prompt and sets its price. A buyer unlocks it and pays.

The part that matters more than the price is who else can buy. Once a prompt is purchasable over plain HTTP with no signup, an autonomous agent can buy one on its own initiative. Prom It ships four surfaces on one shared payment client: a browser app, a CLI, an MCP server, and a Claude Code plugin.

## The claim, and the receipt

Anyone can say their project uses x402. Here it is settled on chain:

[**https://sepolia.basescan.org/tx/0x7b62a3ae1bd835907f3f4b9541cf9b4b082c687c5267795178ad2e2c5aad6a85**](https://sepolia.basescan.org/tx/0x7b62a3ae1bd835907f3f4b9541cf9b4b082c687c5267795178ad2e2c5aad6a85)

Two fields in that receipt carry the whole argument. The signing payer holds **0 wei of ETH**. The `tx.from` that paid the gas is the facilitator's own address. Read together, they show a buyer paying USDC on chain without holding any ETH, because they signed an EIP-3009 authorization instead of sending a transaction.

That is why an agent wallet only needs stablecoin. There is nothing to provision and no one to ask.

## Verify it yourself


| What                 | Where                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live app             | [https://promit-two.vercel.app](https://promit-two.vercel.app)                                                                                                     |
| API                  | [https://promitbackend-production.up.railway.app/v1/catalog](https://promitbackend-production.up.railway.app/v1/catalog)                                           |
| PromitRegistry proxy | [https://sepolia.basescan.org/address/0x30c92fFadAd24Ca079227A92A33b78683D36Fde6](https://sepolia.basescan.org/address/0x30c92fFadAd24Ca079227A92A33b78683D36Fde6) |
| Implementation       | [https://sepolia.basescan.org/address/0xfdB083371f44cF53181350389d3217E51B431776](https://sepolia.basescan.org/address/0xfdB083371f44cF53181350389d3217E51B431776) |
| Repository           | [https://github.com/Lexirieru/promit](https://github.com/Lexirieru/promit)                                                                                         |


Both contracts are source verified. Role separation is readable on chain rather than asserted: the deployer holds neither the settler role nor the upgrader role, so a compromised backend can write false unlock records but cannot rewrite the contract.

The CLI talks to the deployed API with no configuration:

```
bun cli/src/cli.ts search hero
```

## Three properties that make unattended buying safe

**The spend cap pins denomination before amount.** A cap that only checks the number is defeated by an 18 decimal token whose amount looks small against a 6 decimal USDC threshold. The filter rejects any scheme, network, or asset that is not the pinned one, and only then compares the value.

**A per prompt cap is not a budget.** Two hundred purchases at 9.9 cents drain a wallet while every single one passes the check. A cumulative session cap persists to disk, so a restarted agent cannot reset its own budget.

**Purchased text is treated as untrusted data.** Anyone can list a prompt, an agent buys it unattended, and the text lands in a tool enabled session holding a private key. The buy tool returns bodies inside a nonce delimited block, and the nonce is generated after the seller's text exists so a seller cannot close the block from inside.

## The paywall

The competitor this project studied ships its entire prompt library inside the client bundle and enforces the paywall in the UI. Clicking copy fires no network request at all, because the text was already on the visitor's machine.

Prom It splits the catalog into a public face and a private body as separate types. A paid body placed in the git tracked catalog is a schema load error, not a leak waiting to be found. Prompt text travels through exactly one route, the payment gated one.

Buyers who return are not charged twice. Ownership is proved rather than claimed: the client signs a message bound to the prompt id taken from the request path, and the server recovers the address itself. A malformed or expired proof returns 401 and never falls through to charging.

## Why an agent would buy instead of writing its own

A paid listing carries a preview generated by running that exact prompt. The buyer is paying for verified output, not for text a model could improvise. That is the criterion the Claude Code skill reasons from.

## What is built

339 tests across seven packages: 22 contract, 126 backend, 43 payment client, 43 CLI, 26 MCP, 15 plugin, 64 frontend.

The contract suite includes a test that deliberately reorders storage and asserts the OpenZeppelin upgrade validator rejects it. It checks the reason string, so a broken environment fails loudly instead of appearing to pass.

## Limitations

Testnet only. Base Sepolia with faucet USDC, no real money path.

The upgrade authority can rewrite stored content hashes, so verification without trusting Prom It reduces to trusting that one key. It is held outside the backend and deploy environments. A multisig would be stronger.

The facilitator is a third party on the critical path of every purchase, is unversioned, and publishes no uptime guarantee. The URL is configurable so it can be swapped or self hosted.

## Attribution

Seed catalog entries are free tier prompts from motionsites.ai, labelled free with per entry attribution. MotionSites co hosts ChainHack 2026, and the main track asks how builders can resell prompts using x402. Prom It answers that as the resale layer rather than a competing storefront. Paid listings are original work.
---

# Progress During Hackathon

Everything in this repository was built during the hackathon. The initial commit and all 130 commits after it carry the same date, and the git history is public if you want to check.

## What was built

**Smart contract.** PromitRegistry, a UUPS upgradeable registry that records listings and unlock receipts, with the settler role separated from the upgrade authority. Deployed to Base Sepolia and source verified, along with its proxy. 22 tests, including one that deliberately reorders storage and asserts the OpenZeppelin upgrade validator rejects it.

**Payment path.** A Hono API on bun that answers 402 with x402 v2 payment requirements, verifies, settles, and returns the prompt with both a transaction hash and a content hash. The body is resolved and the unlock row written before settlement is invoked, so a buyer cannot be charged with no record. 126 tests.

**Shared payment client.** One package that every buying surface imports, so the spend caps cannot drift apart between them. 43 tests.

**Frontend.** A Next 16 app with the landing page, the gallery, prompt detail, wallet connection through Reown AppKit, the unlock flow, and a creator listing form that authenticates by wallet signature. 64 tests.

**Agent surfaces.** A CLI that bundles to zero runtime dependencies, an MCP server, and a Claude Code plugin that installs the skill and the server together. 84 tests across the three.

339 tests in total across seven packages.

## Things we got wrong first and had to fix

We record these because they shaped the result more than the features did.

**Two units built incompatible content hashes.** The catalog minted SHA-256 while the client and the contract used keccak256. Every package passed its own tests because each was internally consistent. The break only existed at the seam, which no unit owned. It surfaced when the branches were merged and the suites were re-run together. The fix was to standardise on keccak256 and add a cross package test that pins both implementations to the same digest.

**A returning buyer would have been charged twice.** The unlock table always knew who had bought what, but nothing exposed it. Closing that gap needed care: an address in a query string can be typed by anyone, so ownership had to be proved by signature rather than claimed. A malformed or expired proof now returns 401 instead of quietly falling through to charging.

**A spend cap that only checked the amount was not a cap.** It could be defeated by an 18 decimal token whose amount looked small against a 6 decimal USDC threshold, and separately by repetition, since two hundred purchases just under the limit drain a wallet while every one passes. The filter now pins scheme, network, and asset before comparing the number, and a cumulative session cap persists to disk.

**Purchased text was being treated as a payload to deliver.** Anyone can list a prompt, an agent buys it unattended, and the text lands in a session holding a private key. It is now returned inside a nonce delimited block, with the nonce generated after the seller's text exists so a seller cannot close the block from inside.

## Things the ecosystem got wrong that cost us time

**The facilitator URL printed in the official x402 v2 READMEs does not resolve.** It is NXDOMAIN. The working host is https://x402.org/facilitator.

**The MCP TypeScript SDK was replaced on 27 July 2026** by a nine package split at v2. Every MCP tutorial written before August 2026 targets an API that no longer exists.

**The facilitator mislabels a corrupted signature** as an insufficient balance error, returns HTTP 500 for an unknown scheme rather than a 4xx, and echoes an unverified payer address on failure responses. We found all three by running a spike against it before writing the payment route, which is the only reason the route was written against observed behaviour instead of documentation.

---

# Fundraising Status

Not raising. Prom It is self funded and has taken no external capital.

The build runs on free tiers and testnet: Base Sepolia with faucet USDC, the public x402 facilitator, Railway and Vercel. Total spend to date is the gas for one contract deployment, roughly 0.000024 ETH on a testnet.

If the project continues past the hackathon, the first costs would be a mainnet deployment, a CDP facilitator account for mainnet settlement, and media hosting as the catalog grows. None of those require outside funding at current scale.

The revenue mechanism is already built rather than planned: creators set a price per prompt, and the protocol takes a fee on unlock. What it has not done is prove demand. That is the honest gap, and no amount of funding would close it faster than putting the paid catalog in front of real buyers.
