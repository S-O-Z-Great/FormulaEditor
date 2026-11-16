/**
 * 符号表 —— 全项目唯一数据源
 * README.md 的符号表、编辑器里的候选条、以及 # 转换引擎，全部从这里读取。
 *
 * 收录原则：只保留需求里明确指定过的触发码，不再收录「LaTeX 命令名」式的别名
 * （frac / sqrt / int / sum / subset …）。想加新码，往 GROUPS 里加一条即可。
 *
 * 字段：
 *   t  触发码（在编辑区键入 # 之后紧跟的字符）
 *   x  生成的 LaTeX
 *   d  说明（候选条里显示）
 *   c  插入后光标落点标记 $0；没有 $0 时落在第一个空槽 {} 内
 *
 * 命名风格（来自 docs/symbol-wishlist.md 的定案）：
 *   ① 图形拼装   (S)=∮  (/)=∅  (-=∈  (6)=苯环
 *   ② ASCII 箭头 <=  >=  ->  =>  <=>  --><--
 *   ③ 小词语义   so  bc  and  or  lim  sin
 *   ④ ! 翻转     !A=∀  !Delta=∇  !(-=∉  !C=∁
 *
 * 待实现（见 docs/symbol-wishlist.md 第五节 E1–E15）：
 *   - 后缀修饰（> ~ . .. { } ( ——）需「取前一单元并包裹」，暂未收录
 *   - 同码多候选（C / ~）目前靠条目顺序决定默认项
 *
 * 二次解析（E3）：`##X` 不是另一张表，而是把 # 走两遍——
 *   ① #Sigma → Σ　② 把结果字符 Σ 当触发码再查一次 → ∑
 * 所以第二遍的触发码就是**字符本身**（本文件末尾「二次解析」组），
 * 引擎按「结果字符 → 触发码」反查，见 engine.js 的 secondPass()。
 */
