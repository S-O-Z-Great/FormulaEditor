/**
 * LaTeX → EQ 域 —— 纯文本模式的最终产物
 *
 * 这里错的代价很具体：粘进 WPS 的不是公式，而是一串 `\s\do6(2)`，
 * 或者标着「错误!」的破域。所以每条映射都按真机实测过的写法钉死。
 */
const E = require('../src/lib/latex2eq.js');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + JSON.stringify(actual) + '\n       want ' + JSON.stringify(expected)); }
}
function has(name, hay, needle) {
  const ok = String(hay).indexOf(needle) >= 0;
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + JSON.stringify(hay)); }
}
function not(name, hay, needle) {
  const ok = String(hay).indexOf(needle) < 0;
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + JSON.stringify(hay)); }
}

console.log('\n[1] 分式与根号');
eq('分式', E.toEq('\\frac{1}{2}'), '\\f(1,2)');
eq('分式带表达式', E.toEq('\\frac{x+1}{2}'), '\\f(x+1,2)');
eq('空分母留空格（空的会报错）', E.toEq('\\frac{1}{}'), '\\f(1, )');
eq('平方根', E.toEq('\\sqrt{x}'), '\\r(x)');
eq('n 次根', E.toEq('\\sqrt[3]{x}'), '\\r(3,x)');
eq('根号里套分式', E.toEq('\\sqrt{\\frac{a}{b}}'), '\\r(\\f(a,b))');

console.log('\n[2] 上下标');
eq('上标', E.toEq('x^{2}'), 'x\\s\\up6(2)');
eq('下标', E.toEq('H_{2}O'), 'H\\s\\do6(2)O');
eq('化学式', E.toEq('\\mathrm{H_2SO_4}'), 'H\\s\\do6(2)SO\\s\\do6(4)');
eq('上下标连写', E.toEq('x_1^2'), 'x\\s\\do6(1)\\s\\up6(2)');
eq('核素左上标', E.toEq('{}^{14}_{6}C'), '\\s\\up6(14)\\s\\do6(6)C');

console.log('\n[3] 符号（EQ 直接用字符）');
eq('希腊字母与不等号', E.toEq('\\alpha \\le \\infty'), 'α≤∞');
eq('乘号与箭头', E.toEq('a \\times b \\to c'), 'a×b→c');
eq('求和', E.toEq('\\sum_{i=1}^{n}a_i'), 'Σ\\s\\do6(i=1)\\s\\up6(n)a\\s\\do6(i)');
eq('积分', E.toEq('\\int_{0}^{1}x\\mathrm{d}x'), '∫\\s\\do6(0)\\s\\up6(1)xdx');
eq('度数', E.toEq('90^\\circ'), '90\\s\\up6(∘)');

console.log('\n[4] 括号');
eq('圆括号交给 \\b 自动拉高', E.toEq('\\left(\\frac{a}{b}\\right)'), '\\b(\\f(a,b))');
eq('方括号写字面', E.toEq('\\left[x\\right]'), '[x]');
eq('组合数', E.toEq('\\binom{n}{k}'), '\\b(\\s\\up6(n)\\s\\do6(k))');

console.log('\n[5] 复杂结构降级（WPS 不认 \\a 阵列、\\i\\su，宁可变简单也不能报错）');
not('矩阵不出 \\a', E.toEq('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}'), '\\a');
has('矩阵保留内容', E.toEq('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}'), 'a b');
not('分段函数不出 \\a', E.toEq('\\begin{cases}x&x>0\\\\-x&x\\le0\\end{cases}'), '\\a');
not('求和不出 \\i\\su', E.toEq('\\sum_{i=1}^{n}a_i'), '\\i');
not('矩阵里不残留 &', E.toEq('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}'), '&');
not('上划线不出 \\o\\ac（WPS 报「错误!」）', E.toEq('\\overline{x}'), '\\o\\ac');

console.log('\n[6] RTF 包装');
const rtf = E.toRtf('\\frac{x+1}{2}');
has('field 必须包在花括号里（少一层就多吐一个 \\）', rtf, '{\\field{');
has('走 RTF 而非 HTML', rtf, '{\\rtf1');
has('EQ 前缀', rtf, '{EQ ');
has('域指令里的反斜杠转义成两个', rtf, '\\\\f(x+1,2)');
has('fldrslt 留空，让 Office 自己算', rtf, '{\\fldrslt {}}');
has('结尾是段落', rtf, '\\par}');
eq('空公式不生成 RTF', E.toRtf(''), '');
eq('空公式不生成 EQ', E.toEq(''), '');

console.log('\n[7] RTF 转义');
eq('中文走 \\uN?', E.escapeRtf('中'), '\\u20013?');
eq('反斜杠双写', E.escapeRtf('\\s'), '\\\\s');
eq('花括号转义', E.escapeRtf('{x}'), '\\{x\\}');
eq('ASCII 原样', E.escapeRtf('a+b'), 'a+b');
eq('希腊字母转码点', E.escapeRtf('α'), '\\u945?');

console.log('\n' + (fail ? '✗ ' + fail + ' 项失败，' : '✓ 全部通过，') + pass + ' 项');
process.exit(fail ? 1 : 0);
