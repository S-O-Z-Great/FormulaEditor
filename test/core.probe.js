/* 核心回归：确认式转换 + 变量必须以 ## 收尾 + 居中布局 */
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 780, height: 300 });
  await page.goto('file:///E:/FormulaEditor/src/index.html', { waitUntil: 'networkidle2' });
  await wait(900);

  const fails = [];
  const reset = async () => {
    await page.evaluate(() => {
      if (window.__FE) window.__FE.endIme();      // 清掉上一次可能残留的待定态
      const mf = document.getElementById('mf');
      mf.blur(); mf.value = ''; mf.focus();
      mf.executeCommand(['moveToMathfieldStart']);
    });
    await wait(60);
  };
  const latex = () => page.evaluate(() => document.getElementById('mf').getValue('latex'));

  // '\n' 表示回车确认，'\t' 表示 Tab 确认；其余逐字敲
  async function type(text) {
    for (const ch of text) {
      if (ch === '\n') await page.keyboard.press('Enter');
      else if (ch === '\t') await page.keyboard.press('Tab');
      else if (ch === '\u001b') await page.keyboard.press('Escape');
      else await page.keyboard.type(ch);
      await wait(45);
    }
    await wait(140);
  }

  async function check(name, keys, want, shouldInclude) {
    await reset();
    await type(keys);
    const v = await latex();
    const hit = typeof want === 'string' ? v.includes(want) : want.test(v);
    const ok = shouldInclude === false ? !hit : hit;
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + JSON.stringify(v));
    if (!ok) fails.push(name + ' → ' + v);
  }

  console.log('[1] 确认后才转换（Tab / Enter）');
  await check('#alpha 打完不变', '#alpha', '\\#alpha');
  await check('#alpha + Enter → α', '#alpha\n', '\\alpha');
  await check('#alpha + Tab → α', '#alpha\t', '\\alpha');
  await check('#U + Enter → ∪', '#U\n', '\\cup');
  await check('#n + Enter → ∩', '#n\n', '\\cap');
  await check('#!A + Enter → ∀', '#!A\n', '\\forall');
  await check('#E + Enter → ∃', '#E\n', '\\exists');
  await check('#S + Enter → ∫', '#S\n', '\\int');
  await check('#II + Enter → ∏', '#II\n', '\\prod');
  await check('#~ + Enter → ∼（相似）', '#~\n', '\\sim');
  await check('#= + Enter → 化学等号', '#=\n', '=');
  await check("#' 撇 + Enter", "x#'\n", '\\prime');
  await check('#-- + Enter → 分式', '#--\n', '\\frac');
  await check('#sigma 长码 + Enter', '#sigma\n', '\\sigma');

  console.log('\n[2] Shift 打大写不会打断待定态');
  await reset();
  await page.keyboard.type('#');
  await wait(80);
  await page.keyboard.down('Shift');
  await page.keyboard.type('A');
  await page.keyboard.up('Shift');
  await wait(120);
  await page.keyboard.type('lpha');   // 拼成 #Alpha
  await wait(200);
  const shifted = await latex();
  const shiftOk = shifted.includes('\\#Alpha');
  console.log((shiftOk ? '  ok   ' : '  FAIL ') + '# + Shift+A + lpha 仍在待定态：' + JSON.stringify(shifted));
  if (!shiftOk) fails.push('Shift 打断待定态: ' + shifted);
  await page.keyboard.press('Enter');
  await wait(150);
  const shifted2 = await latex();
  const shiftOk2 = shifted2.trim() === 'A';
  console.log((shiftOk2 ? '  ok   ' : '  FAIL ') + '#Alpha + Enter → Α：' + JSON.stringify(shifted2));
  if (!shiftOk2) fails.push('#Alpha 未转成 Α: ' + shifted2);

  // 方向键退出待定，但不应把编辑器搞乱
  await reset();
  await page.keyboard.type('#al');
  await wait(150);
  await page.keyboard.press('ArrowLeft');
  await wait(150);
  const afterNav = await latex();
  const navOk = afterNav.trim() === '';
  console.log((navOk ? '  ok   ' : '  FAIL ') + '#al + ← 退出待定：' + JSON.stringify(afterNav));
  if (!navOk) fails.push('方向键未正确退出待定: ' + afterNav);

  console.log('\n[3] 变量必须以 ## 收尾');
  await check('##Tom## → 变量', '##Tom##', '\\mathrm{Tom}');
  await check('##Tom + Enter 不建变量', '##Tom\n', 'overset', false);
  await check('## + #alpha + Enter + ##', '##' + '#alpha\n' + '##', '\\alpha');

  await reset();
  await type('##' + '#alpha\n' + '##');
  const varTex = await latex();
  const isOverset = varTex.indexOf('overset') >= 0;
  console.log((isOverset ? '  ok   ' : '  FAIL ') + '变量结构是 overset：' + JSON.stringify(varTex));
  if (!isOverset) fails.push('变量不是 overset: ' + varTex);

  await type('+1');
  const after = await latex();
  const tailOk = /\+1$/.test(after);
  console.log((tailOk ? '  ok   ' : '  FAIL ') + '变量后继续输入落在右侧：' + JSON.stringify(after));
  if (!tailOk) fails.push('变量后续输入异常: ' + after);

  console.log('\n[4] 嵌套槽位里也能正确转换（position 在分母/上下限里不可靠，已改用相对删除）');
  await check('分母里放 α', '#--\n' + 'a\t' + '#alpha\n', '\\frac{a}{\\alpha}');
  await check('积分上限放 π', '#S\n' + '0\t' + '#pi\n', /\\int_0\^\{\\pi\}/);
  await check('分母里取消', '#--\na\t#al' + '\u001b', '\\frac{a}{}');
  await check('变量名夹两个符号', '##' + '#alpha\n' + '#beta\n' + '##', '\\alpha\\beta');

  console.log('\n[5] 居中布局');
  await reset();
  await type('x+1');
  const box = await page.evaluate(() => {
    const w = document.querySelector('.field-wrap').getBoundingClientRect();
    const f = document.getElementById('mf').getBoundingClientRect();
    return { cx: w.left + w.width / 2, cy: w.top + w.height / 2, fx: f.left + f.width / 2, fy: f.top + f.height / 2, fw: f.width, ww: w.width };
  });
  const dx = Math.abs(box.cx - box.fx);
  const dy = Math.abs(box.cy - box.fy);
  const centered = dx < 6 && dy < 10 && box.fw < box.ww * 0.5;
  console.log((centered ? '  ok   ' : '  FAIL ') + `水平偏差 ${dx.toFixed(1)}px / 垂直偏差 ${dy.toFixed(1)}px`);
  if (!centered) fails.push('未居中');

  console.log('\n[6] 候选条「选用」按钮');
  await reset();
  await page.keyboard.type('#al');
  await wait(250);
  const btn = await page.evaluate(() => {
    const b = document.querySelector('.cand-ok');
    return b ? { text: b.textContent.trim(), visible: !document.getElementById('cand').hidden } : null;
  });
  const hasBtn = !!(btn && btn.visible);
  console.log((hasBtn ? '  ok   ' : '  FAIL ') + '候选条有「选用」按钮：' + JSON.stringify(btn));
  if (!hasBtn) fails.push('缺少选用按钮');

  await page.evaluate(() => {
    const b = document.querySelector('.cand-ok');
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await wait(200);
  const clicked = await latex();
  const clickOk = clicked.includes('\\alpha');
  console.log((clickOk ? '  ok   ' : '  FAIL ') + '点「选用」完成转换：' + JSON.stringify(clicked));
  if (!clickOk) fails.push('按钮未生效: ' + clicked);

  console.log('\n失败 ' + fails.length + ' 项');
  fails.forEach(f => console.log('  ✗ ' + f));

  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
