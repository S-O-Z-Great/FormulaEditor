/**
 * 跑一个 Electron 脚本（自检用）：`node scripts/run-electron.js test/xxx.js`
 *
 * 和 start.js 一样摘掉 ELECTRON_RUN_AS_NODE —— 留着它 electron.exe 会退化成纯 node，
 * 脚本里 require('electron') 拿到的是路径字符串，app / globalShortcut 全是 undefined。
 */
const { spawn } = require('node:child_process');
const electronPath = require('electron');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法：node scripts/run-electron.js <脚本> [参数...]');
  process.exit(2);
}

const child = spawn(electronPath, args, { stdio: 'inherit', env: env, windowsHide: false });
child.on('exit', function (code) { process.exit(code == null ? 0 : code); });
