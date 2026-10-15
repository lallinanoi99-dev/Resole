// Compiles contracts/Resole.sol and contracts/TestUSDT.sol and writes build/ artifacts.
// Usage (from the project root): npm --prefix tools install && node tools/compile.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = ['Resole', 'TestUSDT'];

// Pull every imported OpenZeppelin file into `sources`, so the standard JSON input is self-contained
// and can be pasted straight into the explorer's verifier.
const sources = {};
function addSource(path) {
  if (sources[path]) return;
  const file = path.startsWith('@openzeppelin/') ? join(root, 'tools/node_modules', path) : join(root, path);
  const content = readFileSync(file, 'utf8');
  sources[path] = { content };
  for (const [, imp] of content.matchAll(/import\s+(?:[^'"]*from\s+)?["']([^"']+)["']/g)) {
    addSource(imp.startsWith('.') ? join(dirname(path), imp).replace(/\\/g, '/') : imp);
  }
}

const settings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'paris',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
};

mkdirSync(join(root, 'build'), { recursive: true });
for (const name of CONTRACTS) {
  for (const key of Object.keys(sources)) delete sources[key];
  const path = `contracts/${name}.sol`;
  addSource(path);
  const input = { language: 'Solidity', sources: { ...sources }, settings };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  for (const e of output.errors || []) console.error(e.formattedMessage);
  if ((output.errors || []).some((e) => e.severity === 'error')) process.exit(1);

  const contract = output.contracts[path][name];
  writeFileSync(join(root, `build/${name}.standard-input.json`), JSON.stringify(input, null, 2) + '\n');
  writeFileSync(
    join(root, `build/${name}.json`),
    JSON.stringify({ compiler: solc.version(), abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object }, null, 2) + '\n',
  );
  console.log(`${name}: compiled with ${solc.version()} — ${contract.evm.bytecode.object.length / 2} bytes`);
}
