/* 格内逐字 + 外挂下标的归属（第 21 批）
 *
 * 用户报：「H2+ 里想改那个 2，但光标会直接从 + 的右边移动到氢气的左边，
 *          完全掠过了它；在 + 上按上箭头反而能跳进槽位。」
 *
 * 两处原因：
 *   ① 外挂下标有时不是实体的兄弟原子，而是「包着实体的外壳」的一个分支
 *      （`\htmlData{…}_{2}`），原来的 docFields 只认兄弟，这一格就成了没主的格；
 *   ② 一格里有多个字（`_{2+}`）时，方向键整格跳过，原生 ← 会一步跳出格子。
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 360 });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto('file:///E:/FormulaEditor/src/index.html', { waitUntil: 'networkidle2' });
  await wait(900);

  const reset = async () => {
    await page.evaluate(() => {
      if (window.__FE) window.__FE.endIme();
      const mf = document.getElementById('mf');
      mf.blur(); mf.value = ''; mf.focus();
    });
    await wait(160);
  };
  const type = async (text) => {
    for (const ch of text) {
      if (ch === '\t') await page.keyboard.press('Tab');
      else if (ch === '\n') await page.keyboard.press('Enter');
      else if (ch === '\b') await page.keyboard.press('Backspace');
      else await page.keyboard.type(ch);
      await wait(150);
    }
    await wait(240);
  };
  const key = async (k) => { await page.keyboard.press(k); await wait(220); };
  const pos = () => page.evaluate(() => document.getElementById('mf').position);
  const latex = () => page.evaluate(() => window.__FE.clean(document.getElementById('mf').getValue('latex')));
  const ctx = () => page.evaluate(() => {
    const e = document.getElementById('ctx');
    return e.hidden ? '' : e.textContent;
  });
  const fields = () => page.evaluate(() => window.__FE.fields());
  function check(name, ok, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + detail);
    if (!ok) fails.push(name + ' → ' + detail);
  }

  console.log('\n[1] H₂+：下标那一格归 H，不是「没主的格」');
  await reset();
  await type('$H_2+');
  const fs = await fields();
  const owners = Array.from(new Set(fs.map((f) => f.unit)));
  check('一共 5 格（H 四格 + 带 2 的那一格）', fs.length === 5, 'fields=' + fs.length);
  check('5 格都归属同一个实体', owners.length === 1 && owners[0] !== 'null', owners.join(','));
  check('下标那一格的内容是 2+', /_\{2\+\}/.test(await latex()), await latex());

  console.log('\n[2] 光标停在 + 后面，状态栏认得出这是「个数」那一格');
  const c0 = await ctx();
  check('状态栏写着元素 H 的个数格', /元素\s*H/.test(c0) && /个数/.test(c0), c0);

  console.log('\n[3] ← 一次先到 2，不再一步掠过整格');
  const last = fs[fs.length - 1];
  const two = Math.min.apply(null, last.leaves);      // 2 的右边界
  const p0 = await pos();
  await key('ArrowLeft');
  const p1 = await pos();
  check('第一次 ← 落在 2 后面', p1 === two, 'from ' + p0 + ' → ' + p1 + '（2 在 ' + two + '）');
  await key('ArrowLeft');
  const p2 = await pos();
  check('再 ← 才出格，到 H 的电荷格', p2 !== p1 && p2 < p1, '→ ' + p2);

  console.log('\n[4] 在 2 后面退格：只少那个 2，H 还在');
  await reset();
  await type('$H_2+');
  const f4 = (await fields());
  const two4 = Math.min.apply(null, f4[f4.length - 1].leaves);
  await key('ArrowLeft');
  check('已停在 2 后面', (await pos()) === two4, 'pos=' + await pos());
  await key('Backspace');
  const l4 = await latex();
  check('2 没了、H 还在', !/_\{2/.test(l4) && /\\mathrm\{H\}/.test(l4), l4);

  console.log('\n[5] 元素四格照旧：→ 逐格前进，四格都经过');
  await reset();
  await type('$Cu ');
  for (let i = 0; i < 10; i++) {                // 先一路 ← 回到实体最左
    const a = await pos();
    await key('ArrowLeft');
    if ((await pos()) === a) break;
  }
  const seq = [];
  for (let i = 0; i < 7; i++) {
    seq.push(await pos());
    await key('ArrowRight');
  }
  const asc = seq.every((v, i) => i === 0 || v >= seq[i - 1]);
  check('→ 一路向前，不走回头路', asc, seq.join(' → '));
  check('四格都经过（≥5 个落脚点）', new Set(seq).size >= 5, 'uniq=' + new Set(seq).size);

  console.log('\n[6] 分式分子里两个字：← 也逐字走');
  await reset();
  await type('#--\t');
  await type('ab');
  const l6a = await latex();
  const q0 = await pos();
  await key('ArrowLeft');
  const q1 = await pos();
  check('分子里确实进了 ab', /\\frac\{(ab|a|b)/.test(l6a), l6a);
  check('← 停在 a 后面（没有一步跳到分子左边之外）', q1 === q0 - 1, 'pos ' + q0 + ' → ' + q1);

  console.log('\n[7] 在最后一格后面起新元素：不许嵌进旧块');
  await reset();
  await type('$Cu ');
  await key('Tab');
  await type('14');
  await key('Tab');
  await type('29');
  await key('Tab');
  await key('Tab');
  await type('+');            // 落在电荷格 → Cu⁺
  await type('$O ');
  const u7 = await page.evaluate(() => window.__FE.units().map((u) => [u.start, u.end]));
  check('两个实体各管各的（不嵌套）', u7.length === 2 && u7[0][1] <= u7[1][0], JSON.stringify(u7));
  const l7 = await latex();
  check('导出就是 Cu⁺ 与 O 两块', /\\mathrm\{Cu\}/.test(l7) && /\\mathrm\{O\}/.test(l7), l7);

  console.log('\n[8] 贴着实体左边界开新元素：落在左边，不是被甩到右边');
  await reset();
  await type('$Cu ');
  for (let i = 0; i < 12; i++) {
    const a = await pos();
    await key('ArrowLeft');
    if ((await pos()) === a) break;
  }
  const u8a = await page.evaluate(() => window.__FE.units().map((u) => [u.start, u.end]));
  await type('$O ');
  const u8 = await page.evaluate(() => window.__FE.units().map((u) => [u.start, u.end]));
  check('左边界上确实是新元素在前', u8.length === 2 && u8[0][0] <= 1, JSON.stringify(u8) + ' / 原位 ' + JSON.stringify(u8a));
  const l8 = await latex();
  check('导出顺序是 O 在前、Cu 在后', l8.indexOf('O') < l8.indexOf('Cu'), l8);

  console.log(fails.length ? '\n失败 ' + fails.length + ' 项' : '\n格内导航全部正确');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
