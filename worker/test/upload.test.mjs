// Exercises the Worker's fetch handler in Node with Pinata stubbed out.
// Usage: npm test (from worker/)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import worker, { sniff, stripMetadata, MAX_BYTES } from '../src/index.js';

const ORIGIN = 'https://example.test';
const env = { ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:4606`, PINATA_JWT: 'test-jwt' };
const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

let pinned; // bytes Pinata received
let pinataStatus = 200;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://uploads.pinata.cloud/v3/files');
  assert.equal(init.headers.Authorization, 'Bearer test-jwt');
  assert.equal(init.body.get('network'), 'public');
  pinned = new Uint8Array(await init.body.get('file').arrayBuffer());
  if (pinataStatus !== 200) return new Response('nope', { status: pinataStatus });
  return new Response(JSON.stringify({ data: { cid: CID } }), { status: 200 });
};

let ipCounter = 0;
const call = (bytes, { origin = ORIGIN, method = 'POST', path = '/upload', ip = `10.0.0.${++ipCounter}`, field = 'file' } = {}) => {
  const body = new FormData();
  if (bytes) body.append(field, new File([bytes], 'photo'));
  return worker.fetch(
    new Request(`https://upload.test${path}`, {
      method,
      headers: { ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': ip },
      body: method === 'POST' ? body : undefined,
    }),
    env,
  );
};
const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));

// ---- fixtures ------------------------------------------------------
// A real photo with an EXIF block (900px), plus an injected fake GPS APP1 and a comment.
const photo = new Uint8Array(readFileSync(new URL('../../images/demo/19-white-leather-sneakers.jpg', import.meta.url)));
assert.ok(has(photo, 'Exif'));
const segment = (marker, text) => Buffer.concat([Buffer.from([0xff, marker, 0, text.length + 2]), Buffer.from(text, 'latin1')]);
const gps = segment(0xe1, 'Exif\0\0GPSLat:13.7');
const comment = segment(0xfe, 'secret!');
const jpeg = new Uint8Array(Buffer.concat([photo.subarray(0, 2), gps, comment, photo.subarray(2)]));

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // CRC not checked here
}
function png(w, h, extra = []) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', deflateSync(Buffer.alloc((w * 3 + 1) * h))), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}
function riffChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, 'latin1'), len, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function webp(w, h) {
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04; vp8x.writeUIntLE(w - 1, 4, 3); vp8x.writeUIntLE(h - 1, 7, 3);
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f; vp8l.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  const body = Buffer.concat([riffChunk('VP8X', vp8x), riffChunk('VP8L', vp8l), riffChunk('EXIF', Buffer.from('GPS-here', 'latin1')), riffChunk('XMP ', Buffer.from('<x:xmpmeta/>', 'latin1'))]);
  const head = Buffer.from('RIFF0000WEBP', 'latin1'); head.writeUInt32LE(body.length + 4, 4);
  return new Uint8Array(Buffer.concat([head, body]));
}

// ---- unit: sniff + strip -------------------------------------------
assert.equal(sniff(jpeg), 'image/jpeg');
assert.equal(sniff(png(2, 2)), 'image/png');
assert.equal(sniff(webp(2, 2)), 'image/webp');
assert.equal(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
assert.equal(sniff(new TextEncoder().encode('GIF89a......')), null);

let out = stripMetadata(jpeg, 'image/jpeg');
assert.ok(!has(out.bytes, 'Exif') && !has(out.bytes, 'GPSLat') && !has(out.bytes, 'secret!'));
assert.ok(has(out.bytes, 'JFIF'));
assert.equal(Math.max(out.width, out.height), 900);
// the image data after the start-of-scan marker is untouched
assert.deepEqual(out.bytes.subarray(out.bytes.length - 2), new Uint8Array([0xff, 0xd9]));

out = stripMetadata(png(3, 2, [pngChunk('tEXt', Buffer.from('Location\0Bangkok', 'latin1')), pngChunk('eXIf', Buffer.from('GPS'))]), 'image/png');
assert.deepEqual([out.width, out.height], [3, 2]);
assert.ok(!has(out.bytes, 'Bangkok') && !has(out.bytes, 'eXIf') && has(out.bytes, 'IDAT') && has(out.bytes, 'IEND'));

out = stripMetadata(webp(640, 480), 'image/webp');
assert.deepEqual([out.width, out.height], [640, 480]);
assert.ok(!has(out.bytes, 'GPS-here') && !has(out.bytes, 'xmpmeta'));
assert.equal(out.bytes[12 + 8] & 0x0c, 0); // EXIF/XMP flags cleared
assert.equal(Buffer.from(out.bytes).readUInt32LE(4), out.bytes.length - 8); // RIFF size rewritten

// ---- handler: happy path -------------------------------------------
let res = await call(jpeg);
assert.equal(res.status, 200);
assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
let body = await res.json();
assert.equal(body.cid, CID);
assert.equal(body.type, 'image/jpeg');
assert.ok(!has(pinned, 'GPSLat') && !has(pinned, 'Exif'), 'metadata must be gone before pinning');

res = await call(webp(1200, 1200));
assert.equal(res.status, 200);
assert.ok(!has(pinned, 'GPS-here'));

// ---- handler: rejections -------------------------------------------
assert.equal((await call(new TextEncoder().encode('not an image at all'))).status, 415);
assert.equal((await call(png(1600, 900))).status, 413); // too many pixels without an IMAGES binding
const big = new Uint8Array(MAX_BYTES + 10); big.set(jpeg.subarray(0, 3));
assert.equal((await call(big)).status, 413);
assert.equal((await call(jpeg.subarray(0, 40))).status, 422); // truncated
assert.equal((await call(null)).status, 400);
assert.equal((await call(jpeg, { field: 'photo' })).status, 400);

// CORS and routing
assert.equal((await call(jpeg, { origin: 'https://evil.test' })).status, 403);
assert.equal((await call(jpeg, { origin: null })).status, 403);
assert.equal((await call(null, { path: '/style' })).status, 404);
assert.equal((await call(null, { method: 'GET' })).status, 405);
res = await call(null, { method: 'OPTIONS' });
assert.equal(res.status, 204);
assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
assert.equal((await call(null, { method: 'OPTIONS', origin: 'https://evil.test' })).status, 403);

// Pinata failures and missing secret
pinataStatus = 500;
assert.equal((await call(jpeg)).status, 502);
pinataStatus = 200;
delete env.PINATA_JWT;
assert.equal((await call(jpeg)).status, 500);
env.PINATA_JWT = 'test-jwt';

// rate limit: 40 per IP per hour
for (let i = 0; i < 40; i++) assert.equal((await call(png(2, 2), { ip: '10.9.9.9' })).status, 200);
assert.equal((await call(png(2, 2), { ip: '10.9.9.9' })).status, 429);

console.log('all worker checks passed');
