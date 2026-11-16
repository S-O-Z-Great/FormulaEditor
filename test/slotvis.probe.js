/* 空槽显隐回归：槽只在光标进入该整体时才露出来
 *
 *   [1] 元素：创建后（光标在外）四个槽全藏、整体变窄
 *   [2] Tab 进整体 → 四个槽全露，整体变宽
 *   [3] 填两格再移出 → 已填的照常显示，没填的藏起来
 *   [4] 变量：光标在外时正上方那个槽也藏
 *   [5] 结构符号：插入后光标落在槽里 → 露；移出 → 藏
 *   [6] H₂O 串联：整体紧凑，导出仍是 \mathrm{H}_2\mathrm{O}
 */
const puppeteer = require('puppeteer-core');

const path = require('node:path');
// 页面地址按探针自己的位置算：项目拷到任何盘符 / 目录都能跑
const FE_PAGE = 'file:///' + path.resolve(__dirname, '..', 'src', 'index.html').replace(/\\/g, '/');
const EDGE = process.env.FE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 780, height: 300 });
  await page.goto(FE_PAGE, { waitUntil: 'networkidle2' });
  await wait(900);

  const fails = [];
  const reset = async () => {
    await page.evaluate(() => {
      if (window.__FE) window.__FE.endIme();
      const mf = document.getElementById('mf');
      mf.blur(); mf.value = ''; mf.focus();
      mf.executeCommand(['moveToMathfieldStart']);
    });
    await wait(80);
  };
  async function type(text) {
    for (const ch of text) {
      if (ch === '\t') await page.keyboard.press('Tab');
      else await page.keyboard.type(ch);
      await wait(70);
    }
    await wait(200);
  }
  const toEnd = async () => {
    await page.evaluate(() => document.getElementById('mf').executeCommand(['moveToMathfieldEnd']));
    await wait(200);
  };
  /** 空槽统计：占位符是渲染成「·」的叶子 span（MathLive 不给它 .ML__placeholder 类） */
  const state = () => page.evaluate(() => {
    const mf = document.getElementById('mf');
    const sr = mf.shadowRoot;
    const phs = Array.from(sr.querySelectorAll('[data-atom-id]'))
      .filter((el) => !el.children.length && el.textContent === '·');
    const u = sr.querySelector('[data-fe]');
    const litId = window.__FE.litUnit();
    const litEl = litId ? sr.querySelector('[data-fe][data-atom-id="' + litId + '"]') : null;
    return {
      latex: mf.getValue('latex'),
      pos: mf.position,
      lit: litEl ? litEl.getAttribute('data-fe') : null,
      total: phs.length,
      shown: phs.filter((el) => getComputedStyle(el).display !== 'none').length,
      width: u ? Math.round(u.getBoundingClientRect().width) : null
    };
  });

  function check(name, ok, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + detail);
    if (!ok) fails.push(name + ' → ' + detail);
  }

  console.log('\n[1] 光标在整体外：槽全藏、整体紧凑');
  {
    await reset();
    await type('$Cu\t');
    await toEnd();
    const s = await state();
    check('四个槽全藏', s.total === 4 && s.shown === 0, JSON.stringify(s));
    check('整体变窄（< 60px）', s.width !== null && s.width < 60, 'width=' + s.width);
  }

  console.log('\n[2] Tab 进整体：槽全露');
  {
    await reset();
    await type('$Cu\t');
    await page.keyboard.press('Tab');
    await wait(400);
    const s = await state();
    check('光标被认成在这个整体里', s.lit === 'elem', JSON.stringify(s));
    check('四个槽全露', s.total === 4 && s.shown === 4, JSON.stringify(s));
    check('整体变宽（> 90px）', s.width !== null && s.width > 90, 'width=' + s.width);
  }

  console.log('\n[3] 填两格后移出：填过的照常显示');
  {
    await reset();
    await type('$Cu\t');      // 第一下 Tab 直接进质量数格
    await wait(300);
    await type('14');
    await page.keyboard.press('Tab');
    await type('29');
    await toEnd();
    const s = await state();
    check('已填内容还在', /\^\{?14\}?/.test(s.latex) && /_\{29\}/.test(s.latex), s.latex);
    check('剩下两个空槽藏起来', s.total === 2 && s.shown === 0, JSON.stringify(s));
    check('移出后不再认成 lit', s.lit === null, JSON.stringify(s));
  }

  console.log('\n[4] 变量：光标在外时正上方槽也藏');
  {
    await reset();
    await type('@Tom\t');
    await toEnd();
    const s = await state();
    check('槽藏起来', s.total === 1 && s.shown === 0, JSON.stringify(s));
    await page.keyboard.press('Tab');
    await wait(400);
    const s2 = await state();
    check('Tab 进变量后露出', s2.lit === 'var' && s2.shown === 1, JSON.stringify(s2));
  }

  console.log('\n[5] 结构符号：插入后光标在槽里 → 露');
  {
    await reset();
    await type('#--');
    await page.keyboard.press('Enter');
    await wait(500);
    const s = await state();
    // pos 是分子占位符的**左边界**（占位符在 3，插入点 = 3-1）：第 17 批后不再用
    // moveToNextPlaceholder 的「整格选中」，改成折叠的细插入点，打一个字照样替换占位符
    check('分式插入后光标在分子槽', s.lit === 'sym' && s.pos === 2, JSON.stringify(s));
    check('两个槽都露着', s.total === 2 && s.shown === 2, JSON.stringify(s));
    await type('a');
    check('分子里确实进了 a', /\\frac\{a\}/.test(await page.evaluate(() => document.getElementById('mf').getValue('latex'))), await page.evaluate(() => document.getElementById('mf').getValue('latex')));
    await toEnd();
    const s2 = await state();
    check('移出后藏起来', s2.shown === 0, JSON.stringify(s2));
  }

  console.log('\n[6] H₂O：紧凑且导出干净');
  {
    await reset();
    await type('$H\t');
    await toEnd();
    await type('_2');
    await type('$O\t');
    await toEnd();
    const s = await state();
    const clean = await page.evaluate(() => window.__FE.clean(document.getElementById('mf').getValue('latex')));
    check('八个槽全藏', s.total === 8 && s.shown === 0, JSON.stringify(s));
    check('导出 ' + JSON.stringify(clean), clean === '\\mathrm{H}_2\\mathrm{O}', clean);
  }

  console.log('\n失败 ' + fails.length + ' 项');
  await browser.close();
  if (fails.length) {
    fails.forEach((f) => console.log('  · ' + f));
    process.exit(1);
  }
})();
