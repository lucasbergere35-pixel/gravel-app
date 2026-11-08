/**
 * Génère les icônes PNG de l'appli (sans dépendance externe) dans public/.
 * Même dessin que public/favicon.svg : montagnes, soleil, chemin de gravier.
 * Lancer : npm run icons
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// ---------- Encodage PNG minimal ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 2; // RVB, sans transparence (exigé par iOS pour apple-touch-icon)
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Dessin (coordonnées 0..100 comme le SVG) ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const BG = hex('#1b3a2b');
const SUN = hex('#f5a623');
const BACK = hex('#8fb59a');
const FRONT = hex('#e9e4d4');
const GROUND = hex('#b8955a');

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = s(px, py, ax, ay, bx, by);
  const d2 = s(px, py, bx, by, cx, cy);
  const d3 = s(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function colorAt(x, y) {
  if (y >= 78) return GROUND;
  if (inTriangle(x, y, [5, 80], [36, 45], [67, 80])) return FRONT;
  if (inTriangle(x, y, [18, 78], [52, 30], [86, 78])) return BACK;
  if ((x - 70) ** 2 + (y - 30) ** 2 <= 11 ** 2) return SUN;
  return BG;
}

/** padding = marge (fraction) autour du dessin, pour les icônes « maskable ». */
function render(size, padding = 0) {
  const SS = 4; // sur-échantillonnage 4×4 pour lisser les bords
  const out = Buffer.alloc(size * size * 3);
  const inner = 1 - 2 * padding;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((px + (sx + 0.5) / SS) / size - padding) / inner;
          const v = ((py + (sy + 0.5) / SS) / size - padding) / inner;
          const c = u < 0 || u > 1 || v < 0 || v > 1 ? (v > 1 ? GROUND : BG) : colorAt(u * 100, v * 100);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (py * size + px) * 3;
      out[i] = Math.round(r / (SS * SS));
      out[i + 1] = Math.round(g / (SS * SS));
      out[i + 2] = Math.round(b / (SS * SS));
    }
  }
  return encodePng(size, out);
}

mkdirSync('public', { recursive: true });
const icons = [
  ['public/icon-192.png', 192, 0],
  ['public/icon-512.png', 512, 0],
  ['public/icon-512-maskable.png', 512, 0.12],
  ['public/apple-touch-icon.png', 180, 0],
];
for (const [file, size, padding] of icons) {
  writeFileSync(file, render(size, padding));
  console.log('✔', file);
}
