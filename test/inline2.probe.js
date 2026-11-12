const puppeteer = require('puppeteer-core');
const EDGE = 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.setViewport({ width: 900, height: 420 });
  p.on('pageerror', e => console.log('[pageerror] ' + e.message));
  await p.goto('file:///E:/FormulaEditor/src/index.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));

  const v = () => p.evaluate(() => document.getElementById('mf').getValue('latex'));
  const reset = async () => { await p.keyboard.press('Escape'); await p.evaluate(() => { const mf = document.getElementById('mf'); mf.blur(); mf.value = ''; mf.focus(); mf.executeCommand(['moveToMathfieldStart']); }); };

  // 1. 就地输入：#alpha 全过程（打完停在候选态，Enter 才转换）
  await reset();
  let steps = [];
  for (const ch of '#alpha') {
    await p.keyboard.type(ch);
    await new Promise(r => setTimeout(r, 60));
    steps.push(ch + '→' + JSON.stringify(await v()));
  }
  await p.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 150));
  steps.push('Enter→' + JSON.stringify(await v()));
  console.log('逐键(就地): ' + steps.join('  '));

  // 2. #al 候选 + 空格上屏
  await reset();
  await p.keyboard.type('#al');
  await new Promise(r => setTimeout(r, 200));
  const candInfo = await p.evaluate(() => {
    const c = document.getElementById('cand');
    const r = c.getBoundingClientRect();
    return { hidden: c.hidden, left: Math.round(r.left), top: Math.round(r.top), items: c.innerText.replace(/\n/g, ' | ') };
  });
  console.log('候选条: hidden=' + candInfo.hidden + ' 位置=' + candInfo.left + ',' + candInfo.top + ' 内容=' + candInfo.items);
  await p.keyboard.press('Space');
  await new Promise(r => setTimeout(r, 150));
  console.log('#al + 空格 => ' + JSON.stringify(await v()));

  // 3. Esc 取消
  await reset();
  await p.keyboard.type('#nab');
  await new Promise(r => setTimeout(r, 150));
  console.log('#nab 待定时 latex=' + JSON.stringify(await v()));
  await p.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 150));
  console.log('#nab + Esc => ' + JSON.stringify(await v()));

  // 4. 退格
  await reset();
  await p.keyboard.type('#alp');
  await new Promise(r => setTimeout(r, 100));
  await p.keyboard.press('Backspace');
  await new Promise(r => setTimeout(r, 100));
  console.log('#alp + 退格 => ' + JSON.stringify(await v()));

  // 5. 变量
  await reset();
  await p.keyboard.type('##Tom##');
  await new Promise(r => setTimeout(r, 200));
  console.log('##Tom## => ' + JSON.stringify(await v()));

  // 6. 结构触发
  await reset();
  await p.keyboard.type('#--');
  await new Promise(r => setTimeout(r, 120));
  await p.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 350));
  await p.keyboard.type('7');
  await new Promise(r => setTimeout(r, 100));
  console.log('#-- + Enter 后打 7 => ' + JSON.stringify(await v()));

  // 7. 变量名里夹符号码：## + #alpha + Enter + ##
  await reset();
  await p.keyboard.type('##');
  await new Promise(r => setTimeout(r, 120));
  await p.keyboard.type('#alpha');
  await new Promise(r => setTimeout(r, 200));
  await p.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 250));
  await p.keyboard.type('##');
  await new Promise(r => setTimeout(r, 300));
  console.log('##+#alpha+Enter+## => ' + JSON.stringify(await v()));

  await b.close();
})();
