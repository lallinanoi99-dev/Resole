// Checks that the ABI written into index.html matches the compiled contract, then drives the
// frontend's exact read and buy calls against an in-memory chain.
// Usage (from the project root): node tools/compile.mjs && node tools/check-frontend.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, Interface, parseEther, parseUnits } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const artifact = (name) => JSON.parse(readFileSync(join(root, `build/${name}.json`), 'utf8'));

// Pull the ABI arrays out of index.html and evaluate them as plain JS.
const block = (name) => {
  const start = html.indexOf(`const ${name} = [`);
  assert.ok(start >= 0, `${name} not found in index.html`);
  return html.slice(start, html.indexOf('];', start) + 2);
};
const tupleLine = html.match(/const ITEM_TUPLE = '[^']+';/)[0];
const { ABI, ERC20 } = new Function(`${tupleLine}\n${block('ABI')}\n${block('ERC20')}\nreturn { ABI, ERC20 };`)();

// 1) Every fragment the site uses must exist in the compiled contract with the same signature and outputs.
const site = new Interface(ABI);
const real = new Interface(artifact('Resole').abi);
for (const f of site.fragments) {
  const match = real.fragments.find((r) => r.type === f.type && r.format('minimal') === f.format('minimal'));
  assert.ok(match, `index.html ${f.type} does not match the contract: ${f.format('full')}`);
}
const tokenIface = new Interface(artifact('TestUSDT').abi);
for (const f of new Interface(ERC20).fragments) assert.ok(tokenIface.getFunction(f.format('sighash')), `ERC20 ${f.format('sighash')}`);
console.log(`ABI: ${site.fragments.length} fragments match the compiled contract`);

// 2) Run the site's calls on a chain.
const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'merge' } }));
const [seller, buyer] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
const GAS = { gasLimit: 1_000_000 };
const usdt = await (await new ContractFactory(tokenIface, artifact('TestUSDT').bytecode, seller).deploy()).waitForDeployment();
const deployed = await (await new ContractFactory(real, artifact('Resole').bytecode, seller).deploy(await usdt.getAddress())).waitForDeployment();
const address = await deployed.getAddress();
const asSeller = new Contract(address, ABI, seller);
const asBuyer = new Contract(address, ABI, buyer);
const reader = new Contract(address, ABI, provider);

await (await asSeller.setProfile('Vee', 'TG @vee')).wait();
await (await asBuyer.setProfile('Bo', '')).wait();
const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const listTx = await asSeller.list('Sneakers', 0, '42', 1, [cid], 'desc', 1, parseUnits('25', 6), GAS);
const receipt = await listTx.wait();
const listed = receipt.logs.map((l) => { try { return asSeller.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === 'Listed');
assert.equal(listed.args.id, 0n);

// reads exactly as chainStore does
assert.equal(await reader.usdt(), await usdt.getAddress());
assert.equal(Number(await new Contract(await reader.usdt(), ERC20, provider).decimals()), 6);
const [item] = await reader.getItems(0, 40);
assert.deepEqual([item.seller, item.title, Number(item.kind), item.size, Number(item.condition), [...item.photos], Number(item.currency), item.price],
  [seller.address, 'Sneakers', 0, '42', 1, [cid], 1, parseUnits('25', 6)]);
const profile = await reader.profiles(seller.address);
assert.deepEqual([profile.exists, profile.name, profile.contact], [true, 'Vee', 'TG @vee']);

// custom errors decode the way explain() expects
await assert.rejects(reader.getItem(9), (e) => e.revert?.name === 'ItemNotFound');
await assert.rejects(asSeller.buy.staticCall(0), (e) => e.revert?.name === 'OwnItem');

// USDT buy: approve then buy, like chainStore.buy
await (await usdt.connect(buyer).faucet(parseUnits('100', 6))).wait();
const token = new Contract(await usdt.getAddress(), ERC20, buyer);
assert.equal(await token.allowance(buyer.address, address), 0n);
await (await token.approve(address, item.price)).wait();
const buyTx = await asBuyer.buy(0, GAS);
await buyTx.wait();
assert.equal((await reader.getItem(0)).buyer, buyer.address);
const [sold] = await reader.queryFilter(reader.filters.Sold(0), 0);
assert.equal(sold.transactionHash, buyTx.hash);
await assert.rejects(asBuyer.buy.staticCall(0), (e) => e.revert?.name === 'AlreadySold');

// BOT buy with exact value
await (await asSeller.list('Boots', 0, '41', 2, [cid], '', 0, parseEther('1'), GAS)).wait();
await (await asBuyer.buy(1, { value: parseEther('1'), ...GAS })).wait();
assert.deepEqual([...(await reader.purchasesOf(buyer.address))], [0n, 1n]);

console.log('frontend calls work against the compiled contract');
