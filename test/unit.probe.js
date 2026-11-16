/* 整体（unit）回归：变量 / 元素 / 结构符号作为一个原子——光标一跳过、退格一删全
 * 另含槽位：变量的右上（幂）、右下（下标），元素四槽，符号自带槽 */
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
    await wait(60);
  };
  const latex = () => page.evaluate(() => document.getElementById('mf').getValue('latex'));
  const pos = () => page.evaluate(() => document.getElementById('mf').position);
  const units = () => page.evaluate(() => {
    const mf = document.getElementById('mf');
    return Array.from(mf.shadowRoot.querySelectorAll('[data-fe]')).map(el => ({
      kind: el.getAttribute('data-fe'), id: el.getAttribute('data-atom-id')
    }));
  });

  async function type(text) {
    for (const ch of text) {
      if (ch === '\n') await page.keyboard.press('Enter');
      else if (ch === '\t') await page.keyboard.press('Tab');
      else if (ch === '\b') await page.keyboard.press('Backspace');
      else if (ch === '[') await page.keyboard.press('ArrowLeft');
      else if (ch === ']') await page.keyboard.press('ArrowRight');
      else await page.keyboard.type(ch);
      await wait(50);
    }
    await wait(150);
  }

  async function check(name, keys, want /* string | RegExp | fn */, negate) {
    await reset();
    await type(keys);
    const v = await latex();
    let ok;
    if (typeof want === 'function') ok = want(v);
    else if (typeof want === 'string') ok = v.includes(want);
    else ok = want.test(v);
    if (negate) ok = !ok;
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + JSON.stringify(v));
    if (!ok) fails.push(name + ' → ' + v);
    return v;
  }

  console.log('\n[1] 整体被正确包装');
  {
    await reset();
    await type('@Tom\t');
    const us = await units();
    console.log((us.length === 1 && us[0].kind === 'var' ? '  ok   ' : '  FAIL ') + '变量有 data-fe=var 整体 → ' + JSON.stringify(us));
    if (us.length !== 1) fails.push('变量整体');
  }
  {
    await reset();
    await type('$Cu\t');
    const us = await units();
    console.log((us.length === 1 && us[0].kind === 'elem' ? '  ok   ' : '  FAIL ') + '元素有 data-fe=elem 整体 → ' + JSON.stringify(us));
    if (us.length !== 1) fails.push('元素整体');
  }
  {
    await reset();
    await type('#v\t');
    const us = await units();
    console.log((us.length === 1 && us[0].kind === 'sym' ? '  ok   ' : '  FAIL ') + '结构符号有 data-fe=sym 整体 → ' + JSON.stringify(us));
    if (us.length !== 1) fails.push('符号整体');
  }

  console.log('\n[2] 退格整体删除（光标不在槽里时）');
  await check('变量 + 退格 → 全没了', '@Tom@\b', v => v === '');
  await check('元素 + 退格 → 全没了', '$Cu$\b', v => v === '');
  await check('根号 + 退格 → 全没了', '#v\t\b', v => v === '');
  await check('x + 元素，退格只删元素', 'x$Cu$\b', v => v === 'x');
  await check('x + 根号，退格只删根号', 'x#v\t\b', v => v === 'x');

  console.log('\n[3] 左右箭头以整体为单位');
  await check('变量左箭头跳到整体左侧', '@Tom\t[', v => v.indexOf('\\htmlData') === 0 && v.indexOf('Tom') > 0);
  {
    await reset();
    await type('@Tom\t[');
    const p1 = await pos();
    console.log((p1 === 1 ? '  ok   ' : '  FAIL ') + '左跳后 pos=1 → ' + p1);
    if (p1 !== 1) fails.push('变量左跳 pos=' + p1);
  }
  {
    await reset();
    await type('x@Tom\t[');
    // 左跳落到整个变量的最左端。退格删的是**光标左边那一样**（那个 x），
    // 而不是右边的变量——「删左边」这条规则对数字、符号、变量一视同仁，
    // 也是 `2|Cu` 按退格不能把 Cu 带走的同一条规则。
    await page.keyboard.press('Backspace');
    await wait(120);
    const v2 = await latex();
    const keepVar = /\\htmlData\{fe=var\}/.test(v2) && v2.indexOf('x') < 0;
    console.log((keepVar ? '  ok   ' : '  FAIL ') + 'x + 变量，左跳后删 → ' + JSON.stringify(v2));
    if (!keepVar) fails.push('左跳后删 → ' + v2);
  }

  console.log('\n[4] 变量槽位：正上方 / 右上（幂）/ 右下（下标）');
  await check('变量 + ^2 → 幂', '@Tom\t^2', v => /\^2/.test(v));
  await check('变量 + _1 → 下标', '@Tom\t_1', v => /_1/.test(v));
  await check('变量上标占位仍在', '@Tom\t', v => /\\placeholder\{\}/.test(v));
  // 槽里的退格只改槽：以前这里会把整个变量连名字一起删掉，正是被报的 bug
  await check('幂里退格只删指数', '@Tom\t^2\b', v => v.indexOf('Tom') > 0 && !/\^2/.test(v));
  await check('幂里连退格不删变量', '@Tom\t^2\b\b\b', v => v.indexOf('Tom') > 0);

  console.log('\n[4b] 槽里退格不带走整体（bug 回归）');
  await check('元素四槽填完，退格只删最后一格', '$C\t\t14\t\t6\b', v => v.indexOf('\\mathrm{C}') > 0 && !/_6/.test(v));
  {
    // 填进质量数槽（14）后按退格：只该少一位数字，元素还在
    await reset();
    await type('$C\t\t14');
    await page.keyboard.press('Backspace');
    await wait(140);
    const v2 = await latex();
    const ok = v2.indexOf('\\mathrm{C}') > 0 && v2.indexOf('14') < 0;
    console.log((ok ? '  ok   ' : '  FAIL ') + '质量数槽里退格只删数字 → ' + JSON.stringify(v2));
    if (!ok) fails.push('质量数槽退格 → ' + v2);
  }
  await check('元素槽里放变量，退格只删这个变量', '$Cu\t@y@\b',
    v => v.indexOf('\\mathrm{Cu}') > 0 && v.indexOf('mathrm{y}') < 0);
  await check('变量的幂里放变量，退格只删里层', '@x\t^@y@\b',
    v => v.indexOf('mathrm{x}') > 0 && v.indexOf('mathrm{y}') < 0);
  await check('分式删空分母不牵连分子', '#--\n1\t2\b\b', v => /frac\{1\}/.test(v) || /\\frac1/.test(v));

  console.log('\n[5] 元素四槽仍可写');
  await check('$C + Tab 进槽填 14', '$C\t\t14', v => v.indexOf('14') > 0 && v.indexOf('14') < v.lastIndexOf('}'));
  await check('H₂O 串联', '$H\t_2$O\t', v => v.indexOf('O') > 0);
  await check('元素的下标槽里退格只删 2', '$H\t_2\b', v => v.indexOf('\\mathrm{H}') > 0 && !/_2/.test(v));
  {
    // Tab 顺序：质量数（左上）→ 质子数（左下），两者都写在主体左侧
    await reset();
    await type('$C\t14\t6');
    const v = await latex();
    const iC = v.indexOf('\\mathrm{C}');
    const i14 = v.indexOf('14');
    const i6 = v.indexOf('}_{6}') >= 0 ? v.indexOf('}_{6}') : v.indexOf('_6');
    const ok = i14 > 0 && i6 > 0 && i14 < iC && i6 < iC && i14 < i6;
    console.log((ok ? '  ok   ' : '  FAIL ') + 'Tab 顺序 质量数→质子数 → ' + JSON.stringify(v));
    if (!ok) fails.push('Tab 顺序 → ' + v);
  }

  console.log('\n[6] 导出清洗');
  {
    const clean = await page.evaluate(() => {
      const raw = '\\htmlData{fe=var}{\\overset{}{\\mathrm{Tom}}^{\\placeholder{}}_{\\placeholder{}}}+\\htmlData{fe=elem}{\\mathrm{Cu}_{2}}';
      return window.__FE.clean(raw);
    });
    const ok = !/htmlData/.test(clean) && !/placeholder/.test(clean) && clean.indexOf('\\mathrm{Tom}') >= 0;
    console.log((ok ? '  ok   ' : '  FAIL ') + 'clean → ' + JSON.stringify(clean));
    if (!ok) fails.push('clean → ' + clean);
  }
  {
    // 元素主体那个零宽基底 {\vphantom{0}} 也不该出现在导出里
    const clean = await page.evaluate(() => {
      const raw = '\\htmlData{fe=elem}{{\\vphantom{0}}^{\\placeholder{}}_{\\placeholder{}}\\mathrm{Cu}_{\\placeholder{}}^{\\placeholder{}}}';
      return window.__FE.clean(raw);
    });
    const ok = clean === '\\mathrm{Cu}';
    console.log((ok ? '  ok   ' : '  FAIL ') + '元素导出 → ' + JSON.stringify(clean));
    if (!ok) fails.push('元素导出 → ' + clean);
  }

  console.log('\n失败 ' + fails.length + ' 项');
  fails.forEach(f => console.log('  ✗ ' + f));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
