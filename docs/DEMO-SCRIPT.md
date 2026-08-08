# Demo script

Spoken lines, slide by slide, matching the deck. Written for five minutes.
Cut marks show what to drop if you are held to three.

Read the bold lines out loud. The notes under them are for you, not the room.

---

## Slide 1 — Title

> **Hi, I am Axel, and this is Prom It. It sells prompts one at a time, for cents, and it settles on chain.**
>
> **I built it solo during this hackathon. Everything I am about to show is live on testnet, and I will run it in front of you.**

*Twenty seconds. Do not explain the architecture yet. Say who you are and that it works.*

---

## Slide 2 — The problem

> **Prompt libraries sell three hundred dollar lifetime bundles. That is not greed, it is arithmetic.**
>
> **A card charge costs thirty cents plus two point nine percent. On a five cent prompt, processing costs six times the price of the thing you are buying.**
>
> **So bundling is the only shape that clears the fee. Micropayments for digital goods did not die because nobody wanted them. They died on that number.**

*Let the 6x sit for a beat. It is the strongest thing on the slide.*

---

## Slide 3 — What it does

> **Prom It removes the fee floor. One HTTP request buys one prompt, paid in USDC over x402.**
>
> **No account, no card, no API key. And because there is no signup, a buyer does not have to be a person. An agent can buy one on its own.**
>
> **Four surfaces share one payment client: the web app, a CLI, an MCP server, and a Claude Code plugin. One client, so the spend caps cannot drift apart between them.**

*Cut for three minutes: drop the last sentence, keep "an agent can buy on its own".*

---

## Slide 4 — The receipt

> **Anyone can say they use x402. Here is a settled transaction.**
>
> **Look at two fields. The wallet that signed this payment held zero ETH. The address that paid the gas is the facilitator, not the buyer.**
>
> **The buyer signed an authorization instead of sending a transaction. That is why an agent wallet only needs stablecoin. There is nothing to top up and nobody to ask.**

*This is your strongest slide. Do not rush it. If a judge writes one thing down, it should be this.*

---

## Slide 5 — The creator side

> **x402 settles one transfer to one address, so a payment cannot be split between the creator and the protocol at the moment it settles.**
>
> **Something has to receive the whole amount and pass a share on. Doing that from a server means a key that can move all revenue sits next to the web app.**
>
> **So the contract holds it instead. The backend records who is owed what, and each creator withdraws their own balance and pays their own gas.**
>
> **The part I care about: the backend can point a credit at the wrong creator, but it can never credit more than actually arrived. Total credits are capped by the contract's own balance, so nothing can be paid out of thin air.**

*If someone asks about the fee: two and a half percent, floored, so the rounding remainder goes to the creator and not to us.*

---

## Slide 6 — Live demo

Switch to the browser here. Say the line, then do the thing.

**0:00 — List a prompt**

> **I am a creator. I paste my prompt, a preview, and a price.**
>
> **Listing asks for a signature, not a transaction. No gas, and my wallet address is my identity. There is no account to make.**

**1:00 — Buy it**

> **Now I am a buyer, on a different wallet. I click unlock and sign the payment message.**
>
> **The prompt appears, and so does this line: the delivered text matches the hash that was published before I paid. I can check I got what was advertised, byte for byte.**

**2:00 — Run it in Claude**

> **This is the point of buying a prompt. Here it is in Claude, and here is what it produces.**

*Have this already open in a tab with the output on screen. Paste and switch, do not wait for generation.*

**3:00 — Claim**

> **Back to the creator. One buyer, the fee taken, and the rest is claimable.**
>
> **I claim, I sign, and the USDC lands in my wallet. That number is read from the contract, not from my own database, because the contract is what actually pays.**

*If the network stalls, stop and say: "This settled earlier, here it is on Basescan." Then open the receipt. Do not wait in silence.*

---

## Slide 7 — What is built

> **All of this is deployed. The contract is on Base Sepolia and source verified, the API is on Railway, the app is on Vercel.**
>
> **Three hundred and twenty two tests across the contract, the backend, and the front end.**
>
> **And the roles are separated in a way you can check yourself: the deployer holds neither the settler role nor the upgrade role. A compromised backend can write a false record, but it cannot rewrite the contract.**

*Cut for three minutes: keep the first line and the test count, drop the roles sentence unless asked.*

---

## Slide 8 — Limits

> **Three things I would tell you before you trusted this with real money.**
>
> **It is testnet only. The upgrade authority is a single key, and a multisig would be stronger. And the facilitator is a third party on the critical path of every purchase.**
>
> **The honest gap is demand. The revenue mechanism is built, not planned, but nothing here proves people will pay. Funding would not close that faster than putting the catalog in front of real buyers.**

*Saying this yourself is worth more than being caught on it. Keep it short and unapologetic.*

---

## Slide 9 — Close

> **The app, the code, and the contract are all open, and every number I showed you can be checked on chain.**
>
> **Thank you. I am happy to take questions, especially about the x402 side, because a few things in that ecosystem are not what the documentation says.**

*That last clause invites the question you most want to answer.*

---

## Questions you should expect

**"Why would an agent buy a prompt instead of writing one?"**

> Because a paid listing carries a preview produced by running that exact prompt. You are paying for output you can see worked, not for text a model could improvise. That is the criterion the Claude Code skill reasons from.

**"What stops someone reselling the prompt after buying it?"**

> Nothing, and that is true of every digital good. The price is set low enough that buying is cheaper than the effort of not buying. The paywall exists to make the sale possible, not to make copying impossible.

**"Is the money safe in that contract?"**

> The contract can never credit more than it holds, and a creator can only ever withdraw their own balance to their own address. The upgrade key is the real trust assumption, and I would move it to a multisig before mainnet.

**"What was hardest?"**

> A bug where the browser could not pay but the command line could, against the same endpoint with the same signature. The payment client was putting a response header on the request, and browsers refuse to send a request whose header names are not allowed. It reported as a CORS error, so the symptom pointed at a misconfiguration that did not exist. Four hypotheses were wrong before I measured what was actually on the wire.

**"How much did this cost to run?"**

> The gas for one contract deployment, about twenty four millionths of an ETH on a testnet. Everything else is free tier.
