/**
 * 启动器 —— 唯一的职责是把 ELECTRON_RUN_AS_NODE 从环境里摘掉
 *
 * 有些 IDE / 终端会预设 ELECTRON_RUN_AS_NODE=1，此时 electron.exe 会退化成
 * 纯 Node 进程去跑 main.js，于是 `require('electron')` 拿到的是一个路径字符串，
 * 第一行 ipcMain.handle 就炸。启动器兜住这个坑，`npm start` 在任何终端都一致。
 */
const { spawn } = require('node:child_process');
const electronPath = require('electron');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronPath, ['.'].concat(process.argv.slice(2)), {
  stdio: 'inherit',
  env: env,
  windowsHide: false
});

child.on('exit', function (code, signal) {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 0 : code);
});
