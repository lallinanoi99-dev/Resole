// Resole photo upload — one endpoint, POST /upload (multipart form, field "file").
// Checks type and size, strips location and other metadata, then pins the image to IPFS via Pinata.
// The Pinata JWT is a Worker secret, so it never reaches the browser. Pins are never removed.

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_SIDE = 1200;
const RATE_LIMIT = 40; // uploads per IP per window (a listing has up to 3 photos)
const RATE_WINDOW_MS = 60 * 60 * 1000;
const PINATA_UPLOAD = 'https://uploads.pinata.cloud/v3/files';

// Per-isolate fallback counter, used when no KV namespace is bound as RATE_KV.
const memoryHits = new Map();

async function overLimit(env, ip) {
  const bucket = Math.floor(Date.now() / RATE_WINDOW_MS);
  const key = `rl:${ip}:${bucket}`;
  if (env.RATE_KV) {
    const count = Number(await env.RATE_KV.get(key)) || 0;
    if (count >= RATE_LIMIT) return true;
    await env.RATE_KV.put(key, String(count + 1), { expirationTtl: 2 * 60 * 60 });
    return false;
  }
  for (const k of memoryHits.keys()) if (!k.endsWith(`:${bucket}`)) memoryHits.delete(k);
  const count = memoryHits.get(key) || 0;
  if (count >= RATE_LIMIT) return true;
  memoryHits.set(key, count + 1);
  return false;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin && allowed.includes(origin) ? origin : null;
}

function json(body, status, origin) {
  const headers = { 'Content-Type': 'application/json', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

// ------------------------------------------------------------------
// Image sniffing and metadata stripping (JPEG, PNG, WebP)
// ------------------------------------------------------------------

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);
const u24le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

export function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a) return 'image/png';
  if (b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// JPEG: drop APP1 (EXIF/XMP, where GPS lives), APP3–APP13 (IPTC etc.), APP15 and comments.
// Keep APP0 (JFIF), APP2 (ICC colour profile) and APP14 (Adobe colour transform) so colours stay right.
function stripJpeg(b) {
  const parts = [b.subarray(0, 2)];
  let width = 0, height = 0;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error('bad_jpeg');
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = u16be(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) throw new Error('bad_jpeg');
    const seg = b.subarray(i, i + 2 + len);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && !width) { height = u16be(b, i + 5); width = u16be(b, i + 7); }
    if (marker === 0xda) { parts.push(b.subarray(i)); break; } // start of scan: the rest is image data
    const drop = marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2 && marker !== 0xee);
    if (!drop) parts.push(seg);
    i += 2 + len;
  }
  if (!width || !height) throw new Error('bad_jpeg');
  return { bytes: concat(parts), width, height };
}

// PNG: drop text, time and EXIF chunks; keep everything needed to draw the image.
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']);
function stripPng(b) {
  const parts = [b.subarray(0, 8)];
  let width = 0, height = 0;
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) throw new Error('bad_png');
    if (type === 'IHDR') { width = u32be(b, i + 8); height = u32be(b, i + 12); }
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  if (!width || !height) throw new Error('bad_png');
  return { bytes: concat(parts), width, height };
}

// WebP: drop EXIF and XMP chunks and clear their flags in the VP8X header.
function stripWebp(b) {
  const chunks = [];
  let width = 0, height = 0;
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = u32le(b, i + 4);
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > b.length) throw new Error('bad_webp');
    const chunk = b.slice(i, Math.min(end, b.length));
    if (type === 'VP8X') {
      chunk[8] &= ~(0x08 | 0x04); // EXIF and XMP flags
      width = u24le(chunk, 12) + 1;
      height = u24le(chunk, 15) + 1;
    } else if (type === 'VP8 ' && !width) {
      width = u16le(chunk, 14) & 0x3fff; // after the 3-byte frame tag and 3-byte start code
      height = u16le(chunk, 16) & 0x3fff;
    } else if (type === 'VP8L' && !width) {
      const bits = u32le(chunk, 9);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    if (type !== 'EXIF' && type !== 'XMP ') chunks.push(chunk);
    i = end;
  }
  if (!width || !height) throw new Error('bad_webp');
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  const size = body.length + 4;
  header[4] = size & 0xff; header[5] = (size >> 8) & 0xff; header[6] = (size >> 16) & 0xff; header[7] = (size >>> 24) & 0xff;
  return { bytes: concat([header, body]), width, height };
}

export function stripMetadata(bytes, type) {
  if (type === 'image/jpeg') return stripJpeg(bytes);
  if (type === 'image/png') return stripPng(bytes);
  return stripWebp(bytes);
}

// Optional: with a Cloudflare Images binding (IMAGES), oversized photos are scaled down to 1200px
// and re-encoded (which also drops metadata). Without it, the site already resizes before upload,
// so anything larger is rejected.
async function resizeWithImages(env, bytes) {
  const out = await env.IMAGES.input(new Blob([bytes]).stream())
    .transform({ width: MAX_SIDE, height: MAX_SIDE, fit: 'scale-down' })
    .output({ format: 'image/webp', quality: 85 });
  return new Uint8Array(await out.response().arrayBuffer());
}

// ------------------------------------------------------------------
// Upload
// ------------------------------------------------------------------

async function pin(env, bytes, type) {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
  const form = new FormData();
  form.append('file', new File([bytes], `resole-${Date.now()}.${ext}`, { type }));
  form.append('network', 'public');
  const res = await fetch(PINATA_UPLOAD, { method: 'POST', headers: { Authorization: `Bearer ${env.PINATA_JWT}` }, body: form });
  if (!res.ok) throw new Error(`pinata ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const cid = (await res.json())?.data?.cid;
  if (typeof cid !== 'string' || !/^[a-zA-Z0-9]{40,100}$/.test(cid)) throw new Error('pinata returned no cid');
  return cid;
}

async function upload(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overLimit(env, ip)) return json({ error: 'rate_limited' }, 429, origin);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES + 64 * 1024) return json({ error: 'too_large' }, 413, origin);

  let file;
  try {
    file = (await request.formData()).get('file');
  } catch {
    return json({ error: 'bad_request' }, 400, origin);
  }
  if (!file || typeof file === 'string') return json({ error: 'bad_request' }, 400, origin);
  if (file.size > MAX_BYTES) return json({ error: 'too_large' }, 413, origin);

  let bytes = new Uint8Array(await file.arrayBuffer());
  let type = sniff(bytes);
  if (!type) return json({ error: 'bad_type' }, 415, origin);

  let image;
  try {
    image = stripMetadata(bytes, type);
    if (Math.max(image.width, image.height) > MAX_SIDE) {
      if (!env.IMAGES) return json({ error: 'too_many_pixels', max: MAX_SIDE }, 413, origin);
      bytes = await resizeWithImages(env, image.bytes);
      type = 'image/webp';
      image = stripMetadata(bytes, type);
    }
  } catch (error) {
    console.error('image error', error.message);
    return json({ error: 'bad_image' }, 422, origin);
  }

  if (!env.PINATA_JWT) return json({ error: 'not_configured' }, 500, origin);
  try {
    const cid = await pin(env, image.bytes, type);
    return json({ cid, type, width: image.width, height: image.height, bytes: image.bytes.length }, 200, origin);
  } catch (error) {
    console.error('pin error', error.message);
    return json({ error: 'pin_failed' }, 502, origin);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (url.pathname !== '/upload') return json({ error: 'not_found' }, 404, origin);
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    if (!origin) return json({ error: 'origin_not_allowed' }, 403, null);
    return upload(request, env, origin);
  },
};
