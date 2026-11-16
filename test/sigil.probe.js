/* 三前缀回归：@ 变量 / $ 元素 / # 运算符（含旧的 ## 写法不能坏） */
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

  async function type(text) {
    for (const ch of text) {
      if (ch === '\n') await page.keyboard.press('Enter');
      else if (ch === '\t') await page.keyboard.press('Tab');
      else if (ch === '\u001b') await page.keyboard.press('Escape');
      else await page.keyboard.type(ch);
      await wait(45);
    }
    await wait(160);
  }

  async function check(name, keys, want, shouldInclude) {
    await reset();
    await type(keys);
    const v = await latex();
    const hit = typeof want === 'string' ? v.includes(want) : want.test(v);
    const ok = shouldInclude === false ? !hit : hit;
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + JSON.stringify(v));
    if (!ok) fails.push(name + ' → ' + v);
    return v;
  }

  console.log('[1] @ 变量（新的主写法）');
  await check('@Tom + Tab → 变量', '@Tom\t', '\\mathrm{Tom}');
  await check('@Tom 结构是 overset', '@Tom\t', /\\overset\{/);
  await check('@ 夹符号 #alpha', '@#alpha\n@', '\\alpha');
  await check('@ 夹两个符号', '@#alpha\n#beta\n@', '\\alpha\\beta');
  await check('@Tom + @ 收尾', '@Tom@', '\\mathrm{Tom}');
  await check('@x + Enter 也能收尾', '@x\n', '\\mathrm{x}');

  console.log('\n[2] ## 旧写法不能坏');
  await check('##Tom## → 变量', '##Tom##', '\\mathrm{Tom}');
  await check('##Tom + Enter 不建变量', '##Tom\n', 'overset', false);

  console.log('\n[2b] ## 二次解析：先 #Sigma 再 #Σ');
  await check('##Sigma + Tab → ∑', '##Sigma\t', '\\sum');
  await check('##Sigma + Enter → ∑', '##Sigma\n', '\\sum');
  await check('##Sigma## 也能收尾', '##Sigma##', '\\sum');
  await check('##Theta + Tab → ⊖', '##Theta\t', '\\ominus');
  await check('##Sigma 不再建变量', '##Sigma\t', 'overset', false);

  console.log('\n[3] $ 元素');
  await check('$Cu + Tab → 元素', '$Cu\t', '\\mathrm{Cu}');
  await check('$C$ 收尾', '$C$', '\\mathrm{C}');
  await check('$Xx 不是元素 → 拒绝', '$Xx\t', '\\mathrm{Xx}', false);
  await check('$H 后接 _2 → 下标', '$H\t_2', '2');

  // 四个空槽（质量数 / 质子数 / 个数 / 电荷）
  await reset();
  await type('$Cu\t');
  const holes = await page.evaluate(() => {
    const mf = document.getElementById('mf');
    const tex = mf.getValue('latex');
    const val = mf.value;
    return { tex, count: (tex.match(/placeholder/g) || []).length };
  });
  const slotOk = holes.count >= 4;
  console.log((slotOk ? '  ok   ' : '  FAIL ') + '元素解锁 4 个槽：' + holes.count + ' 个 placeholder');
  if (!slotOk) fails.push('元素槽位数 ' + holes.count);

  // H₂O：元素串联
  await reset();
  await type('$H\t_2$O\t');
  const water = await latex();
  const waterOk = water.includes('\\mathrm{H}') && water.includes('\\mathrm{O}') && water.includes('2');
  console.log((waterOk ? '  ok   ' : '  FAIL ') + 'H₂O 串联：' + JSON.stringify(water));
  if (!waterOk) fails.push('H₂O 串联: ' + water);

  console.log('\n[4] # 仍是运算符');
  await check('#S + Enter → ∫', '#S\n', '\\int');
  await check('#(SS) + Enter → ∬', '#(SS)\n', '\\iint');
  await check('#C 默认组合数', '#C\n', '\\binom');

  console.log('\n失败 ' + fails.length + ' 项');
  fails.forEach(f => console.log('  ✗ ' + f));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
