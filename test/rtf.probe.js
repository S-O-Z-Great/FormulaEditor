/* RTF 粘贴实验：把「公式的 RTF 表示」放进剪贴板，粘进 WPS，截图看它变成什么。
 *
 * 目的：纯文本模式下，用户要的是 WPS/Word 自己的公式（可编辑），不是图片。
 * Electron 的剪贴板只能写 text/html，而 Office 的 HTML 导入器不做数学转换，
 * 所以改走 RTF —— Office 对 RTF 的解析完整得多。
 *
 * 用法：node scripts/run-electron.js test/rtf.probe.js [case]
 *       case = eq（EQ 域）| omml（RTF 数学组）| both（默认）
 */
const { app, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const paster = require('../src/lib/paste');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(__dirname, '_rtf');
const TARGET = '_wpsprobe';

const FONT = '{\\rtf1\\ansi\\ansicpg936\\deff0{\\fonttbl{\\f0\\fnil\\fcharset0 Cambria Math;}{\\f1\\fnil\\fcharset0 Calibri;}}\\pard\\f1\\fs21 ';

/* EQ 域：Word/WPS 从 2.0 就有的公式域。
 * \f(a,b) 分式  \r(n,x) 根号  \s\doN() 下标  \s\upN() 上标  \i\su(a,b,) 求和 */
function eqRtf() {
  const frac = '{\\field{\\*\\fldinst {EQ \\\\f(1,2)}}{\\fldrslt {1/2}}}';
  const chem = '{\\field{\\*\\fldinst {EQ H\\\\s\\\\do2(2)SO\\\\s\\\\do4(4)}}{\\fldrslt {H2SO4}}}';
  return FONT + 'A: ' + frac + '   B: ' + chem + '\\par}';
}

/* RTF 数学组（RTF 1.9.1 / Word 2007+）：\moMath 里放 OMML 的字符序列。
 * 语法没有公开的完整样例，这里按 Word 导出 RTF 的常见形态手写最小用例。 */
function ommlRtf() {
  const m = '{\\*\\moMath{\\mmathPr\\mwrapIndent1440\\margl1440}'
    + '{\\mfrac{\\mnum 1}{\\mden 2}}}';
  return FONT + 'C: ' + m + '\\par}';
}

(async function main() {
  await app.whenReady();
  const argCase = (process.argv.find((a) => a.indexOf('--case=') === 0) || '--case=both').slice(7);
  // --file=<rtf>：不生成用例，直接粘这个文件（调 RTF 语法时用）
  const fileArg = process.argv.find((a) => a.indexOf('--file=') === 0);
  const outName = fileArg ? 'custom' : '';
  const res = { cases: {}, steps: [] };

  await paster.warmup();
  const found = await paster.find(TARGET);
  res.found = found;
  if (!found.hwnd) {
    console.log(JSON.stringify({ error: '找不到 ' + TARGET + ' 窗口', found }, null, 1));
    paster.stop();
    app.exit(0);
    return;
  }

  const cases = fileArg ? ['custom'] : (argCase === 'both' ? ['eq', 'omml'] : [argCase]);
  for (const c of cases) {
    const file = fileArg ? fileArg.slice(7) : path.join(OUT, '_' + c + '.rtf');
    fs.mkdirSync(OUT, { recursive: true });
    if (!fileArg) fs.writeFileSync(file, c === 'eq' ? eqRtf() : ommlRtf(), 'utf8');

    const wrote = await paster.setClip('rtf', file);
    const formats = await paster.clip();
    res.cases[c] = { wrote, formats };
    res.steps.push(c + ': setclip=' + wrote + ' formats=' + formats);
    if (!wrote) continue;

    const focused = await paster.focus(found.hwnd);
    res.cases[c].focused = focused;
    await delay(600);
    const pasted = await paster.paste(found.hwnd);
    res.cases[c].pasted = pasted;
    await delay(2600);

    try {
      const srcs = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 2400, height: 1400 }
      });
      const hit = srcs.find((s) => /WPS|Word|文字文稿/i.test(s.name)) || srcs[0];
      if (hit) {
        const png = path.join(OUT, '_' + c + '.png');
        fs.writeFileSync(png, hit.thumbnail.toPNG());
        res.cases[c].shot = png;
      }
    } catch (e) {
      res.cases[c].shotError = String(e);
    }

    await delay(300);
    res.cases[c].undone = await paster.undo();
    await delay(1200);
  }

  console.log(JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(OUT, '_result.json'), JSON.stringify(res, null, 1));
  paster.stop();
  app.exit(0);
})();
