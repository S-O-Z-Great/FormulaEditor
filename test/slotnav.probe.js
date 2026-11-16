/* 槽位导航回归（第 16 批）：Tab / 方向键在实体内的槽之间走，
 * 光标是真正的插入点（不是「把整格选中」的蓝方块），当前格有蓝框、底部有状态。 */
const puppeteer = require('puppeteer-core');
const path = require('node:path');
// 页面地址按探针自己的位置算：项目拷到任何盘符 / 目录都能跑
const FE_PAGE = 'file:///' + path.resolve(__dirname, '..', 'src', 'index.html').replace(/\\/g, '/');
const EDGE = process.env.FE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 320 });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(FE_PAGE, { waitUntil: 'networkidle2' });
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
      else if (ch === '\b') await page.keyboard.press('Backspace');
      else await page.keyboard.type(ch);
      await wait(140);
    }
    await wait(220);
  };
  const key = async (k, shift) => {
    if (shift) await page.keyboard.down('Shift');
    await page.keyboard.press(k);
    if (shift) await page.keyboard.up('Shift');
    await wait(200);
  };
  const state = () => page.evaluate(() => {
    const mf = document.getElementById('mf');
    const sr = mf.shadowRoot;
    const box = document.getElementById('slotBox');
    const ctx = document.getElementById('ctx');
    const info = window.__FE.slots();
    return {
      pos: mf.position,
      latex: window.__FE.clean(mf.getValue('latex')),
      caret: !!sr.querySelector('.ML__caret'),
      selected: !!sr.querySelector('.ML__selected'),
      nav: info,
      boxHidden: box.hidden,
      boxClass: box.className,
      boxLeft: box.hidden ? null : parseFloat(box.style.left),
      ctx: ctx.hidden ? '' : ctx.textContent,
      ctxTag: ctx.hidden ? '' : (ctx.querySelector('.tag') ? ctx.querySelector('.tag').textContent : '')
    };
  });
  function check(name, ok, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + detail);
    if (!ok) fails.push(name + ' → ' + detail);
  }

  console.log('\n[1] $Cu + 一次 Tab 就进第一格');
  {
    await reset();
    await type('$Cu');
    const before = await state();
    check('收尾前还没有实体（Tab 会同时收尾并进槽）', before.nav === null, JSON.stringify(before.nav));
    await type('\t');
    const s = await state();
    check('Tab 一次进到第 1 格', s.nav && s.nav.index === 0, JSON.stringify(s.nav));
    check('第 1 格是质量数（superscript）', s.nav && s.nav.keys[0] === 'superscript', JSON.stringify(s.nav && s.nav.keys));
    check('光标是插入点（有 caret、不是选中块）', s.caret && !s.selected, 'caret=' + s.caret + ' selected=' + s.selected);
    check('槽框可见', !s.boxHidden && s.boxClass.indexOf('block') < 0, s.boxClass);
    check('状态栏写了「质量数 1/4」', /质量数/.test(s.ctx) && /1\/4/.test(s.ctx), s.ctx);
  }

  console.log('\n[2] Tab 走完四格再走出实体');
  {
    const seq = [];
    for (let i = 0; i < 3; i++) { await type('\t'); seq.push((await state()).nav.index); }
    check('依次 0→1→2→3', JSON.stringify(seq) === '[1,2,3]', JSON.stringify(seq));
    const last = await state();
    check('第 4 格是电荷（右上 superscript）', last.nav && last.nav.keys[3] === 'superscript', JSON.stringify(last.nav));
    await type('\t');
    const out = await state();
    check('再 Tab 一次走出实体', out.nav && out.nav.index < 0, JSON.stringify(out.nav));
    check('走出后没有蓝框', out.boxHidden, 'hidden=' + out.boxHidden);
    check('状态栏变成「实体外」', /实体外/.test(out.ctx), out.ctx);
  }

  console.log('\n[3] Shift+Tab 反向');
  {
    await reset();
    await type('$Cu\t');
    await key('Tab', true);
    const s1 = await state();
    check('第一格 Shift+Tab 回到实体左边', s1.nav && s1.nav.index < 0 && s1.pos === 1, 'pos=' + s1.pos + ' nav=' + JSON.stringify(s1.nav));
    await key('Tab', true);
    const s2 = await state();
    check('再 Shift+Tab 落到最后一格', s2.nav && s2.nav.index === 3, JSON.stringify(s2.nav));
  }

  console.log('\n[4] 方向键按视觉方位走');
  {
    await reset();
    await type('$Cu\t');            // 质量数（左上）
    await key('ArrowRight');
    const a = await state();
    check('→ 到质子数（左下）', a.nav && a.nav.index === 1, JSON.stringify(a.nav));
    await key('ArrowRight');
    const b = await state();
    check('→ 到个数（右下）', b.nav && b.nav.index === 2, JSON.stringify(b.nav));
    await key('ArrowUp');
    const c = await state();
    check('↑ 到电荷（右上）', c.nav && c.nav.index === 3, JSON.stringify(c.nav));
    await key('ArrowLeft');
    const d = await state();
    check('← 回到质量数', d.nav && d.nav.index === 0, JSON.stringify(d.nav));
  }

  console.log('\n[5] 槽框跟着当前格走');
  {
    await reset();
    await type('$Cu\t');
    const s1 = await state();
    await key('Tab');
    const s2 = await state();
    check('换格后框的位置变了', s1.boxLeft !== null && s2.boxLeft !== null && s1.boxLeft !== s2.boxLeft,
      s1.boxLeft + ' → ' + s2.boxLeft);
  }

  console.log('\n[6] 两种模式：槽里只删这格，主体上删整块');
  {
    await reset();
    await type('$Cu\t14');
    await type('\b');
    let s = await state();
    check('质量数格里退格只删数字', /\\mathrm\{Cu\}/.test(s.latex) && !/14/.test(s.latex), s.latex);
    await type('\b');
    s = await state();
    check('再退格槽空也不动实体', /\\mathrm\{Cu\}/.test(s.latex), s.latex);
    check('仍在同一格里', s.nav && s.nav.index === 0, JSON.stringify(s.nav));
  }
  {
    await reset();
    await type('$Cu\t\t\t\t\t');         // 走完四格 → 实体右侧
    await type('\b');
    const s = await state();
    check('贴着实体右侧退格 → 整个删掉', s.latex === '', s.latex);
  }

  console.log('\n' + (fails.length ? '失败 ' + fails.length + ' 项' : '槽位导航全部正确'));
  fails.forEach((f) => console.log('  ! ' + f));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
