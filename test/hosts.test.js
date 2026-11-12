/**
 * 宿主识别与格式配方 —— 这张表错了，粘出去的东西就会「假成功」
 * （最典型：Word 挑中 HTML 却解析不了 MathML，吐一片空白，用户以为成了）
 */
const H = require('../src/lib/hosts.js');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + JSON.stringify(actual) + '\n       want ' + JSON.stringify(expected)); }
}

console.log('\n[1] 进程名归一化');
eq('去 .exe', H.normProc('WINWORD.EXE'), 'winword');
eq('全路径只留文件名', H.normProc('C:\\Program Files\\Tencent\\Weixin\\Weixin.exe'), 'weixin');
eq('正斜杠路径', H.normProc('/usr/bin/Code.exe'), 'code');
eq('小写化', H.normProc('Notepad'), 'notepad');
eq('空值不炸', H.normProc(null), '');

console.log('\n[2] 认宿主（按进程名）');
eq('Word', H.classify({ proc: 'WINWORD.EXE' }).id, 'word');
eq('WPS 文字', H.classify({ proc: 'wps' }).id, 'word');
eq('WPS 表格', H.classify({ proc: 'et' }).id, 'excel');
eq('WPS 演示', H.classify({ proc: 'wpp' }).id, 'ppt');
eq('Excel', H.classify({ proc: 'EXCEL' }).id, 'excel');
eq('PowerPoint', H.classify({ proc: 'POWERPNT' }).id, 'ppt');
eq('微信', H.classify({ proc: 'Weixin.exe' }).id, 'chat');
eq('QQ', H.classify({ proc: 'QQ' }).id, 'chat');
eq('Chrome', H.classify({ proc: 'chrome' }).id, 'browser');
eq('Edge', H.classify({ proc: 'msedge' }).id, 'browser');
eq('VSCode', H.classify({ proc: 'Code' }).id, 'markdown');
eq('Obsidian', H.classify({ proc: 'obsidian' }).id, 'markdown');
eq('记事本', H.classify({ proc: 'notepad' }).id, 'notepad');
eq('Notepad++', H.classify({ proc: 'notepad++' }).id, 'markdown');
eq('Windows Terminal', H.classify({ proc: 'WindowsTerminal' }).id, 'terminal');

console.log('\n[3] 认不出进程时看窗口类名');
eq('OpusApp → Word', H.classify({ proc: 'unknownthing', cls: 'OpusApp' }).id, 'word');
eq('XLMAIN → Excel', H.classify({ proc: '', cls: 'XLMAIN' }).id, 'excel');
eq('ConsoleWindowClass → 终端', H.classify({ proc: '', cls: 'ConsoleWindowClass' }).id, 'terminal');
eq('什么都没有 → 未知', H.classify({}).id, 'unknown');
// 浏览器和 Electron 应用的窗口类名都是这个，所以类名不能用来认浏览器
eq('Chrome_WidgetWin_1 不足以认浏览器', H.classify({ proc: 'unknownthing', cls: 'Chrome_WidgetWin_1' }).id, 'unknown');

console.log('\n[4] 自动配方');
const wordPlan = H.plan({ proc: 'wps' });
eq('WPS 出白底图', wordPlan.png, 'white');
eq('WPS 不给 HTML（它解析不了 MathML）', wordPlan.html, false);
eq('WPS 文字是裸 LaTeX', wordPlan.text, 'bare');
eq('Excel 只给文本', [H.plan({ proc: 'excel' }).png, H.plan({ proc: 'excel' }).html], [null, false]);
eq('微信出白底图', H.plan({ proc: 'Weixin' }).png, 'white');
eq('记事本只给文本', [H.plan({ proc: 'notepad' }).png, H.plan({ proc: 'notepad' }).html], [null, false]);
const webPlan = H.plan({ proc: 'chrome' });
eq('浏览器给 MathML', webPlan.html, true);
eq('浏览器的文本带 $', webPlan.text, 'dollar');
eq('浏览器不出图', webPlan.png, null);
eq('Markdown 带 $ 且不出图', [H.plan({ proc: 'Code' }).text, H.plan({ proc: 'Code' }).png], ['dollar', null]);
eq('未知宿主退回三种全给', [H.plan({}).html, H.plan({}).png], [true, 'transparent']);

console.log('\n[5] 手动覆盖（记住的格式优先）');
eq('手动选图片 → 白底', H.plan({ proc: 'notepad' }, 'png').png, 'white');
eq('手动选图片 → 不再给 HTML', H.plan({ proc: 'chrome' }, 'png').html, false);
eq('手动选纯文本 → 不出图', H.plan({ proc: 'wps' }, 'text').png, null);
eq('手动选文本+$', H.plan({ proc: 'notepad' }, 'dollar').text, 'dollar');
eq('手动选 MathML', H.plan({ proc: 'chrome' }, 'mathml').html, true);
eq('手动选透明图', H.plan({ proc: 'wps' }, 'pngclear').png, 'transparent');
eq('auto 等于不覆盖', H.plan({ proc: 'wps' }, 'auto').png, 'white');
eq('覆盖不改变 host 识别', H.plan({ proc: 'wps' }, 'text').host.id, 'word');

console.log('\n[6] 定界符');
eq('裸文本不加 $', H.delimit('\\frac{a}{b}', { text: 'bare' }), '\\frac{a}{b}');
eq('Markdown 加 $', H.delimit('\\frac{a}{b}', { text: 'dollar' }), '$\\frac{a}{b}$');
eq('已有 $ 不套两层', H.delimit('$x$', { text: 'dollar' }), '$x$');
eq('已有 $$ 不套两层', H.delimit('$$x$$', { text: 'dollar' }), '$$x$$');
eq('空内容', H.delimit('  ', { text: 'dollar' }), '');

console.log('\n[7] 配方说明（界面上那句提示）');
eq('WPS 的说明', H.plan({ proc: 'wps' }).summary, 'LaTeX + 白底图片');
eq('记事本的说明', H.plan({ proc: 'notepad' }).summary, 'LaTeX');
eq('浏览器的说明', H.plan({ proc: 'chrome' }).summary, 'LaTeX + $ + MathML');

console.log('\n' + (fail === 0 ? '全部通过 ' + pass + ' 项' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
