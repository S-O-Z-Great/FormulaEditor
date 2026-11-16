/* 整体左边的字（第 19 批）
 * 用户报：「在元素符号的左边输入会输入进同块中」修好之后，紧接着是这一条：
 * 「删除左边的数字，会导致右边的元素符号被删除」。
 *
 * 根因：整体内部第一个原子的 offset 正好等于整体自己的 `start`（offset 是后序编号），
 * 于是 `at(start)` 返回的是整体**内部**的原子，`atUnitTail` 把「贴着整体左边」
 * 误判成「贴着整体最后一块」→ 退格把右边的实体整块带走。
 * 同时第 ⑤ 条（左边界删自己）是无条件执行的，也会吞掉右边的实体。
 *
 * 现在的规则：退格永远删「光标左边那一样」——数字、符号、另一个整体；
 * 只有左边真的什么都没有（实体就在文档最前面）时，才删这个实体自己。 */
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
  await page.setViewport({ width: 900, height: 340 });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(FE_PAGE, { waitUntil: 'networkidle2' });
  await wait(900);

  const reset = async () => {
    await page.evaluate(() => {
      if (window.__FE) window.__FE.endIme();
      const mf = document.getElementById('mf');
      mf.blur(); mf.value = ''; mf.focus();
    });
    await wait(180);
  };
  const type = async (text) => {
    for (const ch of text) {
      if (ch === '\t') await page.keyboard.press('Tab');
      else if (ch === '\n') await page.keyboard.press('Enter');
      else await page.keyboard.type(ch);
      await wait(150);
    }
    await wait(240);
  };
  const key = async (k) => { await page.keyboard.press(k); await wait(320); };
  const state = () => page.evaluate(() => {
    const mf = document.getElementById('mf');
    return {
      pos: mf.position,
      latex: window.__FE.clean(mf.getValue('latex')),
      units: window.__FE.units().length
    };
  });
  /** 一路向左，把光标停到第一个整体的左边界（`pos <= start`） */
  const toLeft = async () => {
    for (let i = 0; i < 20; i++) {
      const s = await page.evaluate(() => {
        const mf = document.getElementById('mf');
        const list = window.__FE.units();
        return { pos: mf.position, s: list.length ? list[0].start : null };
      });
      if (s.s == null || s.pos <= s.s) return;
      await page.keyboard.press('ArrowLeft');
      await wait(180);
    }
  };
  function check(name, ok, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + detail);
    if (!ok) fails.push(name + ' → ' + detail);
  }

  console.log('\n[1] 元素左边一个数字：退格删数字，不碰元素');
  await reset();
  await type('$Cu ');
  await toLeft();
  await type('2');
  let s = await state();
  check('2 落在块外', s.latex === '2\\mathrm{Cu}' && s.units === 1, s.latex);
  await key('Backspace');
  s = await state();
  check('退格只删掉 2，Cu 还在', s.latex === '\\mathrm{Cu}', s.latex);

  console.log('\n[2] 左边空了，再退格才删元素自己');
  await key('Backspace');
  s = await state();
  check('删掉 Cu', s.latex === '' && s.units === 0, JSON.stringify(s.latex));

  console.log('\n[3] 左边两个字母：只吃眼前那一个');
  await reset();
  await type('$Cu ');
  await toLeft();
  await type('xy');
  s = await state();
  check('x y 都在块外', s.latex === 'xy\\mathrm{Cu}', s.latex);
  await key('Backspace');
  s = await state();
  check('只少 y，Cu 还在', s.latex === 'x\\mathrm{Cu}', s.latex);

  console.log('\n[4] 变量左边一个数字');
  await reset();
  await type('@x@');
  await toLeft();
  await type('2');
  await key('Backspace');
  s = await state();
  check('只删 2，变量还在', s.latex === '\\mathrm{x}', s.latex);

  console.log('\n[5] 符号左边一个数字');
  await reset();
  await type('$Cu ');
  await toLeft();
  await type('#al ');
  s = await state();
  check('α 落在块外', s.latex === '\\alpha\\mathrm{Cu}' || s.latex === 'α\\mathrm{Cu}', s.latex);
  await key('Backspace');
  s = await state();
  check('只删 α，Cu 还在', s.latex === '\\mathrm{Cu}', s.latex);

  console.log('\n[6] 元素在文档最前面：退格删自己（保留便利）');
  await reset();
  await type('$Cu ');
  await toLeft();
  await key('Backspace');
  s = await state();
  check('删掉整个 Cu', s.latex === '' && s.units === 0, JSON.stringify(s.latex));

  console.log('\n[7] 两个元素首尾相接：删左边那个，右边的留下');
  await reset();
  await type('$O ');
  await type('$Cu ');
  await toLeft();
  await key('Backspace');
  s = await state();
  check('氧气没了、Cu 还在', s.latex === '\\mathrm{Cu}' && s.units === 1, s.latex);

  console.log('\n[8] 分式左边一个数字（结构性整体的左边界）');
  await reset();
  await type('#--\t');
  await type('a');
  await toLeft();
  await type('2');
  s = await state();
  check('2 落在分式外', s.latex === '2\\frac{a}{}', s.latex);
  await key('Backspace');
  s = await state();
  check('只删 2，分式还在', s.latex === '\\frac{a}{}', s.latex);

  console.log('\n' + (fails.length ? '失败 ' + fails.length + ' 项' : '整体左边的删除全部正确'));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
