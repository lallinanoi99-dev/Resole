// Runs the compiled contracts on an in-memory chain: profile → list → buy in BOT and USDT, plus every rule in the PRD.
// Usage (from the project root): node tools/compile.mjs && node tools/test-contract.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, ZeroAddress, parseEther, parseUnits } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = (name) => JSON.parse(readFileSync(join(root, `build/${name}.json`), 'utf8'));
const { abi, bytecode } = artifact('Resole');
const token = artifact('TestUSDT');

const provider = new BrowserProvider(
  ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'merge' }, wallet: { defaultBalance: 1000 } }),
);
const [seller, buyer, other, nobody] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
// ganache under-estimates gas for some writes, so pin it
const GAS = { gasLimit: 1_000_000 };

const usdt = await (await new ContractFactory(token.abi, token.bytecode, seller).deploy()).waitForDeployment();
const resole = await (await new ContractFactory(abi, bytecode, seller).deploy(await usdt.getAddress())).waitForDeployment();
const as = (signer) => resole.connect(signer);
const events = (receipt) => receipt.logs.map((l) => resole.interface.parseLog(l)).filter(Boolean);
const reverts = (call, name) => assert.rejects(call, (e) => e.revert?.name === name, `expected ${name}`);

const BOT = 0, USDT = 1, SHOES = 0, APPAREL = 1;
const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const listArgs = (o = {}) => [
  o.title ?? 'Leather Sneakers', o.kind ?? SHOES, o.size ?? '42', o.condition ?? 1, o.photos ?? [CID],
  o.description ?? 'Worn twice.', o.currency ?? BOT, o.price ?? parseEther('120'),
];

// --- profiles -------------------------------------------------------
await reverts(as(seller).list.staticCall(...listArgs()), 'NoProfile');
await reverts(as(seller).setProfile.staticCall('', ''), 'EmptyName');
await reverts(as(seller).setProfile.staticCall('x'.repeat(33), ''), 'TextTooLong');
await reverts(as(seller).setProfile.staticCall('Vee', 'x'.repeat(65)), 'TextTooLong');
let r = await (await as(seller).setProfile('Vee', '@vee_sells')).wait();
console.log(`setProfile gas: ${r.gasUsed}`);
assert.equal(events(r)[0].name, 'ProfileSet');
assert.deepEqual([...(await resole.profiles(seller.address))], [true, 'Vee', '@vee_sells']);
await (await as(buyer).setProfile('Bo', '')).wait();

// --- listing validation --------------------------------------------
await reverts(as(seller).list.staticCall(...listArgs({ title: '' })), 'EmptyTitle');
await reverts(as(seller).list.staticCall(...listArgs({ size: '' })), 'EmptySize');
await reverts(as(seller).list.staticCall(...listArgs({ title: 'x'.repeat(81) })), 'TextTooLong');
await reverts(as(seller).list.staticCall(...listArgs({ description: 'x'.repeat(501) })), 'TextTooLong');
await reverts(as(seller).list.staticCall(...listArgs({ condition: 4 })), 'BadCondition');
await reverts(as(seller).list.staticCall(...listArgs({ photos: [] })), 'BadPhotoCount');
await reverts(as(seller).list.staticCall(...listArgs({ photos: [CID, CID, CID, CID] })), 'BadPhotoCount');
await reverts(as(seller).list.staticCall(...listArgs({ photos: [CID, ''] })), 'EmptyPhoto');
await reverts(as(seller).list.staticCall(...listArgs({ price: 0 })), 'ZeroPrice');

// --- list in BOT and USDT -----------------------------------------
r = await (await as(seller).list(...listArgs({ photos: [CID, CID + '2', CID + '3'] }), GAS)).wait();
console.log(`list (3 photos) gas: ${r.gasUsed}`);
assert.equal(events(r)[0].name, 'Listed');
assert.equal(events(r)[0].args.id, 0n);
const usdtPrice = parseUnits('25', 6);
await (await as(seller).list(...listArgs({ title: 'Wrap Coat', kind: APPAREL, size: 'M', currency: USDT, price: usdtPrice }), GAS)).wait();
assert.equal(await resole.total(), 2n);

let item = await resole.getItem(0);
assert.equal(item.seller, seller.address);
assert.equal(item.title, 'Leather Sneakers');
assert.deepEqual([...item.photos], [CID, CID + '2', CID + '3']);
assert.equal(item.buyer, ZeroAddress);
assert.ok(item.listedAt > 0n);
assert.equal(item.soldAt, 0n);
await reverts(resole.getItem.staticCall(99), 'ItemNotFound');

