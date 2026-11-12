/**
 * MathML → OMML —— Word / WPS 粘进去的是不是「原生公式」，全靠这里
 *
 * 这类转换的失败方式很讨厌：转错了不报错，Word 里就是一片空白或者一堆错位的字，
 * 用户以为粘成功了。所以每条结构都钉死。
 */
const katex = require('../src/vendor/katex/katex.min.js');
const O = require('../src/lib/mathml2omml.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}
function has(name, hay, needle) {
  ok(name, hay.indexOf(needle) >= 0, '缺少 ' + JSON.stringify(needle) + '\n       ' + hay);
}
function count(s, sub) {
  let n = 0, i = 0;
  while ((i = s.indexOf(sub, i)) >= 0) { n++; i += sub.length; }
  return n;
}

function mml(latex) {
  return katex.renderToString(latex, { output: 'mathml', throwOnError: false });
}
function to(latex) {
  return O.toOMML(mml(latex));
}

console.log('\n[1] 分式 / 根号');
let x = to('\\frac{a}{b}');
has('分式用 m:f', x, '<m:f>');
has('分子', x, '<m:num><m:r><m:t>a</m:t></m:r></m:num>');
has('分母', x, '<m:den><m:r><m:t>b</m:t></m:r></m:den>');
x = to('\\sqrt{x}');
has('平方根隐藏次数', x, '<m:degHide m:val="1"/>');
has('平方根次数位留空', x, '<m:deg/>');
has('平方根被开方数', x, '<m:e><m:r><m:t>x</m:t></m:r></m:e>');
x = to('\\sqrt[3]{x}');
has('n 次根有次数', x, '<m:deg><m:r><m:t>3</m:t></m:r></m:deg>');
ok('n 次根不隐藏次数', x.indexOf('degHide') < 0);

console.log('\n[2] 上下标');
x = to('H_2SO_4');
has('下标用 m:sSub', x, '<m:sSub>');
has('H 的 2 在下标位', x, '<m:e><m:r><m:t>H</m:t></m:r></m:e><m:sub><m:r><m:t>2</m:t></m:r></m:sub>');
has('O 的 4 在下标位', x, '<m:e><m:r><m:t>O</m:t></m:r></m:e><m:sub><m:r><m:t>4</m:t></m:r></m:sub>');
ok('S 是独立字符', x.indexOf('<m:t>S</m:t>') >= 0);
has('上标用 m:sSup', to('x^2'), '<m:sSup>');
has('上下标用 m:sSubSup', to('x_1^2'), '<m:sSubSup>');

console.log('\n[3] 大运算符（积分 / 求和）');
x = to('\\int_0^1 f');
has('积分用 m:nary', x, '<m:nary>');
has('积分符号', x, '<m:chr m:val="∫"/>');
has('积分上下限摆在侧面', x, '<m:limLoc m:val="subSup"/>');
has('下限 0', x, '<m:sub><m:r><m:t>0</m:t></m:r></m:sub>');
has('上限 1', x, '<m:sup><m:r><m:t>1</m:t></m:r></m:sup>');
has('被积函数进了 m:e', x, '<m:e><m:r><m:t>f</m:t></m:r></m:e>');
x = to('\\sum_{i=1}^{n} i');
has('求和上下限摆正上正下', x, '<m:limLoc m:val="undOvr"/>');
has('求和被作用体', x, '<m:e><m:r><m:t>i</m:t></m:r></m:e>');
x = to('\\sum i');
has('没有上下限时标记隐藏', x, '<m:subHide m:val="1"/>');
has('没有上下限时标记隐藏(上)', x, '<m:supHide m:val="1"/>');

console.log('\n[4] 大运算符的边界（两个积分不能被吞成一个）');
x = to('\\int f + \\int g');
ok('两个积分是并列的两个 nary', count(x, '<m:nary>') === 2, '实际 ' + count(x, '<m:nary>') + ' 个\n       ' + x);
has('加号在 nary 外面', x, '</m:nary><m:r><m:t>+</m:t></m:r><m:nary>');

console.log('\n[5] 括号');
x = to('\\left(\\frac{a}{b}\\right)');
has('圆括号用 m:d', x, '<m:d>');
ok('默认圆括号不必写 begChr', x.indexOf('begChr') < 0);
has('括号里的分式完整', x, '<m:num><m:r><m:t>a</m:t></m:r></m:num>');
x = to('\\begin{cases}a&b\\\\c&d\\end{cases}');
has('cases 的左花括号', x, '<m:begChr m:val="{"/>');
has('cases 右括号留空', x, '<m:endChr m:val=""/>');
has('cases 是矩阵', x, '<m:m>');
ok('普通括号不当成定界符', to('f(x)').indexOf('<m:d>') < 0);

console.log('\n[6] 函数 / 极限 / 重音');
x = to('\\lim_{x\\to 0}');
has('极限用 m:limLow', x, '<m:limLow>');
has('极限条件在 lim 位', x, '<m:lim><m:r><m:t>x</m:t></m:r>');
has('lim 是正体', x, '<m:sty m:val="p"/>');
x = to('\\sin x');
has('函数名正体', x, '<m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t>');
ok('不可见的函数应用符被丢掉', x.indexOf('\u2061') < 0);
has('向量用 m:acc', to('\\vec{v}'), '<m:acc>');
has('向量符号', to('\\vec{v}'), '<m:chr m:val="⃗"/>');
x = to('\\overline{AB}');
has('上划线用 m:bar', x, '<m:bar>');
has('上划线在上方', x, '<m:pos m:val="top"/>');
has('下划线在下方', to('\\underline{AB}'), '<m:pos m:val="bot"/>');

console.log('\n[7] 矩阵');
x = to('\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}');
has('矩阵用 m:m', x, '<m:m>');
has('两列', x, '<m:count m:val="2"/>');
ok('两行', count(x, '<m:mr>') === 2, '实际 ' + count(x, '<m:mr>') + ' 行');
ok('四个单元格', count(x, '<m:e><m:r><m:t>') === 4);

console.log('\n[8] 字符与转义');
x = to('a<b>c');
has('小于号转义', x, '&lt;');
has('大于号转义', x, '&gt;');
has('多字母变量不斜体化', to('\\alpha'), '<m:t>α</m:t>');
has('数字直接成 run', to('123'), '<m:r><m:t>123</m:t></m:r>');
has('文本用正体', to('\\text{abc}'), '<m:nor/>');

console.log('\n[9] 坏输入不炸');
ok('空串返回空', O.toOMML('') === '');
ok('null 返回空', O.toOMML(null) === '');
ok('不是 MathML 返回空', O.toOMML('<div>hi</div>') === '');
ok('标签不闭合也不抛异常', typeof O.toOMML('<math><mrow><mi>x</mi></mrow>') === 'string');
x = to('\\frac{}{}');
ok('空分式仍是合法结构', x.indexOf('<m:f>') >= 0);

console.log('\n[10] Word / WPS 用的 HTML 外壳');
const html = O.toWordHtml(mml('\\frac{a}{b}'));
has('带 OMML 命名空间', html, 'xmlns:m="http://schemas.microsoft.com/office/2004/12/omml"');
has('带 Word 命名空间', html, 'xmlns:w="urn:schemas-microsoft-com:office:word"');
has('公式在里面', html, '<m:oMath>');
has('有段落包裹', html, '<p class=MsoNormal>');
has('声明编码', html, 'charset=utf-8');
ok('空公式不给空壳', O.toWordHtml('<math></math>') === '');

console.log('\n' + (fail === 0 ? '全部通过 ' + pass + ' 项' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
