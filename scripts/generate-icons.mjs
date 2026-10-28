// Gera os ícones originais do Lerium (PNG RGBA) sem dependências externas.
// Uso: npm run icons
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const OUT_DIR = new URL('../public/icons/', import.meta.url);
const BACKGROUND = [0x4f, 0x46, 0xe5];
const FOREGROUND = [0xff, 0xff, 0xff];
const SUPERSAMPLE = 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profundidade de bits
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compressão
  ihdr[11] = 0; // filtro
  ihdr[12] = 0; // sem entrelaçamento

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filtro "None" por linha
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Coordenadas normalizadas (0..1).
function insideRoundedSquare(x, y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insideLetterL(x, y) {
  const stem = x >= 0.32 && x <= 0.47 && y >= 0.2 && y <= 0.8;
  const foot = x >= 0.32 && x <= 0.72 && y >= 0.65 && y <= 0.8;
  return stem || foot;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (insideRoundedSquare(x, y)) {
            if (insideLetterL(x, y)) fg += 1;
            else bg += 1;
          }
        }
      }
      const covered = bg + fg;
      const offset = (py * size + px) * 4;
      if (covered === 0) continue;
      for (let c = 0; c < 3; c += 1) {
        rgba[offset + c] = Math.round((BACKGROUND[c] * bg + FOREGROUND[c] * fg) / covered);
      }
      rgba[offset + 3] = Math.round((255 * covered) / samples);
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = new URL(`icon-${size}.png`, OUT_DIR);
  writeFileSync(file, encodePng(size, render(size)));
  process.stdout.write(`gerado public/icons/icon-${size}.png\n`);
}
