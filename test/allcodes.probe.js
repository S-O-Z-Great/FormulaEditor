/* 全量回归：把符号表里每个触发码用真实键盘敲一遍，检查 # 前缀有没有漏进公式 */
const puppeteer = require('puppeteer-core');
const E = require('../src/engine.js');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.goto('file:///E:/FormulaEditor/src/index.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));

  const codes = E.SYMBOLS.FLAT.map(e => e.t);
  // 这几个字符在美式键盘布局里发不出 keydown（puppeteer 只能 insertText），
  // 敲 # 之后字符进不了待定缓冲，测出来必然是「残留 #」。它们的解析在 npm test 里覆盖：
  //   · 点乘 → 有 .* 备用码；Σ / Θ 是二次解析的第二遍码，正常由 ##Sigma 走，不靠手敲
  const NO_KEY = /[·ΣΘ]/;
  const skipped = codes.filter(c => NO_KEY.test(c));
  const runnable = codes.filter(c => !NO_KEY.test(c));
  // `text` 会把 MathLive 切到文本模式，影响紧随其后的用例，放到最后单独测
  runnable.sort((a, b) => (a === 'text' ? 1 : 0) - (b === 'text' ? 1 : 0));
  const fails = [];
  const samples = [];
  const only = process.env.ONLY;

  for (const code of runnable) {
    if (only && code.indexOf(only) < 0) continue;
    await page.evaluate(() => { const mf = document.getElementById('mf'); mf.blur(); mf.value = ''; mf.focus(); mf.executeCommand(['moveToMathfieldStart']); });
    await new Promise(r => setTimeout(r, 40));
    await page.keyboard.type('#' + code, { delay: 6 });
    await new Promise(r => setTimeout(r, 30));
    await page.keyboard.press('Space');
    await new Promise(r => setTimeout(r, 50));
    const v = await page.evaluate(() => document.getElementById('mf').getValue('latex'));

    // 已知：空的文本盒（\text{}）serialize 为空，且不接受直接输入，单独放行
    if (v.includes('\\#')) fails.push(code + ' → 残留 # : ' + JSON.stringify(v));
    else if (!v.trim() && code !== 'text') fails.push(code + ' → 空结果');
    if (samples.length < 6) samples.push(code + ' → ' + v);
  }

  console.log('样例：');
  samples.forEach(s => console.log('  ' + s));
  console.log('\n共测 ' + runnable.length + ' 个触发码，失败 ' + fails.length + ' 个');
  if (skipped.length) console.log('跳过 ' + skipped.length + ' 个（键盘布局发不出）：' + skipped.join(' '));
  fails.slice(0, 20).forEach(f => console.log('  ✗ ' + f));

  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
