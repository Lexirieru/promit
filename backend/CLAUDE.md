# backend/ — Promit API (U3) di atas modul katalog (U2), unlock x402 (U4)

Bun package. `bun test` / `bun run typecheck` / `bun run dev` (server,
port 3001) / `bun run mirror` / `bun run settler` (worker U10) from this
directory. U2 owns everything under `src/catalog/`,
`scripts/mirror-media.ts`, and `data/catalog.json`; U3 owns `src/index.ts`,
`src/routes/catalog.ts`, `src/middleware/cors.ts`, `src/db.ts`; U4 owns
`src/x402/` and `src/routes/unlock.ts`; U7 owns `src/catalog/listing.ts`
and `src/routes/listings.ts`; U10 owns `src/settler/`.

## API contract (U3<->U5, locked by the coordinator 2026-08-07)

The frontend hardcodes these in `frontend/src/lib/api.ts`
(`NEXT_PUBLIC_PROMIT_API_URL`, default `http://localhost:3001`). Do not
change a path or shape without a decision_gate.

- `GET /v1/catalog` → `{ entries: PublicEntry[], total }`; optional
  `?category=<name>&tier=<free|paid>`. Unknown filter values return an
  empty list, **not** an error.
- `GET /v1/catalog/:id` → bare PublicEntry; 404 for unknown ids.
- `GET /v1/prompts/:id` → the x402 unlock route (U4, see its section
  below). Free tier: 200 `{ id, tier, text, contentHash, attribution }`,
  no payment. Paid success: 200 with the same fields plus `txHash`,
  `network`, `payer` — text, tx hash, AND content hash in the body is the
  locked contract.
- `GET /health` → `{ ok: true }`.
- `GET /media/*` → committed mirror output PLUS `media/uploads/` runtime
  kreator (U7), traversal-guarded, `X-Content-Type-Options: nosniff`
  (ada byte kiriman pengguna di bawah path ini — jangan hapus header itu).
- `GET /v1/listings/bounds`, `POST /v1/listings/prepare`,
  `POST /v1/listings` → U7, lihat bagian Creator listing di bawah.
- `GET /v1/unlocks?payer=0x…` → `{ payer, unlocks: [{ id, unlockedAt,
  txHash, contentHash }], total }`, hanya status `delivered`. Lihat bagian
  Entitlement di bawah.
- Errors are `{ error: "<snake_case_code>", message: "<sentence>" }`.
- **No `body` field in any catalog response, free tier included** — free
  text is delivered by `/v1/prompts/:id` only, so prompt text has exactly
  one delivery path.

The catalog id space is the **union** of seed entries and creator listings
(SQLite); seed wins on collision. `listingToPublicEntry()` re-parses every
listing through `PublicCatalogEntrySchema`, the same mechanical no-body
guarantee `listPublicEntries()` gives seed entries.

## CORS (the confusing-failure trap)

**`ACCESS-CONTROL-EXPOSE-HEADERS` harus tetap ada di `allowHeaders`
(2026-08-08).** `@x402/fetch` menyalin header respons 402 ke request retry,
jadi request berbayar tiba membawa `Access-Control-Expose-Headers` — header
respons yang berjalan sebagai header request. curl dan CLI tidak peduli
karena keduanya tidak menegakkan CORS; browser menolak mengirim request
yang nama headernya tidak ada di `Access-Control-Allow-Headers`, lalu
melaporkannya sebagai "CORS error"/"Failed to fetch" dengan respons kosong
dan **nol jejak di log server**. Itulah sebabnya CLI bisa membeli prompt
yang browser tidak bisa, ke endpoint yang sama dengan tanda tangan yang
sama. Diukur langsung dari origin frontend terdeploy: tanpa header itu 402,
dengan header itu `Failed to fetch`. Dipatok `src/middleware/cors.test.ts`.


`src/middleware/cors.ts` exposes `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`
and allows `PAYMENT-SIGNATURE`. Browsers null out any cross-origin response
header not in `Access-Control-Expose-Headers` even though DevTools shows it
on the wire — drop the expose list and the browser payment client sees no
payment requirements and no tx hash while every request "succeeds". Keep
U4's unlock route under this same middleware (`app.use("*", …)` already
covers it).

## Penyimpanan yang bertahan (Railway volume, 2026-08-08)

