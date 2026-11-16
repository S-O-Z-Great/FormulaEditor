const E = require('../src/engine.js');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + JSON.stringify(actual) + '\n       want ' + JSON.stringify(expected)); }
}

console.log('\n[1] # 查询');
eq('alpha 精确命中', E.query('alpha').exact.x, '\\alpha');
eq('alpha 无更长候选（应立即转换）', E.query('alpha').canExtend, false);
eq('a 存在更长候选（应等待）', E.query('a').canExtend, true);
eq('U 命中并集', E.query('U').exact.d, '并集（形似 U）');
eq('n 命中交集', E.query('n').exact.x, '\\cap');
eq('A 命中排列数', E.query('A').exact.x, '\\mathrm{A}_{$0}^{}');
eq('A 仍能切到任意', E.query('A').candidates.some((e) => e.x === '\\forall'), true);
eq('!A 命中任意', E.query('!A').exact.x, '\\forall');
eq('all 也命中任意', E.query('all').exact.x, '\\forall');
eq('E 命中存在', E.query('E').exact.x, '\\exists');
eq('-- 命中分式', E.query('--').exact.x, '\\frac{$0}{}');
eq('—— 命中分式', E.query('——').exact.x, '\\frac{$0}{}');
eq('S 命中积分', E.query('S').exact.x, '\\int_{$0}^{}');
eq('s 也命中积分', E.query('s').exact.x, '\\int_{$0}^{}');
eq('II 命中连乘', E.query('II').exact.x, '\\prod_{$0}^{}');
eq('~= 命中约等于', E.query('~=').exact.x, '\\approx');
eq('~ 命中相似', E.query('~').exact.x, '\\sim');
eq('= 命中化学等号', E.query('=').exact.x, '\\;=\\;');
eq("' 命中导数撇", E.query("'").exact.x, '\\prime');
eq('Alpha 输出拉丁同形', E.query('Alpha').exact.x, 'A');
eq('Gamma 输出希腊大写命令', E.query('Gamma').exact.x, '\\Gamma');
eq('si 同时是 sigma / sin / sinh 的前缀', E.query('si').candidates.some((e) => e.t === 'sigma'), true);
eq('si 也命中 sin', E.query('si').candidates.some((e) => e.t === 'sin'), true);
eq('无匹配时返回空候选（不作废，等继续输入）', E.query('sq').candidates.length, 0);
eq('sigma 最终命中', E.query('sigma').exact.x, '\\sigma');

console.log('\n[1b] 图形拼装 / 翻转 / 箭头（新增语法）');
eq('(S) 环路积分', E.query('(S)').exact.x, '\\oint_{$0}^{}');
eq('(/） 空集', E.query('(/)').exact.x, '\\varnothing');
eq('(- 属于', E.query('(-').exact.x, '\\in');
eq('!(- 不属于', E.query('!(-').exact.x, '\\notin');
eq('[[ 下取整', E.query('[[').exact.x, '\\lfloor \\placeholder{} \\rfloor');
eq(']] 上取整', E.query(']]').exact.x, '\\lceil \\placeholder{} \\rceil');
eq('C_ 子集', E.query('C_').exact.x, '\\subseteq');
eq('!C_ 超集', E.query('!C_').exact.x, '\\supseteq');
eq('C 同码三义（组合数 / 真子集 / 补集）', E.query('C').candidates.filter((e) => e.t === 'C').length, 3);
eq('(SS) 二重积分', E.query('(SS)').exact.x, '\\iint_{$0}^{}');
eq('(SSS) 三重积分', E.query('(SSS)').exact.x, '\\iiint_{$0}^{}');
eq('(Sn) n 重积分', E.query('(Sn)').exact.d, 'n 重积分（更多重数）');
eq('!6 偏导', E.query('!6').exact.x, '\\partial');
eq('!D 梯度', E.query('!D').exact.x, '\\nabla');
eq('!D2 拉普拉斯', E.query('!D2').exact.x, '\\nabla^2');
eq('|- 推出', E.query('|-').exact.x, '\\vdash');
eq('<=> 等价', E.query('<=>').exact.x, '\\Leftrightarrow');
eq('-> 趋于', E.query('->').exact.x, '\\to');
eq('|-> 映射', E.query('|->').exact.x, '\\mapsto');
eq('tri= 定义为', E.query('tri=').exact.x, '\\triangleq');
eq('_|_ 垂直', E.query('_|_').exact.x, '\\perp');
eq('【2 方程组', E.query('{2').exact.x, '\\begin{cases}\\placeholder{}\\\\\\placeholder{}\\end{cases}');
eq('m2 矩阵', E.query('m2').exact.x, '\\begin{pmatrix}\\placeholder{}&\\placeholder{}\\\\\\placeholder{}&\\placeholder{}\\end{pmatrix}');
eq('C 默认取组合数', E.query('C').exact.x, '\\binom{$0}{}');

