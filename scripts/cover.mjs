// Generates cover.png (800x534) for gladys-nobo: plain Node, no dependency. A
// white panel heater with warm air rising, a round hub on the wall with its
// waves, and an anti-frost badge, on a warm gradient (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.6 + (y / H) * 0.4;
  return [245 - 60 * t, 200 - 90 * t, 120 - 60 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [50, 40, 40];
const red = [220, 70, 60];
const floor = [230, 220, 205];
const green = [90, 190, 120];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

// The floor, and a panel heater on its feet: white, with its fins.
box(40, 440, 760, 500, 10, floor);
box(70, 230, 470, 430, 18, white);
for (let x = 100; x <= 440; x += 28) line(x, 255, x, 405, 6, [215, 220, 228]);
box(395, 245, 455, 275, 6, dark);
disc(425, 260, 6, green);
line(110, 430, 110, 450, 10, dark);
line(430, 430, 430, 450, 10, dark);
// Warm air rising over the heater.
for (const x0 of [170, 270, 370]) {
  let previous;
  for (let y = 215; y >= 140; y -= 2) {
    const x = x0 + 10 * Math.sin(((215 - y) / 75) * 2 * Math.PI);
    if (previous) line(previous[0], previous[1], x, y, 4, red);
    previous = [x, y];
  }
}
// The hub on the wall: a round box with its light, and its waves.
disc(620, 170, 70, white);
disc(620, 170, 52, [235, 238, 242]);
disc(620, 170, 10, green);
for (const r of [95, 120, 145]) {
  for (let a = -0.6; a <= 0.6; a += 0.01) {
    set(
      Math.round(620 + r * Math.cos(a - Math.PI / 2)),
      Math.round(170 + r * Math.sin(a - Math.PI / 2)),
      white,
      0.9,
    );
  }
}
// The away mode: a snowflake (anti-frost) on a blue badge.
disc(640, 360, 55, [70, 120, 200]);
for (let k = 0; k < 3; k += 1) {
  const a = (k * Math.PI) / 3;
  line(
    640 - 38 * Math.cos(a),
    360 - 38 * Math.sin(a),
    640 + 38 * Math.cos(a),
    360 + 38 * Math.sin(a),
    6,
    white,
  );
}

disc(400, 267, 300, white, 0.04);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