(function (global) {
  'use strict';

  const GROUPS = [
    {
      name: '结构',
      items: [
        { t: '--', x: '\\frac{$0}{}', d: '分数线（分子在上）' },
        { t: '——', x: '\\frac{$0}{}', d: '分数线（破折号写法，等价 #--）' },
        { t: 'v', x: '\\sqrt{$0}', d: '根号' },
        // 下面这几条必须显式写 \placeholder{}：矩阵 / 分段函数的格子里没有 {}
        // 可替换，落槽机制（见 renderer.js 的 replacePreedit）就找不到空槽，
        // 插入后光标停在结构外面，打进去的字全跑到矩阵右边。
        { t: 'vn', x: '\\sqrt[\\placeholder{}]{\\placeholder{}}', d: 'n 次根' },
        { t: '{', x: '\\begin{cases}\\placeholder{}\\\\\\placeholder{}\\end{cases}', d: '分段函数' },
        { t: '{2', x: '\\begin{cases}\\placeholder{}\\\\\\placeholder{}\\end{cases}', d: '方程组（两行）' },
        { t: 'm2', x: '\\begin{pmatrix}\\placeholder{}&\\placeholder{}\\\\\\placeholder{}&\\placeholder{}\\end{pmatrix}', d: '2×2 矩阵' },
        { t: '||', x: '\\begin{vmatrix}\\placeholder{}&\\placeholder{}\\\\\\placeholder{}&\\placeholder{}\\end{vmatrix}', d: '行列式' },
        { t: 'C', x: '\\binom{$0}{}', d: '组合数 C(n,k)' },
        { t: 'A', x: '\\mathrm{A}_{$0}^{}', d: '排列数 A(n,k)' },
        { t: 'oo', x: '\\infty', d: '无穷' },
        { t: '^o', x: '^\\circ', d: '度数' },
        { t: 'degree', p: 1, x: '^\\circ', d: '度数（全拼）' },
        // 原来是 `\lfloor $0 \rfloor`：$0 那个位置夹的是空格，不是空槽，
        // 渲染引擎不认，字就落到 \rfloor 外面去了。改成真占位符。
        { t: '[[', x: '\\lfloor \\placeholder{} \\rfloor', d: '下取整' },
        { t: ']]', x: '\\lceil \\placeholder{} \\rceil', d: '上取整' },
        { t: 'ob', x: '\\overbrace{$0}^{}', d: '上括号' },
        { t: 'ub', x: '\\underbrace{$0}_{}', d: '下括号' }
      ]
    },
    {
      name: '运算',
      items: [
        { t: '/', x: '\\div', d: '除号' },
        { t: '*', x: '\\times', d: '乘号' },
        { t: '+-', x: '\\pm', d: '加减' },
        { t: '-+', x: '\\mp', d: '减加' },
        { t: 'comp', x: '\\circ', d: '复合' },
        { t: '·', x: '\\cdot', d: '点乘' },
        { t: '.*', p: 1, x: '\\cdot', d: '点乘（备用码，键盘上没有 · 时用）' }
      ]
    },
    {
      name: '关系',
      items: [
        { t: '=', x: '\\;=\\;', d: '化学等号（两侧留距）' },
        { t: '~=', x: '\\approx', d: '约等于' },
        { t: '~', x: '\\sim', d: '相似（约等于已改为 #~=）' },
        { t: '!=', x: '\\neq', d: '不等号' },
        { t: '===', x: '\\equiv', d: '恒等' },
        { t: '<=', x: '\\leq', d: '小于等于' },
        { t: '>=', x: '\\geq', d: '大于等于' },
        { t: '<<', x: '\\ll', d: '远小于' },
        { t: '>>', x: '\\gg', d: '远大于' },
        { t: 'oc', x: '\\propto', d: '正比（形似 oc）' },
        { t: '//', x: '\\parallel', d: '平行' },
        { t: '_|_', x: '\\perp', d: '垂直' },
        { t: 'bc', x: '\\because', d: '因为' },
        { t: 'because', x: '\\because', d: '因为（全拼）' },
        { t: 'so', x: '\\therefore', d: '所以' },
        { t: 'tri=', x: '\\triangleq', d: '定义为（等号上加三角）' },
        { t: ':=', x: '\\triangleq', d: '定义为（别名）' },
        { t: '|->', x: '\\mapsto', d: '映射到' },
        { t: '->', x: '\\to', d: '趋于' },
        { t: '=>', x: '\\Rightarrow', d: '蕴含' },
        { t: '<=>', x: '\\Leftrightarrow', d: '等价' },
        { t: '[]', x: '\\square', d: '证毕' },
        { t: '<', x: '\\angle', d: '角' },
        { t: 'tri', x: '\\triangle', d: '三角形' },
        { t: 'O', x: '\\odot', d: '圆' }
      ]
    },
    {
      name: '集合与逻辑',
      items: [
        { t: 'U', x: '\\cup', d: '并集（形似 U）' },
        { t: 'n', x: '\\cap', d: '交集（形似 n）' },
        { t: '!A', x: '\\forall', d: '任意（! 翻转 A）' },
        { t: 'all', p: 1, x: '\\forall', d: '任意（全拼）' },
        { t: 'A', x: '\\forall', d: '任意（倒 A，与排列数同码，候选里选）' },
        { t: 'E', x: '\\exists', d: '存在（反 E）' },
        { t: '(-', x: '\\in', d: '属于（左括号加一横）' },
        { t: '!(-', x: '\\notin', d: '不属于' },
        { t: 'C_', x: '\\subseteq', d: '子集' },
        { t: 'C', x: '\\subset', d: '真子集（与组合数同码，候选里选）' },
        { t: '!C_', x: '\\supseteq', d: '超集' },
        { t: 'C', x: '\\complement', d: '补集（与组合数 / 真子集同码，候选里选）' },
        { t: '(/)', x: '\\varnothing', d: '空集（圈里划一道）' },
        { t: 'NN', x: '\\mathbb{N}', d: '自然数集' },
        { t: 'ZZ', x: '\\mathbb{Z}', d: '整数集' },
        { t: 'QQ', x: '\\mathbb{Q}', d: '有理数集' },
        { t: 'RR', x: '\\mathbb{R}', d: '实数集' },
        { t: 'CC', x: '\\mathbb{C}', d: '复数集' },
        { t: '!', x: '\\lnot', d: '逻辑非' },
        { t: 'and', x: '\\wedge', d: '逻辑且' },
        { t: '!V', x: '\\wedge', d: '逻辑且（! 翻转 V）' },
        { t: 'or', x: '\\vee', d: '逻辑或' },
        { t: 'V', x: '\\vee', d: '逻辑或（形似 V）' },
        { t: '|-', x: '\\vdash', d: '推出' }
      ]
    },
    {
      name: '微积分与大运算符',
      items: [
        { t: 'S', x: '\\int_{$0}^{}', d: '积分（形似 S，右下下限、右上上限）' },
        { t: 's', p: 1, x: '\\int_{$0}^{}', d: '积分（小写写法）' },
        { t: '(S)', x: '\\oint_{$0}^{}', d: '环路积分（把 S 用圈套住）' },
        { t: '(SS)', x: '\\iint_{$0}^{}', d: '二重积分（括号里两个 S）' },
        { t: '(SSS)', x: '\\iiint_{$0}^{}', d: '三重积分（括号里三个 S）' },
        { t: '(Sn)', x: '\\int\\cdots\\int_{$0}^{}', d: 'n 重积分（更多重数）' },
        { t: 'II', x: '\\prod_{$0}^{}', d: '连乘（形似 Π）' },
        { t: 'lim', x: '\\lim_{$0\\to }', d: '极限（下方槽可写 x→0）' },
        { t: "'", x: '\\prime', d: '导数撇' },
        { t: '’', p: 1, x: '\\prime', d: '导数撇（中文引号）' },
        { t: 'dd', x: '\\frac{d$0}{dx}', d: '一阶导数 dy/dx' },
        { t: 'dy/dx', p: 1, x: '\\frac{d$0}{dx}', d: '一阶导数（写出式）' },
        { t: '!6', x: '\\partial', d: '偏导（6 翻转过来）' },
        { t: '!D', x: '\\nabla', d: '梯度（Δ 倒过来）' },
        { t: '!Delta', x: '\\nabla', d: '梯度（全拼写法）' },
        { t: '!D.', x: '\\nabla\\cdot', d: '散度' },
        { t: '!Dx', x: '\\nabla\\times', d: '旋度' },
        { t: '!D2', x: '\\nabla^2', d: '拉普拉斯算子' }
      ]
    },
    {
      name: '函数',
      items: [
        { t: 'sin', x: '\\sin', d: '正弦' },
        { t: 'cos', x: '\\cos', d: '余弦' },
        { t: 'tan', x: '\\tan', d: '正切' },
        { t: 'cot', x: '\\cot', d: '余切' },
        { t: 'sec', x: '\\sec', d: '正割' },
        { t: 'csc', x: '\\csc', d: '余割' },
        { t: 'arcsin', x: '\\arcsin', d: '反正弦' },
        { t: 'arccos', x: '\\arccos', d: '反余弦' },
        { t: 'arctan', x: '\\arctan', d: '反正切' },
        { t: 'ln', x: '\\ln', d: '自然对数' },
        { t: 'lg', x: '\\lg', d: '常用对数' },
        { t: 'log', x: '\\log_{$0}', d: '一般对数（带底数槽）' },
        { t: 'exp', x: 'e^{$0}', d: '指数' },
        { t: 'sinh', x: '\\sinh', d: '双曲正弦' },
        { t: 'cosh', x: '\\cosh', d: '双曲余弦' },
        { t: 'tanh', x: '\\tanh', d: '双曲正切' }
      ]
    },
    {
      name: '希腊字母（小写）',
      items: [
        { t: 'alpha', x: '\\alpha', d: 'α' },
        { t: 'beta', x: '\\beta', d: 'β' },
        { t: 'gamma', x: '\\gamma', d: 'γ' },
        { t: 'delta', x: '\\delta', d: 'δ' },
        { t: 'epsilon', x: '\\epsilon', d: 'ε' },
        { t: 'zeta', x: '\\zeta', d: 'ζ' },
        { t: 'eta', x: '\\eta', d: 'η' },
        { t: 'theta', x: '\\theta', d: 'θ' },
        { t: 'iota', x: '\\iota', d: 'ι' },
        { t: 'kappa', x: '\\kappa', d: 'κ' },
        { t: 'lambda', x: '\\lambda', d: 'λ' },
        { t: 'mu', x: '\\mu', d: 'μ' },
        { t: 'nu', x: '\\nu', d: 'ν' },
        { t: 'xi', x: '\\xi', d: 'ξ' },
        { t: 'omicron', x: 'o', d: 'ο（与拉丁 o 同形）' },
        { t: 'pi', x: '\\pi', d: 'π' },
        { t: 'rho', x: '\\rho', d: 'ρ' },
        { t: 'sigma', x: '\\sigma', d: 'σ' },
        { t: 'tau', x: '\\tau', d: 'τ' },
        { t: 'upsilon', x: '\\upsilon', d: 'υ' },
        { t: 'phi', x: '\\phi', d: 'φ' },
        { t: 'chi', x: '\\chi', d: 'χ' },
        { t: 'psi', x: '\\psi', d: 'ψ' },
        { t: 'omega', x: '\\omega', d: 'ω' }
      ]
    },
    {
      name: '希腊字母（大写）',
      items: [
        { t: 'Alpha', x: 'A', d: 'Α（与拉丁 A 同形）' },
        { t: 'Beta', x: 'B', d: 'Β（与拉丁 B 同形）' },
        { t: 'Gamma', x: '\\Gamma', d: 'Γ' },
        { t: 'Delta', x: '\\Delta', d: 'Δ' },
        { t: 'Epsilon', x: 'E', d: 'Ε（与拉丁 E 同形）' },
        { t: 'Zeta', x: 'Z', d: 'Ζ（与拉丁 Z 同形）' },
        { t: 'Eta', x: 'H', d: 'Η（与拉丁 H 同形）' },
        { t: 'Theta', x: '\\Theta', d: 'Θ' },
        { t: 'Iota', x: 'I', d: 'Ι（与拉丁 I 同形）' },
        { t: 'Kappa', x: 'K', d: 'Κ（与拉丁 K 同形）' },
        { t: 'Lambda', x: '\\Lambda', d: 'Λ' },
        { t: 'Mu', x: 'M', d: 'Μ（与拉丁 M 同形）' },
        { t: 'Nu', x: 'N', d: 'Ν（与拉丁 N 同形）' },
        { t: 'Xi', x: '\\Xi', d: 'Ξ' },
        { t: 'Omicron', x: 'O', d: 'Ο（与拉丁 O 同形）' },
        { t: 'Pi', x: '\\Pi', d: 'Π' },
        { t: 'Rho', x: 'P', d: 'Ρ（与拉丁 P 同形）' },
        { t: 'Sigma', x: '\\Sigma', d: 'Σ' },
        { t: 'Tau', x: 'T', d: 'Τ（与拉丁 T 同形）' },
        { t: 'Upsilon', x: '\\Upsilon', d: 'Υ' },
        { t: 'Phi', x: '\\Phi', d: 'Φ' },
        { t: 'Chi', x: 'X', d: 'Χ（与拉丁 X 同形）' },
        { t: 'Psi', x: '\\Psi', d: 'Ψ' },
        { t: 'Omega', x: '\\Omega', d: 'Ω' }
      ]
    },
    {
      name: '二次解析',
      items: [
        // 这一组的触发码是**字符本身**，不给手敲（也允许 #Σ 直接敲）。
        // 它们服务于 ##X：先把 #X 解析成字符，再把字符当码解析一次。
        { t: 'Σ', x: '\\sum_{$0}^{}', d: '求和 ∑（##Sigma 的二次解析：#Sigma→Σ，再 #Σ→∑）' },
        { t: 'Θ', x: '\\ominus', d: '标准态 ⊖（##Theta 的二次解析：#Theta→Θ，再 #Θ→⊖）' }
      ]
    }
  ];

  const FLAT = [];
  GROUPS.forEach(function (g) {
    g.items.forEach(function (it) {
      FLAT.push(Object.assign({ group: g.name, trigger: it.t }, it));
    });
  });

  /* ---------------- 化学元素符号（$ 起手） ----------------
   * 118 个标准元素符号，大小写严格：Cu 是铜，CO 不是元素（那是一氧化碳）。
   * $Cu 打出「元素主体」，解锁左上质量数 / 左下质子数 / 右上电荷 / 右下个数四个槽。
   */
  const ELEMENTS = (
    'H He Li Be B C N O F Ne ' +
    'Na Mg Al Si P S Cl Ar K Ca ' +
    'Sc Ti V Cr Mn Fe Co Ni Cu Zn ' +
    'Ga Ge As Se Br Kr Rb Sr Y Zr ' +
    'Nb Mo Tc Ru Rh Pd Ag Cd In Sn ' +
    'Sb Te I Xe Cs Ba La Ce Pr Nd ' +
    'Pm Sm Eu Gd Tb Dy Ho Er Tm Yb ' +
    'Lu Hf Ta W Re Os Ir Pt Au Hg ' +
    'Tl Pb Bi Po At Rn Fr Ra Ac Th ' +
    'Pa U Np Pu Am Cm Bk Cf Es Fm ' +
    'Md No Lr Rf Db Sg Bh Hs Mt Ds ' +
    'Rg Cn Nh Fl Mc Lv Ts Og'
  ).split(' ');

  const api = { GROUPS: GROUPS, FLAT: FLAT, ELEMENTS: ELEMENTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FE_SYMBOLS = api;
})(typeof window !== 'undefined' ? window : globalThis);
