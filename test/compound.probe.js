/* 化合物回归（第 17 批）
 * 用户报的两件事：
 *   ① H₂O 里光标只能在最右边那个 O 上打转，进不了 H，也改不了那个 2；
 *   ② O₂ 后面打一个等号，删等号时把氧气一起带走了。
 * 现在槽位表是**整篇文档**的（元素右边那个外挂下标也算一格），删除按「左边那一样东西」算。 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 320 });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto('file:///E:/FormulaEditor/src/index.html', { waitUntil: 'networkidle2' });
  await wait(900);

  const reset = async () => {
    await page.evaluate(() => {
      if (window.__FE) window.__FE.endIme();
      const mf = document.getElementById('mf');
      mf.blur(); mf.value = ''; mf.focus();
    });
    await wait(150);
  };
  const type = async (text) => {
    for (const ch of text) {
      if (ch === '\t') await page.keyboard.press('Tab');
      else if (ch === '\n') await page.keyboard.press('Enter');
      else if (ch === '\b') await page.keyboard.press('Backspace');
      else await page.keyboard.type(ch);
      await wait(150);
    }
    await wait(250);
  };
  const key = async (k) => { await page.keyboard.press(k); await wait(220); };
  const state = () => page.evaluate(() => {
    const mf = document.getElementById('mf');
    const ctx = document.getElementById('ctx');
    const box = document.getElementById('slotBox');
    return {
      pos: mf.position,
      latex: window.__FE.clean(mf.getValue('latex')),
      units: window.__FE.units().length,
      fields: window.__FE.fields().length,
      ctx: ctx.hidden ? '' : ctx.textContent,
      boxHidden: box.hidden
    };
  });
  function check(name, ok, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + detail);
    if (!ok) fails.push(name + ' → ' + detail);
  }

  console.log('\n[1] H₂O：两个元素 + 一个外挂下标，都算一格');
  await reset();
  await type('$H_2$O$');
  const h2o = await state();
  check('写出两个元素', h2o.units === 2, 'units=' + h2o.units);
  check('整篇一共 9 格（H 四格 + 2 + O 四格）', h2o.fields === 9, 'fields=' + h2o.fields);
  check('导出的式子就是 H_2O', /\\mathrm\{H\}_2\\mathrm\{O\}/.test(h2o.latex), h2o.latex);

  console.log('\n[2] ← 从 O 一路走到 H（以前会在 O 里来回弹）');
  await reset();
  await type('$H_2$O$');
  await key('ArrowLeft');                 // O 电荷
  const p1 = (await state()).pos;
  await key('ArrowLeft');                 // O 质量数
  const p2 = (await state()).pos;
  await key('ArrowLeft');                 // H 后面那个 2
  const s3 = await state();
  check('← 两次走出 O', p1 > p2 && p2 > 28, p1 + ' → ' + p2);
  check('← 第三次落到 H 的 2 上', s3.pos === 26, 'pos=' + s3.pos);
  check('状态栏认得出是「个数」', /个数/.test(s3.ctx), s3.ctx);
  check('这一格有框', !s3.boxHidden, 'hidden=' + s3.boxHidden);
  await key('ArrowLeft');                 // H 电荷
  const s4 = await state();
  check('← 再按到 H 的电荷', s4.pos === 21, 'pos=' + s4.pos);
  await key('ArrowLeft');                 // H 质量数
  const s5 = await state();
  check('← 最后一格是质量数', s5.pos === 7 || s5.pos === 1, 'pos=' + s5.pos);

  console.log('\n[3] → 从 H 一路走到 O');
  await reset();
  await type('$H_2$O$');
  await page.evaluate(() => document.getElementById('mf').executeCommand(['moveToMathfieldStart']));
  await wait(200);
  const seen = [];
  for (let i = 0; i < 8; i++) {
    await key('ArrowRight');
    seen.push((await state()).pos);
  }
  check('→ 能穿过 2 走到 O 的四格', seen.indexOf(26) >= 0 && seen[seen.length - 1] > 40,
    JSON.stringify(seen));

  console.log('\n[4] Tab 也走同一张表');
  await reset();
  await type('$H_2$O$');
  await page.evaluate(() => document.getElementById('mf').executeCommand(['moveToMathfieldStart']));
  await wait(200);
  const labels = [];
  for (let i = 0; i < 9; i++) {
    await key('Tab');
    const s = await state();
    labels.push(s.ctx.replace(/退格.*$/, '').trim());
  }
  check('Tab 依次经过 质量数→质子数→个数→电荷→个数→O 的质量数',
    /质量数/.test(labels[0]) && /质子数/.test(labels[1]) && /个数/.test(labels[2]) &&
    /电荷/.test(labels[3]) && /个数/.test(labels[4]) && /质量数/.test(labels[5]),
    JSON.stringify(labels));

  console.log('\n[5] 删等号不再连氧气一起删');
  await reset();
  await type('$O$_2=');
  await type('\b');
  let s = await state();
  check('O₂ 后面删 =，只少一个等号', /^{?\\?htmlData|\\mathrm\{O\}/.test(s.latex) && /\\mathrm\{O\}/.test(s.latex) && !/=/.test(s.latex), s.latex);
  await type('\b');
  s = await state();
  check('再删一次只少那个 2', /\\mathrm\{O\}/.test(s.latex) && !/_2/.test(s.latex), s.latex);

  console.log('\n[6] 化学等号（#=）同理');
  await reset();
  await type('$O$_2#=\n');                 // #= → \;=\; 两侧留距
  await type('\b\b\b');                    // 尾空格 + 等号 + 前空格
  s = await state();
  check('删掉等号后 O₂ 还在', /\\mathrm\{O\}_2/.test(s.latex) && !/=/.test(s.latex), s.latex);

  console.log('\n[7] Tab 出去以后再打等号，退格也不许吞掉 O₂');
  await reset();
  await type('$O$_2\t\t\t\t\t');
  await type('=');
  await type('\b');
  s = await state();
  check('只删掉等号', /\\mathrm\{O\}_2/.test(s.latex) && !/=/.test(s.latex), s.latex);

  console.log('\n' + (fails.length ? '失败 ' + fails.length + ' 项' : '化合物全部正确'));
  fails.forEach((f) => console.log('  ! ' + f));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
