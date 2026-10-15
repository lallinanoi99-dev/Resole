# Resole

Sell your second-hand shoes and apparel. Sellers upload photos and set their own price in BOT or USDT, buyers pay on-chain, and every listing and sale lives permanently on BOT Chain.

*Peer-to-peer. No escrow, no refunds, no platform fee, no admin. Buyer and seller arrange delivery off-chain. Use cheap demo items when testing on mainnet.*

## Status

| | |
|---|---|
| Live site | _not published yet_ |
| Upload Worker | _not deployed yet_ |
| Contract (BOT Chain mainnet, chain ID 677) | _not deployed yet_ |
| Contract (testnet, chain ID 968) | _not deployed yet_ |
| USDT (mainnet) | [`0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C`](https://scan.botchain.ai/token/0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C) (Tether USD, 6 decimals, from the dex.botchain.ai token list) |
| USDT (testnet) | [`0x75edC9335175Fc0552D51D48439F229c10420fe3`](https://scan.bohr.life/token/0x75edC9335175Fc0552D51D48439F229c10420fe3) |

## Project layout

- `index.html`: the whole frontend (ethers.js v6 from CDN, no build step)
- `contracts/Resole.sol`: the marketplace contract (Solidity ^0.8.20, OpenZeppelin `ReentrancyGuard` + `SafeERC20`)
- `contracts/TestUSDT.sol`: a mintable 6-decimal token for testnet only
- `deploy.html`: one-click deploy from MetaMask
- `build/`: compiled ABI and bytecode, plus standard JSON input for explorer verification
- `worker/`: the photo upload Worker (Cloudflare, `POST /upload` → IPFS via Pinata)
- `tools/`: scripts that compile and test the contract and check the frontend against it
- `images/`: the BOT Chain logo for the footer, and demo photos for preview mode (credits in `images/CREDITS.md`)

## Run locally

```bash
python3 -m http.server 4606
```

Then open http://localhost:4606. Until a contract address is configured the site runs in *preview mode*: a seeded demo shop, with profiles, listings and purchases saved in this browser's localStorage, so every screen can be reviewed before deploying. Without MetaMask it uses a preview wallet. Add `?reset` to start over. In preview mode, photos stay in the browser unless `CONFIG.uploadUrl` is set.

## 1. Deploy the contract

Compiled with Solidity 0.8.20, optimizer 200 runs, EVM `paris`. The constructor takes one argument: the USDT token address (`0x000…0` = BOT-only; the app then hides USDT).

1. Run the site locally and open http://localhost:4606/deploy.html in a browser with MetaMask.
2. Testnet: the official testnet USDT is prefilled. If you have none, click **Deploy test USDT (968)**, which also mints you 1,000 tUSDT. Then click **Deploy Resole to Testnet** and try the app at http://localhost:4606/?net=testnet. On localhost the app picks up the address you just deployed.
3. Mainnet: the official USDT is prefilled. Click **Deploy Resole to Mainnet**.
4. Paste each address into the matching `contract: ''` field in `CONFIG.networks` near the top of the script in `index.html`, and set `fromBlock` to the deploy block that `deploy.html` prints. The app uses `fromBlock` to find "Sold" transactions, and the public RPC does not answer log queries over the whole chain. That one `contract` constant feeds the app, the footer card and the explorer link.
5. Update the Status table above.

Or use Remix: paste `contracts/Resole.sol` into https://remix.ethereum.org (it resolves the `@openzeppelin/contracts` imports; use 5.0.2), compile with 0.8.20 and EVM version `paris`, then deploy with *Injected Provider – MetaMask*, passing the USDT address.

| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| Testnet | 968 | https://rpc.bohr.life | https://scan.bohr.life |
| Mainnet | 677 | https://rpc.botchain.ai | https://scan.botchain.ai |

To verify the source on the explorer, use "Standard JSON input" with `build/Resole.standard-input.json` (it includes the OpenZeppelin sources), compiler `v0.8.20+commit.a1b79de6`, and the USDT address as the constructor argument.

## 2. Deploy the upload Worker

The Worker holds the Pinata JWT as a secret, so it never reaches the browser. Create a JWT at https://app.pinata.cloud (API Keys, with file upload permission).

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put PINATA_JWT
npx wrangler deploy
```

Before deploying, edit `ALLOWED_ORIGINS` in `worker/wrangler.toml`: your live site origin(s), comma-separated, no trailing slash. Requests from any other origin get a 403. Then paste the Worker URL plus `/upload` into `CONFIG.uploadUrl` in `index.html`.

What the Worker does for each photo:

- accepts JPG, PNG or WebP only (checked by file signature, not the name), max 5 MB
- strips metadata before pinning: EXIF (including GPS location), XMP, IPTC and comments, while keeping the colour profile
- max 1200 px on the long side. The site already crops to a square and resizes to ≤ 1200 px in the browser before upload, so the Worker rejects anything larger. Optionally, bind Cloudflare Images (see `wrangler.toml`) to have the Worker scale oversized photos down instead.
- pins to IPFS (public network) and returns the CID. Only CIDs go on-chain, and pins are never removed.
- limits each IP to 40 uploads per hour (bind a KV namespace as `RATE_KV` to make it hold across instances)

Photos load through `CONFIG.ipfsGateway` (Pinata's public gateway by default, with `ipfs.io` as a fallback). For production traffic, a dedicated Pinata gateway is faster.

## 3. Publish the site

GitHub Pages serves the `gh-pages` branch, so publish with `git push origin main:gh-pages` after pushing `main` (or switch the Pages source to `main` under Settings → Pages). For a custom domain, add it under Settings → Pages, which creates the `CNAME` file. Remember to add the final origin to `ALLOWED_ORIGINS` and redeploy the Worker.

## How it works

- **One wallet, both roles.** Selling / Buying is a mode in the app (saved in localStorage), not on-chain. Any wallet with a profile can list and buy.
- **Profile:** `setProfile(name, contact)` is created once and can be updated later; old listings keep working. Name ≤ 32 bytes, contact ≤ 64. The app refuses anything that looks like a phone number.
- **Listing:** `list(...)` needs a profile, 1–3 photo CIDs, a size, condition 0–3 (New · Like new · Good · Worn), price > 0, and USDT only if the contract has a token. There is no edit, delete, unlist or re-price function.
- **Buying:** `buy(id)` needs a profile; blocks your own items and sold items; sets `buyer` and `soldAt` before any money moves, then sends BOT with `call` (exact `msg.value`) or pulls USDT with `SafeERC20.safeTransferFrom` straight to the seller. The contract never holds funds. USDT takes two transactions in the app: approve the exact price, then buy.
- **Prices:** BOT uses 18 decimals; USDT decimals are read from the token (6 on BOT Chain).
- **Events:** `ProfileSet`, `Listed`, `Sold`. The app reads items in pages through `getItems(start, count)` and finds sale transactions from `Sold` logs.

## Tests

```bash
npm --prefix tools install
node tools/compile.mjs
node tools/test-contract.mjs   # every rule in the contract, on an in-memory chain
node tools/check-frontend.mjs  # the ABI in index.html matches the contract; the site's calls work
npm --prefix worker install && npm --prefix worker test   # upload Worker, with Pinata stubbed
```
