#!/usr/bin/env node
// gen-icon.mjs — dependency-free macOS app icon generator.
//
// Draws the Eaon Desktop icon: a full-bleed rounded square ("terminal prompt on a
// deep space gradient") — vertical indigo->teal gradient, soft radial highlight
// top-left, a bold white chevron prompt glyph, and a thin accent-cyan baseline.
// Rendered at 2048x2048 (2x supersample) then box-filter downsampled to
// 1024x1024, so edges and the rounded corners stay crisp. Writes RGBA PNG
// (rounded corners need an alpha channel) using only node:zlib + a hand-rolled
// PNG encoder with a CRC-32 table.
//
// Uses: node >= 18, macOS or Linux (macOS only needs to also run make-icns.sh).

import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OUT_SIZE = 1024;          // final PNG size
const RENDER = OUT_SIZE * 2;    // supersampled draw size (2048)
const CENTER = RENDER / 2;      // 1024

// Palette (tasteful, "deep space" order: ink indigo -> teal).
const TOP = [0x25, 0x1e, 0x4a];   // #251e4a
const BOT = [0x0e, 0x7c, 0x8f];   // #0e7c8f
const GLYPH = [255, 255, 255];    // prompt chevron
const ACCENT = [0x35, 0xe4, 0xc2]; // underline accent cyan
const HILITE = [0xd9, 0xe8, 0xff]; // radial highlight tint

const RADIUS = 185 * 2;             // rounded-rect corner radius at 2048
const EDGE = CENTER - RADIUS;       // straight-edge half extent
const CHE_VIS_OPACITY = 0.92;       // glyph opacity
const ACCENT_OPACITY = 0.95;        // underline opacity

// Glyph geometry (1024-space coords; scaled by 2 at render time):
// a heavy > chevron, two thick bars meeting at a tip on the right.
const GX0 = 214;       // left edge of both bars
const GX1 = 762;       // tip x
const GY  = 512 - 205; // upper bar centerline y
const GT  = 62;        // bar thickness
const UNDERLINE = { x: 512, y: 806, hw: 112, hh: 3 }; // accent bar

const HIGHLIGHT = { x: 0.34 * RENDER, y: 0.27 * RENDER, r: 0.68 * RENDER };

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp  = (a, b, t) => a + (b - a) * t;

function rectSDF(x, y) {
  const qx = Math.abs(x - CENTER) - EDGE;
  const qy = Math.abs(y - CENTER) - EDGE;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - RADIUS;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

// Closest signed distance to the chevron stroke skeleton, minus half thickness.
function chevronSDF(x, y, s) {
  const x0 = GX0 * s;
  const y1 = GY * s;
  const x1 = GX1 * s;
  const cy = CENTER;
  const top = distSeg(x, y, x0, y1, x1, cy);
  const bot = distSeg(x, y, x0, RENDER - y1, x1, cy);
  return Math.min(top, bot) - (GT * s) / 2;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const buf = new Float32Array(RENDER * RENDER * 4);

  for (let y = 0; y < RENDER; y++) {
    const grad = y / RENDER; // 0 at top -> 1 at bottom
    const rTop = lerp(TOP[0], BOT[0], grad);
    const gTop = lerp(TOP[1], BOT[1], grad);
    const bTop = lerp(TOP[2], BOT[2], grad);

    for (let x = 0; x < RENDER; x++) {
      const i = (y * RENDER + x) * 4;
      let a = clamp(1 - rectSDF(x, y), 0, 1);
      buf[i + 3] = a;
      if (a <= 0) continue;

      // Base vertical gradient.
      let r = rTop;
      let g = gTop;
      let b = bTop;

      // Soft radial highlight, top-left.
      const hd = Math.hypot(x - HIGHLIGHT.x, y - HIGHLIGHT.y) / HIGHLIGHT.r;
      const hw = hd < 1 ? (1 - hd) * (1 - hd) : 0;
      if (hw > 0) {
        const h = hw * 0.32;
        r = lerp(r, HILITE[0], h);
        g = lerp(g, HILITE[1], h);
        b = lerp(b, HILITE[2], h);
      }

      // Prompt chevron: white at 92% opacity.
      const cs = chevronSDF(x, y, 2);
      const cg = clamp(GT - cs, 0, 1);
      if (cg > 0) {
        const w = cg * CHE_VIS_OPACITY;
        r = lerp(r, GLYPH[0], w);
        g = lerp(g, GLYPH[1], w);
        b = lerp(b, GLYPH[2], w);
      }

      // Accent underline.
      const ux = x - UNDERLINE.x * 2;
      const uy = y - UNDERLINE.y * 2;
      const u = clamp(1 - Math.max(Math.abs(ux) - UNDERLINE.hw, Math.abs(uy) - UNDERLINE.hh), 0, 1);
      if (u > 0) {
        const w = u * ACCENT_OPACITY;
        r = lerp(r, ACCENT[0], w);
        g = lerp(g, ACCENT[1], w);
        b = lerp(b, ACCENT[2], w);
      }

      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Box-filter downscale (4-to-1 average over each 2x2 block)
// ---------------------------------------------------------------------------

function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const sx = sw / dw;
  const sy = sh / dh;
  let o = 0;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * sy);
    const y1 = Math.min(sh, Math.ceil((dy + 1) * sy));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * sx);
      const x1 = Math.min(sw, Math.ceil((dx + 1) * sx));
      let r = 0;
      let gg = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          r += src[i];
          gg += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          n++;
        }
      }
      out[o++] = (r / n) | 0;
      out[o++] = (gg / n) | 0;
      out[o++] = (b / n) | 0;
      out[o++] = (a / n) | 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder: IHDR / IDAT / IEND with CRC-32
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([head, typeBuf, data, crc]);
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: None
    rgba.copy(raw, o, y * stride, (y + 1) * stride);
    o += stride;
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
const outPath = path.join(buildDir, 'icon.png');

const hi = render();
const lo = resample(hi, RENDER, RENDER, OUT_SIZE, OUT_SIZE);
fs.writeFileSync(outPath, encodePng(lo, OUT_SIZE, OUT_SIZE));

console.log('icon.png written');