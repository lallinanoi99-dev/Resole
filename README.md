# Resole

Sell your second-hand shoes and apparel. Sellers upload photos and set their own price in BOT, buyers pay on-chain in BOT, and every listing and sale lives permanently on BOT Chain.

*Peer-to-peer. No escrow, no refunds, no platform fee, no admin. Buyer and seller arrange delivery off-chain. Use cheap demo items when testing on mainnet.*

## Status

| | |
|---|---|
| Live site | _not published yet_ |
| Source | https://github.com/lallinanoi99-dev/Resole |
| Upload Worker | _not deployed yet_ |
| Contract (BOT Chain mainnet, chain ID 677) | [`0xe0672E65859cbf537EF1f7d2498047BAeC09Ba9c`](https://scan.botchain.ai/address/0xe0672E65859cbf537EF1f7d2498047BAeC09Ba9c) (deployed in block 28957142) |

## Project layout

- `index.html`: the whole frontend (ethers.js v6 from CDN, no build step)
- `contracts/Resole.sol`: the marketplace contract (Solidity ^0.8.20, OpenZeppelin `ReentrancyGuard`). BOT only, BOT Chain mainnet only.
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

Compiled with Solidity 0.8.20, optimizer 200 runs, EVM `paris`. The constructor takes **no arguments**, and it reverts with `WrongChain()` on any chain other than BOT Chain mainnet (chain ID 677). Testnet deploys are therefore impossible by design, so test with the preview mode and cheap demo items on mainnet.

1. Run the site locally and open http://localhost:4606/deploy.html in a browser with MetaMask.
2. Click **Deploy Resole to BOT Chain mainnet (677)**. MetaMask is switched to (or given) BOT Chain first.
3. Paste the address into `contract: ''` in `CONFIG.networks.mainnet` near the top of the script in `index.html`, and set `fromBlock` to the deploy block that `deploy.html` prints. The app uses `fromBlock` to find "Sold" transactions, and the public RPC does not answer log queries over the whole chain. That one `contract` constant feeds the app, the footer card and the explorer link.
4. Update the Status table above.

Or use Remix: paste `contracts/Resole.sol` into https://remix.ethereum.org (it resolves the `@openzeppelin/contracts` imports; use 5.0.2), compile with 0.8.20 and EVM version `paris`, switch MetaMask to BOT Chain mainnet, choose *Injected Provider – MetaMask*, select **Resole** and click **Deploy**. There is nothing to fill in.

| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| Mainnet | 677 | https://rpc.botchain.ai | https://scan.botchain.ai |

To verify the source on the explorer, use "Standard JSON input" with `build/Resole.standard-input.json` (it includes the OpenZeppelin sources), and compiler `v0.8.20+commit.a1b79de6`. There are no constructor arguments.

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
- **Listing:** `list(...)` needs a profile, 1–3 photo CIDs, a size, condition 0–3 (New · Like new · Good · Worn), and a price > 0 in BOT (wei). There is no edit, delete, unlist or re-price function.
- **Buying:** `buy(id)` needs a profile; blocks your own items and sold items; sets `buyer` and `soldAt` before any money moves, then forwards exactly `msg.value == price` in BOT to the seller with `call`. The contract never holds funds. One MetaMask transaction per purchase.
- **Prices:** BOT only, 18 decimals.
- **Events:** `ProfileSet`, `Listed`, `Sold`. The app reads items in pages through `getItems(start, count)` and finds sale transactions from `Sold` logs.

## Tests

```bash
npm --prefix tools install
node tools/compile.mjs
node tools/test-contract.mjs   # every rule in the contract, on an in-memory chain
node tools/check-frontend.mjs  # the ABI in index.html matches the contract; the site's calls work
npm --prefix worker install && npm --prefix worker test   # upload Worker, with Pinata stubbed
```
