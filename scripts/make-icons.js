// Makes the app icon and the menu bar (tray) icon from the idle frame in the sprite sheet.
// Run: npm run icons   (writes assets/icon.png, assets/trayTemplate.png, assets/trayTemplate@2x.png)
// Plain Node, no dependencies: a minimal PNG reader/writer for 8-bit RGBA images.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const SHEET = path.join(ROOT, 'Bot', 'spritesheet-x1.png');
const OUT = path.join(ROOT, 'assets');

function readPng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let width, height;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error(`${file}: expected 8-bit RGBA, not interlaced`);
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, px };
}

function writePng(file, { width, height, px }) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

function blank(width, height) {
  return { width, height, px: Buffer.alloc(width * height * 4) };
}

const sheet = readPng(SHEET);
const at = (img, x, y) => (y * img.width + x) * 4;
// The idle animation's first frame: row 0, column 0, 48x52.
const idle = blank(48, 52);
for (let y = 0; y < 52; y++) sheet.px.copy(idle.px, at(idle, 0, y), at(sheet, 0, y), at(sheet, 48, y));

// App icon: the idle frame at 16x (nearest neighbour, so the pixels stay sharp), centred.
{
  const scale = 16;
  const icon = blank(1024, 1024);
  const ox = (1024 - 48 * scale) / 2;
  const oy = (1024 - 52 * scale) / 2;
  for (let y = 0; y < 52 * scale; y++) {
    for (let x = 0; x < 48 * scale; x++) {
      idle.px.copy(icon.px, at(icon, ox + x, oy + y), at(idle, Math.floor(x / scale), Math.floor(y / scale)), at(idle, Math.floor(x / scale), Math.floor(y / scale)) + 4);
    }
  }
  writePng(path.join(OUT, 'icon.png'), icon);
}

// Tray icon: Terra's head (antenna and ears included) as a macOS template image, which
// is black plus alpha only, so macOS can tint it for light and dark menu bars. The screen
// is cut out and the eyes kept, so it still reads as Terra's face. One sprite pixel is one
// pixel of the @2x image (20x16 pt in the menu bar).
{
  const SCREEN = new Set(['23,19,31', '53,42,71']); // the screen's fill (#17131f) and its highlight (#352a47)
  const box = { x: 5, y: 3, width: 38, height: 30 };
  const big = blank(box.width + 2, box.height + 2); // 1 px of padding all round
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const i = at(idle, box.x + x, box.y + y);
      const [r, g, b, a] = idle.px.subarray(i, i + 4);
      if (!a || SCREEN.has(`${r},${g},${b}`)) continue;
      big.px.set([0, 0, 0, 255], at(big, x + 1, y + 1));
    }
  }
  writePng(path.join(OUT, 'trayTemplate@2x.png'), big);
  const small = blank(big.width / 2, big.height / 2);
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
      let alpha = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) alpha += big.px[at(big, x * 2 + dx, y * 2 + dy) + 3];
      small.px.set([0, 0, 0, Math.round(alpha / 4)], at(small, x, y));
    }
  }
  writePng(path.join(OUT, 'trayTemplate.png'), small);
}

console.log(`Wrote ${['icon.png', 'trayTemplate.png', 'trayTemplate@2x.png'].map((n) => path.join('assets', n)).join(', ')}`);