console.log('\n[1c] 二次解析（##X：先 #X 得字符，再把字符当码解析一次）');
eq('Sigma 第一遍是 Σ', E.query('Sigma').exact.x, '\\Sigma');
eq('Θ 本身是触发码', E.query('Θ').exact.x, '\\ominus');
eq('##Sigma → ∑', E.secondPass('Sigma').entry.x, '\\sum_{$0}^{}');
eq('##Sigma 中间字符', E.secondPass('Sigma').char, 'Σ');
eq('##Sigma 第一遍仍是 Sigma', E.secondPass('Sigma').first.t, 'Sigma');
eq('##Theta → ⊖', E.secondPass('Theta').entry.x, '\\ominus');
eq('普通码没有第二遍（alpha）', E.secondPass('alpha'), null);
eq('结构类没有第二遍（S）', E.secondPass('S'), null);
eq('不存在的码没有第二遍（Tom）', E.secondPass('Tom'), null);

console.log('\n[2] 展开与光标落点');


console.log('\n[2] 展开与光标落点');eq('分式光标在分子', E.expand(E.query('--').exact), { text: '\\frac{}{}', caret: 6 });
eq('积分光标在下限', E.expand(E.query('S').exact), { text: '\\int_{}^{}', caret: 6 });
eq('连乘光标在下限', E.expand(E.query('II').exact), { text: '\\prod_{}^{}', caret: 7 });

console.log('\n[3] 结构解析');
let src = '\\frac{a}{b}';
let st = E.collect(src);
eq('识别分式', st.length, 1);
eq('分子槽', st[0].slots.up, [6, 7]);
eq('分母槽', st[0].slots.down, [9, 10]);

st = E.collect('\\int_{0}^{1} x');
eq('积分识别为 bigop', st[0].type, 'bigop');
eq('积分只有 sup/sub（无 up/down）', Object.keys(st[0].slots).sort(), ['sub', 'sup']);

st = E.collect('\\sum_{i=1}^{n} a');
eq('求和只有 up/down（无 sup/sub）', Object.keys(st[0].slots).sort(), ['down', 'up']);

st = E.collect('\\sqrt{x}');
eq('根式内部槽', st[0].slots.in, [6, 7]);

st = E.collect('\\left(a\\right)');
eq('括号内部槽', st[0].slots.in, [6, 7]);
eq('括号结构范围', [st[0].start, st[0].end], [0, 13]);

console.log('\n[4] Ctrl+方向键');
src = '\\frac{a}{b}';
eq('分母 Ctrl+↑ 回分子', src[E.navigate(src, 9, 'up')], 'a');
eq('分子 Ctrl+↓ 到分母', src[E.navigate(src, 6, 'down')], 'b');
eq('分子 Ctrl+→ 跳出到右侧', E.navigate(src, 6, 'right'), 11);
eq('分子 Ctrl+← 跳到左侧', E.navigate(src, 6, 'left'), 0);

src = '\\int_{0}^{1} {x}';
eq('积分体 Ctrl+↓ 进右下下限', src[E.navigate(src, 14, 'down')], '0');
eq('积分体 Ctrl+Shift+↑ 进右上上限', src[E.navigate(src, 14, 'sup')], '1');
eq('积分体 Ctrl+↑ 也落上限（无正上时回退）', src[E.navigate(src, 14, 'up')], '1');

src = '\\sum_{i=1}^{n} a';
eq('求和 Ctrl+↑ 进正上', src[E.navigate(src, 14, 'up')], 'n');
eq('求和 Ctrl+↓ 进正下', src[E.navigate(src, 14, 'down')], 'i');

src = '\\frac{\\frac{a}{b}}{c}';
eq('嵌套：分母 Ctrl+↑ 到外层分子', src[E.navigate(src, 19, 'up')], '\\');
eq('嵌套：再 Ctrl+↑ 进内层分子', src[E.navigate(src, 6, 'up')], 'a');

console.log('\n[5] 当前槽与高亮');
let a = E.activeSlot('\\frac{a}{b}', 6);
eq('识别当前槽为分子', a.range, [6, 7]);
eq('高亮注入', E.highlight('\\frac{a}{b}', [6, 7]).indexOf('\\htmlClass{fe-slot}{a}') > 0, true);
eq('空槽高亮用 phantom', E.highlight('\\frac{}{}', [6, 6]).indexOf('\\phantom{x}') > 0, true);
eq('空槽列表', E.emptySlots('\\frac{}{}'), [6, 8]);

console.log('\n[6] 矩阵');
const mat = '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}';
st = E.collect(mat);
eq('矩阵识别', st[0].type, 'matrix');
eq('矩阵 2 行 2 列', [st[0].rows.length, st[0].rows[0].length], [2, 2]);
eq('矩阵 Ctrl+→ 到右单元格', E.navigate(mat, st[0].rows[0][0][0], 'right'), st[0].rows[0][1][0]);
eq('矩阵 Ctrl+↓ 到下一行', E.navigate(mat, st[0].rows[0][0][0], 'down'), st[0].rows[1][0][0]);

console.log('\n' + (fail === 0 ? '全部通过 ' + pass + ' 项' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
