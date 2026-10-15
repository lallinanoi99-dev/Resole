// Runs the compiled contract on an in-memory chain: profile → list → buy in BOT, plus every rule in the PRD.
// Usage (from the project root): node tools/compile.mjs && node tools/test-contract.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, ZeroAddress, parseEther } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { abi, bytecode } = JSON.parse(readFileSync(join(root, 'build/Resole.json'), 'utf8'));

const chain = (chainId) => new BrowserProvider(
  ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'merge', chainId }, wallet: { defaultBalance: 1000 } }),
);

// --- deploys only on BOT Chain mainnet (677) ------------------------
const elsewhere = chain(968);
const factoryElsewhere = new ContractFactory(abi, bytecode, await elsewhere.getSigner(0));
await assert.rejects(factoryElsewhere.deploy({ gasLimit: 3_000_000 }).then((c) => c.waitForDeployment()), 'deploy on chain 968 must fail');
assert.deepEqual(new ContractFactory(abi, bytecode).interface.deploy.inputs, [], 'constructor takes no arguments');

const provider = chain(677);
const [seller, buyer, other, nobody] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
// ganache under-estimates gas for some writes, so pin it
const GAS = { gasLimit: 1_000_000 };

const resole = await (await new ContractFactory(abi, bytecode, seller).deploy()).waitForDeployment();
assert.equal(await resole.BOT_CHAIN_ID(), 677n);
const as = (signer) => resole.connect(signer);
const events = (receipt) => receipt.logs.map((l) => resole.interface.parseLog(l)).filter(Boolean);
const reverts = (call, name) => assert.rejects(call, (e) => e.revert?.name === name, `expected ${name}`);

const SHOES = 0, APPAREL = 1;
const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const listArgs = (o = {}) => [
  o.title ?? 'Leather Sneakers', o.kind ?? SHOES, o.size ?? '42', o.condition ?? 1, o.photos ?? [CID],
  o.description ?? 'Worn twice.', o.price ?? parseEther('120'),
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

// --- list -----------------------------------------------------------
r = await (await as(seller).list(...listArgs({ photos: [CID, CID + '2', CID + '3'] }), GAS)).wait();
console.log(`list (3 photos) gas: ${r.gasUsed}`);
assert.equal(events(r)[0].name, 'Listed');
assert.deepEqual([events(r)[0].args.id, events(r)[0].args.seller, events(r)[0].args.price], [0n, seller.address, parseEther('120')]);
await (await as(seller).list(...listArgs({ title: 'Wrap Coat', kind: APPAREL, size: 'M', price: parseEther('25') }), GAS)).wait();
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
await reverts(as(buyer).buy.staticCall(0), 'WrongAmount');
await reverts(as(buyer).buy.staticCall(99), 'ItemNotFound');

// --- purchase: money goes straight to the seller --------------------
r = await (await as(buyer).buy(0, { value: parseEther('120'), ...GAS })).wait();
console.log(`buy gas: ${r.gasUsed}`);
const sellerGain = (await provider.getBalance(seller.address, r.blockNumber)) - (await provider.getBalance(seller.address, r.blockNumber - 1));
assert.equal(sellerGain, parseEther('120'));
assert.equal(await provider.getBalance(await resole.getAddress()), 0n);
const sold = events(r).find((e) => e.name === 'Sold');
assert.deepEqual([sold.args.id, sold.args.buyer, sold.args.seller, sold.args.price], [0n, buyer.address, seller.address, parseEther('120')]);
item = await resole.getItem(0);
assert.equal(item.buyer, buyer.address);
assert.ok(item.soldAt > 0n);

// sold forever
await (await as(other).setProfile('Late', '')).wait();
await reverts(as(other).buy.staticCall(0, { value: parseEther('120') }), 'AlreadySold');

// --- one wallet, both roles ---------------------------------------
await (await as(buyer).list(...listArgs({ title: 'Chelsea Boots', price: parseEther('1') }), GAS)).wait();
await (await as(seller).buy(2, { value: parseEther('1'), ...GAS })).wait();
await (await as(buyer).buy(1, { value: parseEther('25'), ...GAS })).wait();
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

// --- no admin surface, no token -----------------------------------
const fns = resole.interface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
assert.deepEqual(fns, ['buy', 'list', 'setProfile']);
assert.ok(!resole.interface.fragments.some((f) => /usdt|currency/i.test(f.format('full'))), 'no USDT anywhere in the ABI');

console.log('all contract checks passed');
