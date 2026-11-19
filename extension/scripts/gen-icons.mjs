// Generates static/icons/icon-{16,32,48,128}.png: a #0572EC rounded square with a white key.
// Geometry matches LOGO in src/ui/icons.ts (128×128 units). Pure Node: zlib + a tiny PNG writer.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "icons");
const BLUE = [0x05, 0x72, 0xec];
const WHITE = [0xff, 0xff, 0xff];
const SAMPLES = 8;

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const dx = Math.max(x + r - px, 0, px - (x + w - r));
  const dy = Math.max(y + r - py, 0, py - (y + h - r));
  return dx * dx + dy * dy <= r * r;
}

function inCircle(px, py, cx, cy, r) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** Colour at a point in 128-unit space, or null when transparent. */
function sample(px, py) {
  if (!inRoundRect(px, py, 0, 0, 128, 128, 28)) return null;
  if (inCircle(px, py, 46, 64, 9)) return BLUE;
  const key =
    inCircle(px, py, 46, 64, 24) ||
    inRoundRect(px, py, 62, 57, 44, 14, 3) ||
    inRoundRect(px, py, 90, 66, 12, 18, 2) ||
    inRoundRect(px, py, 76, 66, 10, 13, 2);
  return key ? WHITE : BLUE;
}

function render(size) {
  const rgba = new Uint8Array(size * size * 4);
  const scale = 128 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = sample((x + (sx + 0.5) / SAMPLES) * scale, (y + (sy + 0.5) / SAMPLES) * scale);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255);
      }
    }
  }
  return rgba;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `icon-${size}.png`);
  await writeFile(file, png(size, render(size)));
  console.log(`wrote ${file}`);
}
