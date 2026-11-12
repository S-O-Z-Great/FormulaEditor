/**
 * 全局热键自检 —— 注册一个组合键，然后用常驻助手的 keybd_event 真按一下。
 *
 * 这一步验证的是「Electron 的 globalShortcut 在本机到底能不能收到按键」。
 * 它和正式插件用不同的组合（Ctrl+Alt+W），所以插件在跑着也能测。
 *
 *   npm run test:hotkey
 *
 * 为什么要绕这么远：直接按键盘只有人能做，而「注册成功」和「按下去有反应」
 * 是两件事 —— RegisterHotKey 成功不代表回调会来（被前台锁、被别的程序截、
 * 或者进程其实已经死了）。这里把后半段也盖住。
 */
const { app, globalShortcut } = require('electron');
const paster = require('../src/lib/paste');

const ACCEL = 'Control+Alt+W';
let fired = false;

function fail(msg) {
  console.log('FAIL ' + msg);
  app.exit(1);
}

app.disableHardwareAcceleration();

app.whenReady().then(async function () {
  const ok = globalShortcut.register(ACCEL, function () { fired = true; });
  console.log('register(' + ACCEL + ')=' + ok);
  if (!ok) { fail('注册失败：这个组合已被占用'); return; }

  const warm = await paster.warmup();
  console.log('助手=' + (warm === 'pong' ? 'ok' : 'no-response'));
  if (warm !== 'pong') { paster.stop(); fail('粘贴助手没起来（C# 没编过？）'); return; }

  const sent = await paster.combo('ctrl+alt+w');
  console.log('模拟按键=' + sent);

  // 给 WM_HOTKEY 一点时间派发
  await new Promise(function (r) { setTimeout(r, 800); });

  globalShortcut.unregisterAll();
  paster.stop();

  if (fired) {
    console.log('PASS 热键回调已触发（注册 + 按键整条链路是通的）');
    app.exit(0);
  } else {
    fail('注册成功但回调没来 —— 按键被截或进程没收到');
  }
});
