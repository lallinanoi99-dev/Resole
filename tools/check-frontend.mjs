// Checks that the ABI written into index.html matches the compiled contract, then drives the
// frontend's exact read and buy calls against an in-memory chain with BOT Chain's chain ID (677).
// Usage (from the project root): node tools/compile.mjs && node tools/check-frontend.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, Interface, parseEther } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const artifact = JSON.parse(readFileSync(join(root, 'build/Resole.json'), 'utf8'));

// Pull the ABI array out of index.html and evaluate it as plain JS.
const start = html.indexOf('const ABI = [');
assert.ok(start >= 0, 'ABI not found in index.html');
const tupleLine = html.match(/const ITEM_TUPLE = '[^']+';/)[0];
const ABI = new Function(`${tupleLine}\n${html.slice(start, html.indexOf('];', start) + 2)}\nreturn ABI;`)();

// 1) Every fragment the site uses must exist in the compiled contract with the same types.
const site = new Interface(ABI);
const real = new Interface(artifact.abi);
for (const f of site.fragments) {
  const match = real.fragments.find((r) => r.type === f.type && r.format('minimal') === f.format('minimal'));
  assert.ok(match, `index.html ${f.type} does not match the contract: ${f.format('full')}`);
}
console.log(`ABI: ${site.fragments.length} fragments match the compiled contract`);

// 2) Run the site's calls on a chain.
const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'merge', chainId: 677 } }));
const [seller, buyer] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
const GAS = { gasLimit: 1_000_000 };
const deployed = await (await new ContractFactory(real, artifact.bytecode, seller).deploy()).waitForDeployment();
const address = await deployed.getAddress();
const asSeller = new Contract(address, ABI, seller);
const asBuyer = new Contract(address, ABI, buyer);
const reader = new Contract(address, ABI, provider);

await (await asSeller.setProfile('Vee', 'TG @vee')).wait();
await (await asBuyer.setProfile('Bo', '')).wait();
const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const receipt = await (await asSeller.list('Sneakers', 0, '42', 1, [cid], 'desc', parseEther('25'), GAS)).wait();
const listed = receipt.logs.map((l) => { try { return asSeller.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === 'Listed');
assert.equal(listed.args.id, 0n);

// reads exactly as chainStore does
const [item] = await reader.getItems(0, 40);
assert.deepEqual([item.seller, item.title, Number(item.kind), item.size, Number(item.condition), [...item.photos], item.price],
  [seller.address, 'Sneakers', 0, '42', 1, [cid], parseEther('25')]);
const profile = await reader.profiles(seller.address);
assert.deepEqual([profile.exists, profile.name, profile.contact], [true, 'Vee', 'TG @vee']);

// custom errors decode the way explain() expects
await assert.rejects(reader.getItem(9), (e) => e.revert?.name === 'ItemNotFound');
await assert.rejects(asSeller.buy.staticCall(0, { value: parseEther('25') }), (e) => e.revert?.name === 'OwnItem');

// buy with the exact BOT value, like chainStore.buy
const buyTx = await asBuyer.buy(0, { value: item.price, ...GAS });
await buyTx.wait();
assert.equal((await reader.getItem(0)).buyer, buyer.address);
const [sold] = await reader.queryFilter(reader.filters.Sold(0), 0);
assert.equal(sold.transactionHash, buyTx.hash);
await assert.rejects(asBuyer.buy.staticCall(0, { value: item.price }), (e) => e.revert?.name === 'AlreadySold');
assert.deepEqual([...(await reader.purchasesOf(buyer.address))], [0n]);

console.log('frontend calls work against the compiled contract');