Dua hal ditulis saat RUNTIME dan karenanya hilang saat container dibangun
ulang: `data/promit.sqlite` (listing, paid body, unlock) dan upload kreator
di `media/uploads/`. Media seed ikut ter-commit, jadi ia selalu kembali —
akibatnya kegagalannya asimetris dan menyesatkan: baris listing bisa
selamat sementara preview-nya 404, yang terbaca seperti listing rusak,
bukan seperti storage hilang.

- `PROMIT_DB_PATH` mengarahkan SQLite ke disk persisten.
- `PROMIT_UPLOADS_ROOT` mengarahkan root yang memuat `uploads/`.

**JANGAN mount volume di `backend/media`.** Direktori itu berisi media seed
yang ter-commit; volume kosong akan menutupinya dan mematikan SELURUH
preview lain — menukar satu preview mati dengan dua puluh tiga. Root upload
sengaja dipisah, dan route `/media/*` memilih root berdasarkan prefiks
`uploads/`. Dipatok `src/uploads-root.test.ts`.

Satu volume Railway di `/data`, lalu:
`PROMIT_DB_PATH=/data/promit.sqlite` dan `PROMIT_UPLOADS_ROOT=/data/media`.

## SQLite runtime store (`src/db.ts`, KTD17)

`data/promit.sqlite`, gitignored, WAL. Three tables, three writers:
`paid_bodies` (U4/U7 write, unlock route reads), `unlocks` (U4 writes,
U10 drains on-chain; PK `(payer, payment_nonce)` with payer lowercased on
every access so EIP-55 casing can't defeat R19 idempotency; status enum
includes `settled_but_undelivered` for U4's onAfterSettle hook), and
`listings` (U7; `content_hash` UNIQUE = duplicate detection;
`insertListing` validates via `PublicCatalogEntrySchema` **before**
writing, so an invalid listing never enters the table). Tests use
`openDb(":memory:")` and inject via `createApp({ catalog, db })`.

## Unlock route x402 (U4) — jalur uang

`src/x402/server.ts` (resource server + facilitator + hook),
`src/x402/pricing.ts` (harga per prompt dari union seed+listing),
`src/routes/unlock.ts` (rutenya), mounted `/v1/prompts` in `index.ts`.
Ditulis melawan kontrak facilitator yang DIAMATI di
`docs/ARCHITECTURE.md` §12 — baca itu dulu sebelum menyentuh file ini.

**Aturan urutan settlement (jangan pernah dibalik):** resolve body →
tulis baris unlock `pending` → settle → hook `onAfterSettle` menulis
`settled_but_undelivered` (uang sudah pindah, body belum keluar) →
deliver → `delivered`. Settlement terjadi DI DALAM handler
(`processHTTPRequest` + `processSettlement` langsung), bukan lewat
middleware `paymentMiddleware` bawaan @x402/hono: middleware itu settle
SETELAH handler menghasilkan body, sehingga (a) tx hash tak mungkin
masuk body sukses seperti yang dikunci kontrak, dan (b) body yang hilang
baru ketahuan setelah pembeli terpotong.

- `settle.success` + tx hash adalah SATU-SATUNYA sinyal unlock (R10);
  payload yang lolos verify masih bisa gagal settle. Hook afterSettle
  juga terpanggil untuk penolakan (`success:false`) — selalu cek.
- §12 traps yang sudah ditangani: facilitator HTTP 500 (skema/network
  asing) dinormalkan library jadi 402 bersih; label
  `invalid_exact_evm_insufficient_balance` BOHONG untuk tanda tangan
  rusak (errorMessage di-log server-side, tidak pernah diteruskan —
  bocor internal); `payer` di respons GAGAL cuma echo `authorization.from`
  (atribusi hanya dari respons sukses).
- Timeout `/settle` = hasil TAK TENTU (`settlement_indeterminate`, 502):
  facilitator mungkin tetap settle; baris `pending` menjaga jejak.
  Jangan pernah laporkan sebagai kegagalan bersih.
- Domain EIP-712 di `accepts[].extra` dibaca dari tabel `getDefaultAsset`
  @x402/evm dan di-assert terhadap alamat USDC yang dipin (KTD18) —
  jangan pernah tulis konstanta `name`/`version` lokal.
- Env: `PAY_TO_ADDRESS` (wallet polos, JANGAN alamat proxy registry —
  KTD3; tanpa ini paid unlock menolak 503, free tetap jalan) dan
  `FACILITATOR_URL` (default `https://x402.org/facilitator`;
  `facilitator.x402.org` di README = NXDOMAIN).
- Tes memalsukan facilitator di seam `FacilitatorClient` sehingga semua
  bentuk wire di atasnya (header PAYMENT-*, pencocokan `accepted` yang
  strict-deep-equal terhadap requirements) adalah kode library asli.
  Klien tes harus meng-echo `accepts[0]` hasil decode PAYMENT-REQUIRED
  apa adanya — ubah satu field saja dan matching gagal.

## Entitlement — pembeli yang kembali (celah owner, 2026-08-07)

`src/entitlement.ts` (domain) + `src/routes/unlocks.ts` (daftar) + gate di
`src/routes/unlock.ts` SEBELUM 402. Tabel `unlocks` selalu tahu siapa
membeli apa; tanpa jalur baca ini pembeli yang kembali DITAGIH LAGI.

- **Kepemilikan dibuktikan, tidak diklaim.** Alamat di query bisa diketik
  siapa saja — tanpa tanda tangan, endpoint ini adalah paywall bypass, jauh
  lebih buruk daripada menagih dua kali. Klien personal_sign (EIP-191,
  seam yang sama dengan U7) pesan kanonik
  `promit.entitlement.v1|<promptId>|<nonce>|<issuedAt>` (issuedAt = epoch
  ms); server memulihkan alamatnya sendiri lewat `recoverMessageAddress`.
  promptId diambil dari PATH request — tanda tangan prompt A tidak membuka
  prompt B. Jendela: umur ≤5 menit, skew masa depan ≤1 menit. Pesan
  DICERMINKAN di `frontend/src/lib/entitlement.ts` dan
  `cli/src/entitlement.ts` — ubah ketiganya atau jangan sama sekali.
- Bukti dibawa header `ENTITLEMENT-PROOF: <payer>|<nonce>|<issuedAt>|<sig>`
  (ada di `PAYMENT_ALLOW_HEADERS` — cabut dan browser diam-diam menanggalkan
  header-nya, pembeli tertagih lagi) atau query
  `?payer&nonce&issuedAt&signature` (jalur curl).
- **Bukti yang dicoba tapi cacat/kedaluwarsa/salah-penanda-tangan = 401**
  (`entitlement_malformed` / `entitlement_expired` /
  `entitlement_signature_mismatch`), TIDAK PERNAH dijatuhkan diam-diam ke
  jalur tagih — klien yang berniat membuktikan kepemilikan tapi gagal harus
  mendengarnya, bukan membayar dua kali. Bukti sah tanpa baris delivered →
  402 normal (wallet lain tetap ditagih).
- Hanya `delivered` yang dihitung memiliki. `settled_but_undelivered`
  adalah kasus pemulihan manual — jalur baca tidak menyelesaikannya
  diam-diam. `GET /v1/unlocks` tanpa tanda tangan disengaja: isinya (id,
  waktu, tx hash, content hash) sudah publik on-chain; TEKS hanya lewat
  `/v1/prompts/:id` dengan bukti terverifikasi.
- Respons kepemilikan = bentuk sukses paid ditambah `alreadyOwned: true`,
  `txHash` dari baris delivered TERTUA (bukti pembelian orisinal).

## Creator listing (U7)

`src/catalog/listing.ts` (domain: pesan kanonik, batas harga, klasifikasi
media, mirror upload) + `src/routes/listings.ts` (route), mounted
`/v1/listings` di `index.ts`.

- **Autentikasi = tanda tangan wallet, titik (R26/AE10).** Kreator
  personal_sign (EIP-191) atas `canonicalListingMessage()`:
  `promit.listing.v1\ntitle: …\ncategory: …\ncontentHash: …\n
  priceAtomic: …\nnonce: …`. Server menghitung ulang hash dari body yang
  DITERIMA, membangun ulang pesan, `recoverMessageAddress`, dan menolak
  401 `signature_mismatch` bila tidak sama dengan `creatorAddress`.
  Format pesan DICERMINKAN di `frontend/src/lib/listing.ts` — ubah dua-
  duanya atau jangan sama sekali. Field diverifikasi verbatim: trim atau
  normalisasi server-side akan mematahkan tanda tangan yang sah.
- **Urutan penolakan:** validasi field (400 `validation_failed` +
  `fields` per-field) → batas harga (400 `price_out_of_bounds`, jawaban
  memuat batas) → duplikat (409 `duplicate_content` + `existingId`, cek
  union seed+listing lewat content hash; UNIQUE constraint tetap penjaga
  balapan) → tanda tangan (401) → mirror media (502
  `media_mirror_failed`, bisa diulang) → transaksi SQLite
  (`insertListing` + `setPaidBody` atomik). Tidak ada byte yang mendarat
  di storage sebelum tanda tangan terbukti.
- **`POST /prepare`** (`{ body }` → `{ contentHash, teaser }`, 409 bila
  duplikat) ada supaya penolakan termurah datang SEBELUM kreator
  menandatangani dan meng-upload; klien tidak butuh implementasi keccak
  kedua yang bisa drift.
- **Media wajib upload (R5):** string URL di field media = 400
  `media_must_be_upload` dengan namanya sendiri. MIME yang diterima
  (webp/png/jpg/mp4/webm, ≤10 MB) wajib cocok magic bytes — byte HTML
  berlabel image/* yang tersaji dari origin API adalah vektor XSS. Upload
  mendarat di `media/uploads/<id>.<ext>` (gitignored); video upload
  `poster: null` (tidak ada ffmpeg runtime), galeri menanganinya.
- **Batas harga terpublikasi:** `MIN_PRICE_ATOMIC`/`MAX_PRICE_ATOMIC`
  ($0.01–$10.00) di `listing.ts`, disajikan `GET /bounds` — frontend
  menampilkannya, server menegakkannya.
- Id = slug judul, disufiks `-2`, `-3`, … terhadap union seed+listing:
  seed menang saat tabrakan di route katalog, jadi id milik seed tidak
  pernah diterbitkan untuk listing (akan terbayangi selamanya).
- Tes menandatangani dengan kunci viem sungguhan dan menempuh tarian 402
  U4 di seam `FacilitatorClient` yang sama dengan `unlock.test.ts`.

## Payout kreator (`src/payouts/`, 2026-08-08)

Skema `exact` x402 menyelesaikan SATU transfer EIP-3009 ke SATU penerima, jadi
pembayaran tidak bisa dipecah saat settlement. Treasury menerima bruto, lalu
bagian kreator diteruskan di sini. `fee.ts` (aritmetika, 2,5% default lewat
`PROMIT_FEE_BPS`), `queue.ts` (tabel `payouts`, PK `(payer, payment_nonce)`
sama seperti `unlocks`), `chain.ts` (seam + preflight), `index.ts` (worker).

Urutan per payout dan TIDAK boleh dibalik: tandai `sending` (ter-commit) →
broadcast → confirm → tandai `sent`. Menandai setelah broadcast membuat baris
milik proses yang mati tak bisa dibedakan dari yang belum pernah dicoba, dan
scan berikutnya akan membayarnya lagi.

- **`sending` tidak pernah di-retry otomatis.** Transfer USDC tidak punya
  kunci idempotensi; proses yang mati di antara broadcast dan penulisan hash
  meninggalkan dua kemungkinan yang tak terbedakan. Retry = bayar dua kali
  (uang hilang); flag = lima menit kerja manusia dengan block explorer.
- **Preflight menolak dengan alasan bernama.** `treasury_mismatch` yang
  terpenting: pembeli membayar `PAY_TO_ADDRESS`, jadi kunci milik wallet lain
  akan membayar kreator dari dompet yang salah sementara treasury diam-diam
  menumpuk utang.
- **Kekurangan dana meninggalkan baris `pending`, bukan `flagged`** — treasury
  yang diisi ulang akan menguras antrean tanpa campur tangan siapa pun.
- Sisa pembulatan selalu jatuh ke KREATOR, tidak pernah ke protokol.
- Env: `TREASURY_PRIVATE_KEY` (tanpa ini payout menumpuk tak terbayar),
  `PAY_TO_ADDRESS`, `BASE_SEPOLIA_RPC_URL`, opsional `PROMIT_FEE_BPS`.

**Risiko yang diterima sadar:** worker jalan IN-PROCESS bersama API, jadi
server memegang hot wallet yang menguasai seluruh pendapatan; backend yang
diretas bisa menguras treasury. Settler sengaja dibuat lebih lemah dari ini.
Memindahkannya ke service sendiri hanya butuh satu start command dan itu hal
pertama yang harus dilakukan kalau ini berhenti jadi testnet.

## Settler on-chain (U10)

`src/settler/` — `chain.ts` (seam `RegistryChain`: semua panggilan viem,
nol keputusan), `queue.ts` (antrean job persisten di SQLite), `index.ts`
(worker: preflight, drain, `import.meta.main` = proses mandiri
`bun run settler`). Env: `SETTLER_PRIVATE_KEY`, `PROMIT_REGISTRY_ADDRESS`,
`BASE_SEPOLIA_RPC_URL`, opsional `SETTLER_MIN_ETH` (default 0.0005) dan
`PROMIT_REGISTRY_DEPLOY_BLOCK`.

**DB ADALAH antreannya.** Enqueue = scan baris yang sudah ditulis U4/U7
(unlock ber-status pasca-settlement dengan `onchain_tx_hash` NULL; listing
tanpa `onchain_tx_hash`), idempoten lewat PK `(kind, ref)` di
`settler_jobs`. Route unlock TIDAK berubah untuk U10 — pencatatan asinkron
struktural: pembeli tidak pernah menunggu Base Sepolia, chain mati =
unlock tetap terlayani + job tetap `pending`. `onListingCreated` di route
listings hanya poke latensi; tanpa itu pun scan berkala menemukan barisnya.
Job `flagged` = butuh manusia, tidak pernah di-retry otomatis.

Tiga aturan yang menyelamatkan demo (semua diuji di `settler.test.ts`
dengan FakeChain yang MENGHITUNG transaksi terkirim):

1. **Idempotensi dari kunci TERSIMPAN di registry, bukan EIP-3009.**
   `isUnlocked(payer, nonce)` dibaca SEBELUM kirim — retry pasca-crash
   mengirim NOL transaksi. Kontrak memang men-no-op duplikat, tapi sambil
   menagih gas; nonce USDC hanya unik per-payer dan hanya mencegah
   transfer ganda, bukan pencatatan ganda. Listing lebih tajam lagi:
   `registerListing` TIDAK punya guard duplikat on-chain, jadi scan log
   `ListingRegistered` adalah satu-satunya pagar anti-registrasi-ganda.
2. **Receipt dulu, registry belakangan.** Hash tx facilitator harus punya
   receipt sukses sebelum ditulis; `receipt_misses` dihitung TERPISAH dari
   `attempts` supaya RPC mati tidak terakumulasi jadi vonis "facilitator
   bohong" (default 3 pengamatan null → flagged; revert → flagged
   seketika).
3. **Preflight menolak start dengan error bernama** (`SettlerUnderfunded`,
   `SettlerRoleMissing`, `SettlerOverprivileged`): saldo di bawah ambang,
   tanpa `SETTLER_ROLE`, ATAU memegang `UPGRADER_ROLE`/`DEFAULT_ADMIN_ROLE`
   — kunci backend yang bisa upgrade registry mematahkan model keamanannya.

Jebakan yang sudah dibayar:

- `eth_getLogs` di sepolia.base.org menolak rentang >2000 blok, jadi
  `fromBlock:'earliest'` mati justru di RPC default. Scan di-chunk per
  2000 blok dari blok deploy yang ditemukan binary search `eth_getCode`
  (RPC-nya melayani state historis); inkremental per proses. JANGAN
  hardcode blok deploy yang salah — jawaban "tidak ada" palsu = listing
  ganda.
- `settler_onchain_listings` memetakan slug prompt → `listingId` numerik
  registry; mapping ini tidak ada di tempat lain off-chain. Unlock untuk
  prompt tanpa baris listing di-flag, bukan didaftarkan diam-diam — semua
  seed bertier free (R3), jadi unlock berbayar selalu menunjuk listing
  kreator.
- Verifikasi live read-only (tanpa broadcast): jalankan preflight + baca
  `isUnlocked`/scan log terhadap proxy — sudah lolos terhadap
  `0x30c92fFadAd24Ca079227A92A33b78683D36Fde6` (saldo settler 0.002 ETH,
  hanya `SETTLER_ROLE`). E2E dengan transaksi nyata adalah gerbang U14.

## The one rule that matters

**Public routes serialize `PublicCatalogEntry` only.** That type has no
field that can carry prompt text — the paywall (R2/KTD6) is enforced by the
type system plus `listPublicEntries()`, which re-parses every entry through
`PublicCatalogEntrySchema` and thereby strips the free-tier `body` present in
`catalog.json`. Never serve `CatalogFileEntry` or the raw catalog file from
a route; get bodies through `getFreePromptBody()` (free tier) or the SQLite
store (paid, U4's job). A paid body inside `catalog.json` is rejected at
load time by a schema refinement.

## Data flow

`data/motionsites-free.json` (raw capture, 23 entries, do not edit)
→ `normalizeSeed()` (canonical categories, slug ids, teasers, content hash)
→ `bun run mirror` (downloads raws into gitignored `.media-cache/`,
optimizes into committed `media/`, rewrites URLs)
→ `data/catalog.json` (generated — regenerate, never hand-edit; runtime
writes such as creator listings go to SQLite, not this file).

- Category variants (`Landing page`/`Landing Page`, `Hero`/`Hero Section`)
  collapse via `CATEGORY_ALIASES`; unknown categories **throw**. Adding a
  category = edit `CategorySchema` + `CATEGORY_ALIASES` deliberately.
- Ids are deterministic slugs of titles (`email-landing-page`); re-running
  the pipeline never changes an id.
- `media` is either a Promit-relative `/media/<id>.<ext>` or `null` with
  `mediaStatus: "unavailable"`. A third-party URL never enters the catalog;
  a failed download is a flag, not a fallback (R5). U3 must serve
  `backend/media/` at `/media/*`.
- Every `mediaType: "video"` entry carries `poster` (`/media/<id>.poster.jpg`),
  the clip's first frame — the gallery must show it while the video loads
  (U5/R27). Images have `poster: null`.
- `priceAtomic` is a string of atomic USDC units (6 decimals); `"0"` = free.

## Media optimization (coordinator-approved, 2026-08-07)

Raw capture media was 93 MB; the committed `media/` is ~16 MB (+posters):

- **mp4 → H.264** CRF 28, max width 1280 (aspect preserved, even dims for
  yuv420p), audio dropped, `+faststart`.
- **gif → mp4** with the same settings, `mediaType` flipped to `"video"`.
  Measured 23x smaller at better quality. GIF-as-GIF recompression is a
  **dead end**: best honest result was 0.5x with visible damage, and
  moderate settings came out *larger* than the source (the source GIFs'
  frame-differencing beats a re-encode). No entry points at `.gif`.
- **webp** (all ≤1.4 MB) copied as-is.
- The raw 93 MB stays in gitignored `.media-cache/`; never commit it.

**Machine limitation:** the homebrew ffmpeg build here has **no webp
encoder** (`libwebp_anim` absent) and `gif2webp`/`cwebp` are not installed —
gif→animated-webp is not an available path. Don't rediscover this dead end.

## Content hash

`computeContentHash()` in `src/catalog/hash.ts` renders the **published**
rule in `docs/CONTENT-HASH.md` (CRLF/CR→LF → strip trailing whitespace →
keccak256 → `keccak256:` + lowercase hex). The rule itself is imported from
`@promit/x402-client` (`hashPromptText`), never re-implemented, so the
minted hash and the buyer-side verifier (AE7) cannot diverge —
`content-hash-seam.test.ts` pins that seam, including every shipped catalog
entry. keccak256, not SHA-256, because `PromitRegistry` stores the digest as
a native EVM `bytes32` (`0x`-prefixed rendering of the same digest). The doc
is the protocol: never change the rule without changing the doc, the prefix,
and every stored hash in the same commit. Tests extract the doc's `js-sha3`
snippet and run it verbatim as an independent implementation.

## Traps learned building this

- Two seed bodies (`ai-designer-portfolio`, `3d-portfolio`) legitimately
  contain `https://motionsites.ai/...` image URLs **inside the prompt
  text** — they are content, not preview media. U14's third-party-host grep
  must check catalog `media` fields, not raw file text.
- The r2.dev GIFs send no Content-Length; sizes only appear on GET.
  `mirror-media.ts` skips existing non-empty files (both raw cache and
  committed output), so re-runs and fresh clones are cheap; `--force`
  redownloads and re-encodes.
- Keep `verbatimModuleSyntax`: type-only imports must use `import type` or
  `bun test` still runs while `tsc --noEmit` fails.
- `bun.lock` is deliberately gitignored here — U16's workspace root owns
  dependency locking once the bun workspace lands.
