/**
 * 自动粘贴 —— 把「写完剪贴板」变成「内容真的出现在原来那个输入框里」
 *
 * Electron 自己没法给别的应用发按键，所以借一个常驻的 PowerShell 进程调 Win32。
 * 进程在应用启动时就拉起来（见 warmup），之后每次粘贴只是往 stdin 写一行。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

let proc = null;
let buf = '';
let queue = [];
let starting = false;

function start() {
  if (proc || starting) return;
  starting = true;
  const script = path.join(__dirname, 'paste.ps1');
  try {
    proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
  } catch (e) {
    starting = false;
    proc = null;
    return;
  }

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', function (chunk) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      const resolve = queue.shift();
      if (resolve) resolve(line);
    }
  });

  proc.on('exit', function () {
    proc = null;
    starting = false;
    const pending = queue;
    queue = [];
    pending.forEach(function (r) { r(''); });
  });

  proc.on('error', function () {
    proc = null;
    starting = false;
  });

  // 等 C# 编译完（Add-Type 要 300~600ms），期间发的命令会堆在 queue 里
  starting = false;
}

/** 发一条命令并等它回一行，超时返回 ''（粘贴失败不该卡住界面） */
function send(cmd, timeout) {
  start();
  const ms = timeout || 2500;
  return new Promise(function (resolve) {
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      const i = queue.indexOf(handler);
      if (i >= 0) queue.splice(i, 1);
      resolve('');
    }, ms);

    function handler(line) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(line);
    }

    if (!proc) { done = true; clearTimeout(timer); resolve(''); return; }
    queue.push(handler);
    try { proc.stdin.write(cmd + '\n'); } catch (e) { handler(''); }
  });
}

/** 预热：应用启动时调一次，把 PowerShell + C# 的启动成本挪到空闲时 */
function warmup() {
  start();
  return send('ping', 8000);
}

/** 记下当前前台窗口句柄（必须在面板抢焦点之前调） */
async function grab() {
  const r = await send('grab', 1200);
  return /^\d+$/.test(r) && r !== '0' ? r : '';
}

/**
 * 前台窗口是谁 —— 必须在面板抢焦点之前调，否则拿到的是自己。
 * 返回 { hwnd, proc, cls }；proc 是进程名（不带 .exe），cls 是窗口类名。
 * 这两个信息决定往剪贴板里写什么格式（见 lib/hosts.js）。
 */
async function host() {
  const r = await send('host', 1500);
  if (!r || r === 'err') return { hwnd: '', proc: '', cls: '' };
  const p = String(r).split('|');
  const hwnd = /^\d+$/.test(p[0] || '') && p[0] !== '0' ? p[0] : '';
  return { hwnd: hwnd, proc: (p[1] || '').trim(), cls: (p[2] || '').trim() };
}

/** 把焦点还给 hwnd 并粘贴；返回是否成功 */
async function paste(hwnd) {
  const r = await send(hwnd ? 'paste ' + hwnd : 'paste');
  return r === 'ok';
}

/** 前台窗口标题（助手回 base64，这里解码成真字符串；拿不到返回 ''） */
async function windowTitle() {
  const r = await send('title', 1500);
  if (!r || r === 'err') return '';
  try {
    return Buffer.from(r, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

/**
 * 按标题（部分匹配）找可见的顶层窗口 → { hwnd, title }。
 * Process.MainWindowHandle 对 WPS 这种「文档装在框架窗口里」的程序会拿错句柄，
 * 真要切窗口得靠标题找。
 */
async function find(text) {
  const r = await send('find ' + String(text || ''), 1500);
  if (!r || r === 'none') return { hwnd: '', title: '' };
  const i = r.indexOf('|');
  if (i < 0) return { hwnd: '', title: '' };
  const hwnd = r.slice(0, i);
  let title = '';
  try { title = Buffer.from(r.slice(i + 1), 'base64').toString('utf8'); } catch (e) { title = ''; }
  return { hwnd: /^\d+$/.test(hwnd) && hwnd !== '0' ? hwnd : '', title: title };
}

/** 把指定窗口切到前台（不带按键，自检用） */
async function focus(hwnd) {
  if (!hwnd) return false;
  // 超时给宽一点：助手刚启动时 Add-Type 要编译 C#，第一条命令容易赶不上
  return (await send('focus ' + hwnd, 4000)) === 'ok';
}

/** 给前台窗口发 Ctrl+Z（自检用：验证完把内容撤掉） */
async function undo() {
  return (await send('undo', 1500)) === 'ok';
}

/** 全选并复制当前前台窗口的内容（自检用：验证内容真的落进了目标窗口） */
async function selectAllCopy() {
  return (await send('selall', 2000)) === 'ok';
}

/** 发一个组合键，例如 'ctrl+alt+q'（自检热键用，正常流程用不到） */
async function combo(spec) {
  return (await send('combo ' + spec, 3000)) === 'ok';
}

function stop() {
  try {
    if (proc) {
      proc.stdin.write('quit\n');
      setTimeout(function () { try { proc.kill(); } catch (e) {} }, 300);
    }
  } catch (e) { /* 已经没了 */ }
  proc = null;
  queue = [];
  buf = '';
}

module.exports = { warmup, grab, host, windowTitle, find, focus, undo, paste, selectAllCopy, combo, stop };
