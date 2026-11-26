// Generates build/icon.png (512x512) with no dependencies: a dark tile with a workout profile.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const N = 512;
const px = Buffer.alloc(N * N * 4);
const set = (x, y, [r, g, b, a = 255]) => {
  const i = (y * N + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
};
const R = 96;
const inside = (x, y) => {
  const cx = Math.min(Math.max(x, R), N - 1 - R);
  const cy = Math.min(Math.max(y, R), N - 1 - R);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
};
// Bars: [left, right, height fraction, colour]
const bars = [
  [70, 150, 0.3, [74, 158, 218]],
  [160, 230, 0.62, [230, 194, 41]],
  [240, 270, 0.25, [124, 135, 148]],
  [280, 350, 0.72, [240, 138, 36]],
  [360, 390, 0.25, [124, 135, 148]],
  [400, 442, 0.85, [229, 72, 77]],
];
const base = 420;
const top = 110;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (!inside(x, y)) { set(x, y, [0, 0, 0, 0]); continue; }
    let c = [20, 23, 28];
    for (const [l, r, h, col] of bars) {
      if (x >= l && x < r && y <= base && y >= base - h * (base - top)) c = col;
    }
    if (y > base && y <= base + 10 && x >= 70 && x < 442) c = [232, 234, 237];
    set(x, y, c);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('build/icon.png written');
