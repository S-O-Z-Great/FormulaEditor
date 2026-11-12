/**
 * 生成托盘图标（纯 Node 手写 PNG，不依赖任何图形库）
 *
 * 图形：圆角方块 + 一条横线 + 上下两个圆点 = 分数，16px 下也认得出。
 * 4 倍超采样再缩回去，避免小尺寸锯齿。
 *
 * 用法：npm run icons
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SS = 4;          // 超采样倍率
const SIZE = 32;       // 输出边长

/* ---------- 极简 PNG 编码 ---------- */

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前面加一个 filter 字节 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 画图标 ---------- */

function drawIcon(hex) {
  const W = SIZE * SS;
  const H = SIZE * SS;
  const buf = Buffer.alloc(W * H * 4);   // 全透明起步

  const rgb = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];

  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };

  // 圆角矩形（半径为边长的 25%）
  const radius = W * 0.25;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.max(radius - x, 0, x - (W - radius));
      const dy = Math.max(radius - y, 0, y - (H - radius));
      if (dx * dx + dy * dy <= radius * radius) set(x, y, rgb[0], rgb[1], rgb[2], 255);
    }
  }

  // 白色分数：横线 + 上下两点
  const white = [255, 255, 255];
  const lineY = H * 0.5;
  const lineH = H * 0.075;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inLine = y >= lineY - lineH / 2 && y <= lineY + lineH / 2 &&
                     x >= W * 0.25 && x <= W * 0.75;
      const inTop = (x - W * 0.5) ** 2 + (y - H * 0.28) ** 2 <= (W * 0.093) ** 2;
      const inBot = (x - W * 0.5) ** 2 + (y - H * 0.72) ** 2 <= (W * 0.093) ** 2;
      if (inLine || inTop || inBot) set(x, y, white[0], white[1], white[2], 255);
    }
  }

  // 4x4 盒式降采样（预乘 alpha 平均，边缘才不会发黑）
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const al = buf[i + 3] / 255;
          r += buf[i] * al;
          g += buf[i + 1] * al;
          b += buf[i + 2] * al;
          a += al;
        }
      }
      const n = SS * SS;
      const o = (y * SIZE + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }

  return encodePng(SIZE, SIZE, out);
}

const dir = path.join(__dirname, '..', 'src', 'assets');
fs.mkdirSync(dir, { recursive: true });

const pairs = [
  ['tray.png', '#185fa5'],
  ['tray-off.png', '#a8a69e']
];

for (const [name, hex] of pairs) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, drawIcon(hex));
  console.log(name + '  ' + fs.statSync(file).size + ' bytes');
}
