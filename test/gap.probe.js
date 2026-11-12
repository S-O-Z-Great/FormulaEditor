/* 实体之间的符号（第 20 批）
 * 用户报：「两个元素符号之间如果有其他符号，光标只会在该符号左右两边的元素符号间切换，
 * 而越过了元素之间的符号，比如加号」。
 *
 * 根因：方向键 / Tab 的「跨实体」只问 `fieldNext()`（整篇文档的槽位表），
 * 而 `+`、`=`、数字不是槽，表里没有它们——于是从 `Cu` 的最后一格一步就跨到 `O` 的第一格。
 *
 * 现在：`gapAtomNear()` 找光标左/右最近的「既不属于任何整体、也不在槽里」的原子，
 * 先停在它后面（Tab 走 `tabGapPos()`，方向键直接用它）。
 * 光标落在实体**主体**上（不在格内）时不跳，否则会越过还没访问的槽。 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 340 });
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
  const type = async (text) => {
    for (const ch of text) {
      if (ch === '\t') await page.keyboard.press('Tab');
      else await page.keyboard.type(ch);
      await wait(150);
    }
    await wait(240);
  };
  const key = async (k) => { await page.keyboard.press(k); await wait(200); };
  const pos = () => page.evaluate(() => document.getElementById('mf').position);
  const units = () => page.evaluate(() => window.__FE.units().map((u) => ({ s: u.start, e: u.end })));

  /** 某个字符（`+` / `-` / `=`）在 offset 轴上的位置 */
  const markPos = (kind) => page.evaluate((want) => {
    const rows = window.__FE.probe();
    for (let i = 0; i < rows.length; i++) {
      const at = rows[i].at || '';
      if (want === '+' && at === 'mbin:+') return rows[i].p;
      if (want === '-' && (at === 'mbin:-' || at === 'mbin:\u2212' || at === 'mbin:\uFF0D')) return rows[i].p;
      if (want === '=' && at === 'mrel:=') return rows[i].p;
    }
    return null;
  }, kind);

  /** 一路 ← 按到底（文档最左边可能还有 2、+ 这类不属于整体的原子） */
  const toStart = async () => {
    for (let i = 0; i < 30; i++) {
      const a = await pos();
      await key('ArrowLeft');
      if ((await pos()) === a) return;
    }
  };
  /** 从当前位置连按 n 次某个键，返回每次按键后的位置序列 */
  const walk = async (n, k) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      await key(k);
      out.push(await pos());
    }
    return out;
  };
  const has = (seq, v) => seq.indexOf(v) >= 0;
  function check(name, ok, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + detail);
    if (!ok) fails.push(name + ' → ' + detail);
  }

  console.log('\n[1] Cu + O：→ 要经过加号');
  await reset();
  await type('$Cu +$O ');
  const plus = await markPos('+');
  await toStart();
  let seq = await walk(10, 'ArrowRight');
  check('加号在 → 序列里', plus != null && has(seq, plus), 'plus@' + plus + ' seq=' + seq.join(','));

  console.log('\n[2] Cu + O：← 要经过加号');
  await reset();
  await type('$Cu +$O ');
  seq = await walk(8, 'ArrowLeft');
  check('加号在 ← 序列里', has(seq, plus), 'plus@' + plus + ' seq=' + seq.join(','));

  console.log('\n[3] Cu + O：Tab 也要经过加号');
  await reset();
  await type('$Cu +$O ');
  await toStart();
  seq = await walk(8, 'Tab');
  check('加号在 Tab 序列里', has(seq, plus), 'plus@' + plus + ' seq=' + seq.join(','));

  console.log('\n[4] Cu + O：Shift+Tab 从 O 第一格回来也要经过加号');
  await reset();
  await type('$Cu +$O ');
  // 光标在 O 的某一格；先 Tab 一下确保在 O 的第一格附近，再一路 Shift+Tab
  seq = await walk(6, 'Tab');
  seq = await walk(6, 'Tab');   // 这一步会走完 O 的四格，回到 O 开头
  const back = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    await wait(200);
    back.push(await pos());
  }
  check('加号在 Shift+Tab 序列里', has(back, plus), 'plus@' + plus + ' seq=' + back.join(','));

  console.log('\n[5] 两个元素紧挨着（CuO）：全部 8 格都走到，且没有多余的落脚点');
  await reset();
  await type('$Cu $O ');
  await toStart();
  const cares = await page.evaluate(() => window.__FE.fields().map((f) => f.caret));
  seq = await walk(10, 'ArrowRight');
  const uniq = Array.from(new Set(seq));
  const allHit = cares.every((c) => uniq.indexOf(c) >= 0);
  check('8 个格都走到、没有额外停靠', allHit && uniq.length <= cares.length + 1,
    'cares=' + cares.join(',') + ' uniq=' + uniq.join(','));

  console.log('\n[6] Cu = O：等号也经过');
  await reset();
  await type('$Cu =$O ');
  const eq = await markPos('=');
  await toStart();
  seq = await walk(10, 'ArrowRight');
  check('等号在 → 序列里', eq != null && has(seq, eq), 'eq@' + eq + ' seq=' + seq.join(','));

  console.log('\n[7] 2Cu + 3O：元素左边的数字也各占一步');
  await reset();
  await type('$Cu ');
  await toStart();
  await type('2');
  await type('+');
  await type('3');
  await type('$O ');
  await toStart();
  const plus2 = await markPos('+');
  seq = await walk(14, 'ArrowRight');
  check('加号仍在序列里', plus2 != null && has(seq, plus2),
    'plus@' + plus2 + ' seq=' + seq.join(','));

  console.log('\n' + (fails.length ? '失败 ' + fails.length + ' 项' : '实体之间的符号全部正确'));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