// --- buy rules ------------------------------------------------------
await reverts(as(nobody).buy.staticCall(0, { value: parseEther('120') }), 'NoProfile');
await reverts(as(seller).buy.staticCall(0, { value: parseEther('120') }), 'OwnItem');
await reverts(as(buyer).buy.staticCall(0, { value: parseEther('119') }), 'WrongAmount');
await reverts(as(buyer).buy.staticCall(0, { value: parseEther('121') }), 'WrongAmount');
await reverts(as(buyer).buy.staticCall(1, { value: 1n }), 'WrongAmount'); // USDT item with BOT attached
await reverts(as(buyer).buy.staticCall(99), 'ItemNotFound');

// --- BOT purchase: money goes straight to the seller ---------------
r = await (await as(buyer).buy(0, { value: parseEther('120'), ...GAS })).wait();
console.log(`buy (BOT) gas: ${r.gasUsed}`);
const sellerGain = (await provider.getBalance(seller.address, r.blockNumber)) - (await provider.getBalance(seller.address, r.blockNumber - 1));
assert.equal(sellerGain, parseEther('120'));
assert.equal(await provider.getBalance(await resole.getAddress()), 0n);
const sold = events(r).find((e) => e.name === 'Sold');
assert.deepEqual([sold.args.id, sold.args.buyer, sold.args.seller, sold.args.currency, sold.args.price], [0n, buyer.address, seller.address, 0n, parseEther('120')]);
item = await resole.getItem(0);
assert.equal(item.buyer, buyer.address);
assert.ok(item.soldAt > 0n);

// sold forever
await (await as(other).setProfile('Late', '')).wait();
await reverts(as(other).buy.staticCall(0, { value: parseEther('120') }), 'AlreadySold');

// --- USDT purchase: approve, then buy -----------------------------
await (await usdt.connect(buyer).faucet(parseUnits('100', 6))).wait();
await assert.rejects(as(buyer).buy.staticCall(1)); // no allowance yet
await (await usdt.connect(buyer).approve(await resole.getAddress(), usdtPrice)).wait();
r = await (await as(buyer).buy(1, GAS)).wait();
console.log(`buy (USDT) gas: ${r.gasUsed}`);
assert.equal(await usdt.balanceOf(seller.address), usdtPrice);
assert.equal(await usdt.balanceOf(buyer.address), parseUnits('75', 6));
assert.equal(await usdt.balanceOf(await resole.getAddress()), 0n);
await reverts(as(other).buy.staticCall(1), 'AlreadySold');

// --- one wallet, both roles ---------------------------------------
await (await as(buyer).list(...listArgs({ title: 'Chelsea Boots', price: parseEther('1') }), GAS)).wait();
await (await as(seller).buy(2, { value: parseEther('1'), ...GAS })).wait();
assert.deepEqual([...(await resole.itemsOf(seller.address))], [0n, 1n]);
assert.deepEqual([...(await resole.itemsOf(buyer.address))], [2n]);
assert.deepEqual([...(await resole.purchasesOf(buyer.address))], [0n, 1n]);
assert.deepEqual([...(await resole.purchasesOf(seller.address))], [2n]);

// --- profile update keeps old listings working ---------------------
await (await as(seller).setProfile('Vee Studio', '')).wait();
assert.equal((await resole.profiles(seller.address)).name, 'Vee Studio');
assert.equal((await resole.getItem(0)).seller, seller.address);

// --- paging -------------------------------------------------------
assert.deepEqual((await resole.getItems(0, 10)).map((i) => i.title), ['Leather Sneakers', 'Wrap Coat', 'Chelsea Boots']);
assert.deepEqual((await resole.getItems(1, 1)).map((i) => i.title), ['Wrap Coat']);
assert.equal((await resole.getItems(5, 10)).length, 0);

// --- no admin surface ---------------------------------------------
const fns = resole.interface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
assert.deepEqual(fns, ['buy', 'list', 'setProfile']);

// --- BOT-only deployment rejects USDT listings --------------------
const botOnly = await (await new ContractFactory(abi, bytecode, seller).deploy(ZeroAddress)).waitForDeployment();
await (await botOnly.setProfile('Vee', '')).wait();
await reverts(botOnly.list.staticCall(...listArgs({ currency: USDT })), 'UsdtDisabled');
await (await botOnly.list(...listArgs(), GAS)).wait();

console.log('all contract checks passed');
