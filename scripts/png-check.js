/* 出图规格自检：看「贴进文档后到底多大」
 *
 *   npm run png:check
 *
 * 打印每条公式的像素尺寸 / DPI / 在文档里的显示尺寸（pt）。
 * 改过 snip.js 的排版或 DPI 之后跑一次，比肉眼看图靠谱。
 * 第一张图会落到 test/_png.png。
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const snip = require('../src/lib/snip');

const CASES = [
  { latex: '\\mathrm{H_2SO_4}' },
  { latex: '\\frac{1}{2}' },
  { latex: 'x^2+y^2=z^2' },
  { latex: '\\int_0^1 f(x)\\,dx = F(1)-F(0)' },
  { latex: '1' }
];

app.whenReady().then(async function () {
  const out = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    for (const pt of [10.5, 12]) {
      const r = await snip.render(c.latex, { pt: pt, bg: 'white' });
      if (!r) { out.push({ latex: c.latex, pt: pt, error: 'render failed' }); continue; }
      const dpi = r.dpi || 96;
      out.push({
        latex: c.latex,
        pt: pt,
        px: r.width + 'x' + r.height,
        dpi: Math.round(dpi),
        // 显示尺寸 = 像素 / dpi × 72；正文 10.5pt 的行高约 13.6pt，图片高接近它就说明贴进去不撑行
        showH: +(r.height / dpi * 72).toFixed(1),
        showW: +(r.width / dpi * 72).toFixed(1)
      });
      if (i === 1 && pt === 10.5) {
        fs.writeFileSync(path.join(__dirname, '..', 'test', '_png.png'), r.png);
      }
    }
  }
  console.log(JSON.stringify(out, null, 1));
  snip.destroy();
  app.quit();
});
