/**
 * 命令面板（Ctrl/⌘ + K）回归
 *
 * 盯住四件事：
 *   ① 唤出 / 关闭只有 Ctrl+K、Esc、点遮罩三条路，别把待定态带进去
 *   ② 排序：敲 al 第一项必须是 alpha（不是别名 all，也不是同形的 Alpha）
 *   ③ 插入走的还是 replacePreedit 那条通道 —— 结构落第一格、块左边界落块外
 *   ④ 关掉之后焦点回到公式，能接着打字
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fails.push(name); console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 980, height: 620 });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto('file:///E:/FormulaEditor/src/index.html', { waitUntil: 'networkidle2' });
  await wait(900);

  const reset = async () => {
    await page.evaluate(() => {
      if (window.__FE) window.__FE.endIme();
      const mf = document.getElementById('mf');
      mf.blur(); mf.value = ''; mf.focus();
    });
    await wait(180);
  };
  const state = () => page.evaluate(() => {
    const mf = document.getElementById('mf');
    const box = document.getElementById('cmdk');
    return {
      open: !!(box && !box.hidden),
      pos: mf.position,
      latex: mf.getValue('latex'),
      rows: Array.from(document.querySelectorAll('.cmdk-item'))
        .map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
      sel: (document.querySelector('.cmdk-item.here') || {}).textContent || '',
      tip: (document.getElementById('cmdkTip') || {}).textContent || '',
    };
  });
  const open = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await wait(320);
  };
  const typeIn = async (t) => {
    for (const ch of t) { await page.keyboard.type(ch); await wait(120); }
    await wait(260);
  };
  const units = () => page.evaluate(() => window.__FE.units().map((u) => [u.start, u.end]));

  /* ---------- 1. 打开 / 默认列表 ---------- */
  console.log('\n[1] Ctrl+K 唤出');
  await reset();
  await open();
  let s = await state();
  check('面板已打开', s.open === true, JSON.stringify(s.open));
  check('空查询有默认条目', s.rows.length >= 6, 'rows=' + s.rows.length);
  check('默认条目都有可辨认的字形（没有 {} 占位）', s.rows.every((r) => r.indexOf(' {} ') < 0),
    s.rows.slice(0, 3).join(' | '));
  check('底部写着位置', /^\d+ \/ \d+$/.test(s.tip.trim()), 'tip=' + s.tip);

  /* ---------- 2. 搜中文，插结构 ---------- */
  console.log('\n[2] 搜「根号」→ Enter');
  await typeIn('根号');
  s = await state();
  check('只剩根号那一条', s.rows.length >= 1 && /根号/.test(s.rows[0]), s.rows.join(' | '));
  await page.keyboard.press('Enter');
  await wait(450);
  s = await state();
  check('面板已关', s.open === false);
  check('插进来的是根号', /\\sqrt/.test(s.latex), s.latex);
  check('光标落在根号里面', s.pos === 2, 'pos=' + s.pos);

  /* ---------- 3. 排序：al 应该是 alpha ---------- */
  console.log('\n[3] 搜 al：第一项必须是 alpha');
  await reset();
  await open();
  await typeIn('al');
  s = await state();
  check('第一项是 #alpha', /^#alpha/.test(s.rows[0] || ''), s.rows.slice(0, 3).join(' | '));
  check('别名 #all 不在第一位', !/^#all/.test(s.rows[0] || ''), s.rows[0]);
  await page.keyboard.press('Enter');
  await wait(380);
  s = await state();
  check('插入的是 \\alpha', /\\alpha/.test(s.latex), s.latex);

  /* ---------- 4. 大写的 Alpha 仍然选得到 ---------- */
  console.log('\n[4] ↓ 选中第二项');
  await reset();
  await open();
  await typeIn('al');
  await page.keyboard.press('ArrowDown');
  await wait(220);
  s = await state();
  check('高亮挪到第二项', /^#Alpha/.test(s.sel.trim()), 'sel=' + s.sel.trim());
  await page.keyboard.press('Enter');
  await wait(380);
  s = await state();
  check('插进来的是另一条（不是 \\alpha）', !/\\alpha/.test(s.latex), s.latex);

  /* ---------- 5. 插结构后能直接接着打 ---------- */
  console.log('\n[5] 搜「分数」→ Enter → 打 a');
  await reset();
  await open();
  await typeIn('分数');
  s = await state();
  check('分数排在最前', /分数线/.test(s.rows[0] || ''), s.rows.slice(0, 2).join(' | '));
  await page.keyboard.press('Enter');
  await wait(500);
  await page.keyboard.type('a');
  await wait(320);
  s = await state();
  check('a 进了分子', /\\frac\{a\}/.test(s.latex), s.latex);

  /* ---------- 6. 块左边界插入 ---------- */
  console.log('\n[6] 贴着 Cu 左边界插 alpha');
  await reset();
  await typeIn('$Cu ');
  for (let i = 0; i < 14; i++) {
    const q = await page.evaluate(() => {
      const mf = document.getElementById('mf');
      const u = window.__FE.units()[0];
      return { p: mf.position, s: u ? u.start : 0 };
    });
    if (q.p <= q.s) break;
    await page.keyboard.press('ArrowLeft');
    await wait(170);
  }
  await open();
  await typeIn('alpha');
  await page.keyboard.press('Enter');
  await wait(420);
  s = await state();
  const u6 = await units();
  check('alpha 落在块外（整体还是 1 个）', u6.length === 1, JSON.stringify(u6));
  check('alpha 在 Cu 左边', /^\\alpha\\htmlData/.test(s.latex), s.latex.slice(0, 40));

  /* ---------- 7. Esc / Ctrl+K 收起 ---------- */
  console.log('\n[7] Esc 与再按一次 Ctrl+K');
  await reset();
  await open();
  await page.keyboard.press('Escape');
  await wait(260);
  s = await state();
  check('Esc 关掉了', s.open === false);
  await open();
  await page.keyboard.press('Escape');
  await wait(200);
  await open();
  s = await state();
  check('关掉后还能再开', s.open === true);
  await open();                                   // 面板开着时再按一次 = 收起
  await wait(240);
  s = await state();
  check('面板开着时 Ctrl+K 收起', s.open === false);

  /* ---------- 8. 鼠标点一行 ---------- */
  console.log('\n[8] 点列表中的一行');
  await reset();
  await open();
  await typeIn('根号');
  const box = await page.evaluate(() => {
    const r = document.querySelector('.cmdk-item').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await wait(420);
  s = await state();
  check('点一下就插入了', /\\sqrt/.test(s.latex), s.latex);
  check('点完面板关掉', s.open === false);

  /* ---------- 9. 关掉后还能继续打字 ---------- */
  console.log('\n[9] 关闭后焦点回到公式');
  await reset();
  await open();
  await page.keyboard.press('Escape');
  await wait(260);
  await page.keyboard.type('x');
  await wait(260);
  s = await state();
  check('接着打的字进了公式', s.latex === 'x', s.latex);

  await browser.close();
  console.log('\n' + (fails.length ? '失败 ' + fails.length + ' 项：' + fails.join('、') : '命令面板全部正确'));
  process.exit(fails.length ? 1 : 0);
})();
