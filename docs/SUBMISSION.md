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