/* 块边界插入回归（第 18 批）
 * 用户报的现象：在元素符号**左边**打字，字被塞进同一个块里——一个块里出现两个符号，
 * 删一次走两个、四个槽也跟着串位。
 *
 * 根因：MathLive 的插入点是「在 offset 为 pos 的那个原子后面插」，而整体内部第一个原子的
 * offset 正好等于整体自己的 start。所以光标贴在整体左边界时，insert 一定落进整体内部。
 * 现在贴着左边界落笔时，先把整体原样取出来挪到新内容右边（`insertBeforeUnit`）。
 */
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
    await wait(250);
  };
  const state = () => page.evaluate(() => {
    const mf = document.getElementById('mf');
    return {
      pos: mf.position,
      raw: mf.getValue('latex'),
      units: window.__FE.units().map(u => ({ start: u.start, end: u.end, kind: u.kind }))
    };
  });
  // 一路 ← 走到最左边那个整体的左边界
  const toLeftEdge = async () => {
    for (let i = 0; i < 12; i++) {
      const s = await state();
      if (!s.units.length || s.pos <= s.units[0].start) return s;
      await page.keyboard.press('ArrowLeft');
      await wait(190);
    }
    return state();
  };
  function check(name, ok, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + detail);
    if (!ok) fails.push(name + ' → ' + detail);
  }
  // 块里的元素正文：htmlData 外壳里出现了新的字符，就说明字被吸进块里了
  const blockBody = (raw) => {
    const i = raw.indexOf('\\htmlData{fe=elem}{');
    if (i < 0) return '';
    let d = 0, j = i + '\\htmlData{fe=elem}'.length;
    for (let k = j; k < raw.length; k++) {
      if (raw[k] === '{') d++;
      else if (raw[k] === '}') { d--; if (d === 0) return raw.slice(j + 1, k); }
    }
    return '';
  };

  console.log('\n[1] 元素左边界打一个字');
  await reset();
  await type('$Cu ');
  let s = await toLeftEdge();
  check('光标落在块左边界', s.pos === s.units[0].start, 'pos=' + s.pos + ' start=' + s.units[0].start);
  await type('x');
  s = await state();
  check('x 在块外面', s.raw.indexOf('x\\htmlData{fe=elem}') === 0, s.raw);
  check('块里没有 x', blockBody(s.raw).indexOf('x') < 0, blockBody(s.raw));
  check('仍然只有一个整体', s.units.length === 1, 'units=' + s.units.length);
  await type('y');
  s = await state();
  check('再打一个字也排在块外', s.raw.indexOf('xy\\htmlData{fe=elem}') === 0, s.raw);

  console.log('\n[2] 块里已经填过槽（质量数 14），左边界打字不许动它');
  await reset();
  await type('$C ');
  await page.keyboard.press('Tab');
  await wait(260);
  await type('14');
  s = await toLeftEdge();
  await type('3');
  s = await state();
  check('3 在块外', s.raw.indexOf('3\\htmlData{fe=elem}') === 0, s.raw);
  check('质量数 14 还在', /\^\{14\}/.test(s.raw), s.raw);

  console.log('\n[3] 左边界打符号码 #al：α 落在块外，待定码被吃掉');
  await reset();
  await type('$Cu ');
  await toLeftEdge();
  await type('#al ');
  s = await state();
  check('α 在块外', s.raw.indexOf('\\alpha\\htmlData{fe=elem}') === 0, s.raw);
  check('没有残留 #al', s.raw.indexOf('\\#') < 0, s.raw);

  console.log('\n[4] 左边界打符号码，中途退格');
  await reset();
  await type('$Cu ');
  await toLeftEdge();
  await type('#valpha');
  await type('\b\b');
  s = await state();
  check('两次退格少两个字符', /\\#valp\\htmlData\{fe=elem\}/.test(s.raw), s.raw);

  console.log('\n[5] 左边界打变量 @Tom@');
  await reset();
  await type('$Cu ');
  await toLeftEdge();
  await type('@Tom@');
  s = await state();
  check('变量在块外', s.raw.indexOf('\\htmlData{fe=var}') === 0, s.raw);
  check('变量名没有重复留在外面', s.raw.indexOf('Tom\\htmlData{fe=var}') < 0, s.raw);
  check('两个整体', s.units.length === 2, JSON.stringify(s.units));

  console.log('\n[6] 左边界打结构 #v（根号）');
  await reset();
  await type('$Cu ');
  await toLeftEdge();
  await type('#v\t');
  s = await state();
  check('根号在块外', s.raw.indexOf('\\htmlData{fe=sym}{\\sqrt') === 0, s.raw);
  const posBefore = s.pos;
  await type('a');
  s = await state();
  check('打 a 进了根号里', /\\sqrt\{a\}/.test(s.raw), s.raw);
  check('光标确实进过槽', posBefore > 0, 'pos=' + posBefore);

  console.log('\n[7] 两个元素之间打字');
  await reset();
  await type('$Cu $Fe ');
  s = await state();
  check('先有两个元素', s.units.length === 2, JSON.stringify(s.units));
  await page.evaluate(() => {
    const mf = document.getElementById('mf');
    const us = window.__FE.units();
    mf.focus();
    mf.selection = { ranges: [[us[1].start, us[1].start]], direction: 'none' };
  });
  await wait(250);
  await type('+');
  s = await state();
  check('+ 落在两块之间', /\}\+\\htmlData\{fe=elem\}/.test(s.raw), s.raw.replace(/\\htmlData\{fe=elem\}\{[\s\S]*?\}\}/g, '<块>'));

  console.log('\n[8] 结构符号的左边界（已填分子）');
  await reset();
  await type('#--\t');
  await type('a');
  s = await toLeftEdge();
  check('光标落在结构左边界', s.pos === s.units[0].start, 'pos=' + s.pos + ' start=' + s.units[0].start);
  await type('x');
  s = await state();
  check('x 在结构外面', s.raw.indexOf('x\\htmlData{fe=sym}') === 0, s.raw);
  check('分子里的 a 还在', /\\frac\{a\}/.test(s.raw), s.raw);

  console.log(fails.length ? '\n失败 ' + fails.length + ' 项' : '\n块边界插入全部正确');
  fails.forEach(f => console.log('  - ' + f));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
