/**
 * 自动粘贴链路自检 —— 验的是「最后那一公里」：东西到底有没有落进目标窗口
 *
 * 步骤（全程真窗口，不用 mock）：
 *   1. 用 clip.exe 往剪贴板塞一段标记文本
 *   2. 开一个记事本，等它拿到前台焦点
 *   3. grab() 记下前台窗口句柄 → paste() 把焦点还回去并发 Ctrl+V
 *   4. selall() 全选复制 → 用 Get-Clipboard 把内容读回来比对
 *   5. 杀掉记事本
 *
 * 注意：会短暂抢一下焦点（约 3 秒），跑的时候别在打字。
 *
 * 用法：node test/paste.e2e.js
 */
const { spawn, spawnSync } = require('node:child_process');
const paster = require('../src/lib/paste');

const MARK = 'FE-PASTE-' + Date.now().toString(36);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setClipboard(text) {
  const r = spawnSync('clip.exe', [], { input: text, encoding: 'utf8' });
  return r.status === 0;
}

function getClipboard() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], {
    encoding: 'utf8',
    windowsHide: true
  });
  return (r.stdout || '').replace(/\r\n/g, '\n').trim();
}

(async () => {
  const fails = [];
  const ok = (name, cond, extra) => {
    if (cond) console.log('  ok   ' + name);
    else { fails.push(name); console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
  };

  console.log('自动粘贴链路自检');

  ok('剪贴板写入可用', setClipboard(MARK));

  const pad = spawn('notepad.exe', [], { stdio: 'ignore' });
  await wait(1400);   // 等记事本起来并拿到前台

  const hwnd = await paster.grab();
  ok('能抓到前台窗口句柄', /^\d+$/.test(hwnd) && hwnd !== '0', 'hwnd=' + hwnd);

  const pasted = await paster.paste(hwnd);
  ok('Ctrl+V 已发出', pasted === true);
  await wait(700);

  // 先把剪贴板换成一个哨兵值：这样「回读到标记」才说明是记事本里的内容，
  // 而不是一开始就躺在剪贴板里的那份（否则这一步会假通过）。
  setClipboard('SENTINEL');
  await paster.selectAllCopy();
  await wait(500);

  const back = getClipboard();
  ok('内容真的进了记事本', back.indexOf(MARK) >= 0, '回读=' + JSON.stringify(back.slice(0, 80)));

  paster.stop();
  try { spawnSync('taskkill', ['/PID', String(pad.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}

  console.log(fails.length ? '\n失败 ' + fails.length + ' 项：' + fails.join('、') : '\n全部通过');
  process.exit(fails.length ? 1 : 0);
})();
