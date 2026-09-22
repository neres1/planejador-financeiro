// Gera os ícones PNG do app (sem dependências): `node tools/make-icons.mjs`
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const SS = 4; // supersampling para bordas suaves
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const [pr, pg, pb] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        r += pr; g += pg; b += pb;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r / SS / SS; raw[o + 1] = g / SS / SS; raw[o + 2] = b / SS / SS; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const inRoundRect = (u, v, x0, y0, x1, y1, r) => {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r), cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
};

// Fundo verde em degradê, três barras brancas crescentes e uma moeda.
function pixel(u, v) {
  const t = (u + v) / 2;
  const bg = [28 + (15 - 28) * t, 194 + (161 - 194) * t, 159 + (132 - 159) * t];
  const white = [255, 255, 255];
  const bars = [[0.22, 0.56], [0.42, 0.44], [0.62, 0.30]];
  for (const [x, top] of bars) if (inRoundRect(u, v, x, top, x + 0.15, 0.78, 0.035)) return white;
  if ((u - 0.735) ** 2 + (v - 0.19) ** 2 <= 0.075 ** 2) return [255, 214, 102];
  return bg;
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const s of [180, 192, 512]) writeFileSync(new URL(`../icons/icon-${s}.png`, import.meta.url), png(s, pixel));
console.log('ícones gerados');
