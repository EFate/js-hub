// zhihu-enhance 测试：smoke（纯函数冒烟）+ e2e（jsdom 场景）+ 文档核验
// 运行：node test/test.js
'use strict';

var path = require('path');
var fs = require('fs');
var api = require('../zhihu-enhance.user.js');

var JSDOM;
try { JSDOM = require('../../.tmp/node_modules/jsdom').JSDOM; }
catch (e) { JSDOM = null; }

var pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; }
    else { fail++; console.error('  FAIL: ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }

function group(name) { console.log('== ' + name + ' =='); }

// ======================================================================
// 第 1 组 · 配置定义表
// ======================================================================
group('配置定义表');
var defs = api.OPT_DEFS, keys = Object.keys(defs);
eq(keys.length, 11, '开关总数 = 11');
eq(api.GROUPS.length, 4, '分组数 = 4');
eq(api.GROUPS.join(','), '净化,阅读,链接,外观', '分组顺序');
keys.forEach(function (k) {
    var d = defs[k];
    ok(d && d.group && api.GROUPS.indexOf(d.group) > -1, k + ' 分组合法');
    ok(d && d.label && d.tip && typeof d.def === 'boolean', k + ' 含 label/tip/def');
});

// ======================================================================
// 第 2 组 · buildCSS 开关拼装
// ======================================================================
group('buildCSS');
function cssOn(name) { var o = {}; o[name] = true; return api.buildCSS(o); }
var allOff = api.buildCSS({});
ok(allOff.indexOf('data-theme=dark') > -1, '夜间主题 CSS 常驻输出');
eq(allOff, api.buildCSS({ nightMode: true }), 'nightMode 不影响 CSS 内容（门控在 data-theme 属性）');
ok(cssOn('hideLogin').indexOf('Modal-enter') > -1, 'hideLogin → Modal 隐藏');
ok(cssOn('hideSidebar').indexOf('GlobalSideBar') > -1, 'hideSidebar → 侧边栏选择器');
ok(cssOn('hideSidebar').indexOf('justify-content: center') > -1, 'hideSidebar → 内容居中');
ok(/div\[data-za-detail-view-path-module="RightSideBar"\][^{]*\{/.test(cssOn('hideSidebar')),
    'hideSidebar → 侧栏用知乎埋点语义属性隐藏（跨改版稳定）');
ok(/\.Post-Row-Content-left \{[^}]*\}/.test(cssOn('hideSidebar')) &&
    !/width: 690px/.test(cssOn('hideSidebar').match(/\.Post-Row-Content-left \{[^}]*\}/)[0]),
    'hideSidebar → 文章页正文列不再硬压 690px（改为自适应居中）');
ok(cssOn('hideSidebar').indexOf('data-zhx-booting') > -1 &&
    /html\[data-zhx-booting\] footer/.test(cssOn('hideSidebar')) &&
    cssOn('hideSidebar').indexOf('.zh-footer') > -1,
    'hideSidebar → 首屏页脚防闪现规则（覆盖 footer 与 .zh-footer）');

// —— v1.3.1 文章页「真正居中 + 放宽」修复 ——
// 新代文章页正文宿主是 .Post-NormalMain（ref/知乎优化3.js 的宽屏样式即此写法）。
// 断言必须匹配真实选择器形态，不能只匹配注释文字（历史上注释含相同串曾造成假绿）。
ok(/\.Post-NormalMain[^{]*\{[^}]*margin:[^;}]*auto/.test(cssOn('hideSidebar')),
    'hideSidebar → 新代文章页正文宿主 .Post-NormalMain 参与居中');
ok(/\.Post-NormalMain[^{]*\{[^}]*flex:\s*0 1 auto/.test(cssOn('hideSidebar')),
    'hideSidebar → 新代正文宿主自适应宽度（不写死）');
ok(/\.Post-NormalSub[^{]*\{/.test(cssOn('hideSidebar')),
    'hideSidebar → 覆盖 .Post-NormalSub（新代副栏）');
ok(/\.Comment-container\s*\{[^}]*max-width:\s*850px/.test(cssOn('hideSidebar')),
    'hideSidebar → 评论区阅读宽度一并放宽到 850px');
ok(/\.Post-NormalMain \.Post-RichTextContainer[^{]*\{[^}]*max-width:\s*850px/.test(cssOn('hideSidebar')),
    'hideSidebar → 正文内容列阅读宽度放宽到 850px');
// 旧代正文列不得再被写死 694px（那是「收窄」，与放宽诉求相反）
ok(!/\.Post-Row-Content-left \{[^}]*max-width:\s*694px/.test(cssOn('hideSidebar')),
    'hideSidebar → 旧代正文列不再被压到 694px');
ok(cssOn('autoHideHeader').indexOf('is-hidden') > -1, 'autoHideHeader → 顶栏隐藏类');
ok(cssOn('picMaxHeight').indexOf('max-height: 500px') > -1, 'picMaxHeight → 限高');
ok(cssOn('hoverFocus').indexOf('outline') > -1, 'hoverFocus → 聚焦框');
ok(cssOn('refHighlight').indexOf('.ztext sup') > -1, 'refHighlight → 角标高亮');
ok(cssOn('hideLogin').indexOf('GlobalSideBar') === -1, '未开启的功能不产生 CSS');
ok(allOff.indexOf(':has(') === -1, '不含 :has()（旧内核兼容）');
ok(allOff.indexOf('color-scheme') > -1, '夜间主题输出 color-scheme（原生控件深色化）');

// ======================================================================
// 第 3 组 · resolveLink 直链解析
// ======================================================================
group('resolveLink');
eq(api.resolveLink('https://link.zhihu.com/?target=https%3A%2F%2Fexample.com%2Fa'),
    'https://example.com/a', 'target 参数解码');
eq(api.resolveLink('https://link.zhihu.com/?target=https%3A%2F%2Fexample.com%2Fa&from=timeline'),
    'https://example.com/a', 'target 后的附加参数截断');
eq(api.resolveLink('https://link.zhihu.com/?target=https%3A%2F%2Fexample.com%2Fp%3Fa%3D1%26b%3D2'),
    'https://example.com/p?a=1&b=2', 'target 内部 %26 保留');
eq(api.resolveLink('https://zhihu.com/x?next=https%3A%2F%2Ffoo.com%2Fbar'),
    'https://foo.com/bar', '编码 URL 片段兜底');
eq(api.resolveLink('https://zhihu.com/x?next=https%3A%2F%2Ffoo.com%2Fbar%3Fid%3D7&tag=1'),
    'https://foo.com/bar?id=7', '编码兜底带查询且 & 截断');
eq(api.resolveLink('https://www.zhihu.com/question/123'), null, '站内链接不动');
eq(api.resolveLink('https://www.zhihu.com/question/123?next=https%3A%2F%2Fwww.zhihu.com%2Ft'), null,
    '编码兜底指向知乎站内 → 不改写');
eq(api.resolveLink('https://example.com/direct'), null, '已是直链 → 幂等返回 null');
eq(api.resolveLink('javascript:void(0)'), null, '非 http 协议拒绝');
eq(api.resolveLink('https://link.zhihu.com/?target=abc123'), null, 'target 非 URL 拒绝');
eq(api.resolveLink(''), null, '空串拒绝');
eq(api.resolveLink(null), null, 'null 拒绝');
eq(api.resolveLink('https://www.zhihu.com/question/1?next=https%3A%2F%2Ffoo.com%2Fbar'),
    'https://foo.com/bar', '?next= 编码参数直跳');
eq(api.resolveLink('https://www.zhihu.com/x?a=1&next=https%3A%2F%2Fbar.com%2Fz'),
    'https://bar.com/z', '&next= 编码参数直跳');
eq(api.resolveLink('https://www.zhihu.com/x?next=https%3A%2F%2Fwww.zhihu.com%2Fa'),
    null, 'next 指向知乎站内 → 不改写');
eq(api.resolveLink('https://www.zhihu.com/x?next=abc'), null, 'next 非 URL 拒绝');

// ======================================================================
// 第 4 组 · normalizeImg 原图归一
// ======================================================================
group('normalizeImg');
eq(api.normalizeImg('https://picx.zhimg.com/v2-abc_b.jpg'), 'https://picx.zhimg.com/v2-abc.jpg', '_b 后缀剥离');
eq(api.normalizeImg('https://pic1.zhimg.com/50/v2-abc_hd.jpg?source=1'),
    'https://pic1.zhimg.com/v2-abc.jpg?source=1', '/50/ 与 _hd 一并处理，查询保留');
eq(api.normalizeImg('https://picx.zhimg.com/v2-abc_1440w.png'), 'https://picx.zhimg.com/v2-abc.png', '_1440w 剥离');
eq(api.normalizeImg('https://picx.zhimg.com/v2-abc.jpg'), null, '无后缀原图 → null');
eq(api.normalizeImg('https://picx.zhimg.com/v2-abc_9x.jpg'), null, '非白名单后缀不动');
eq(api.normalizeImg('https://example.com/a_b.jpg'), null, '非 zhimg 域名不动');
eq(api.normalizeImg(''), null, '空串拒绝');
eq(api.normalizeImg(api.normalizeImg('https://picx.zhimg.com/v2-abc_b.jpg')), null, '二次调用幂等');

// ======================================================================
// 第 5 组 · pickTime 时间提取（取不到不硬造）
// ======================================================================
group('pickTime');
eq(api.pickTime('发布于 2020-03-04 12:30').publish, '2020-03-04 12:30', '发布于 + 时刻');
eq(api.pickTime('发布于 2020-03-04').publish, '2020-03-04', '发布于 仅日期');
eq(api.pickTime('编辑于 2021-05-06 12:00').edit, '2021-05-06 12:00', '编辑于');
eq(api.pickTime('发布于 2020-03-04，编辑于 2021-05-06').publish, '2020-03-04', '双时间取发布');
eq(api.pickTime('发布于 2020-03-04，编辑于 2021-05-06').edit, '2021-05-06', '双时间取编辑');
eq(api.pickTime('昨天 12:00'), null, '相对时间不硬造');
eq(api.pickTime(''), null, '空串拒绝');

// ======================================================================
// 第 6 组 · 护栏（零注入 / 零网络 / Meta 六件套）
// ======================================================================
group('护栏');
var src = fs.readFileSync(path.join(__dirname, '../zhihu-enhance.user.js'), 'utf8');
ok(/@author\s+EFate/.test(src), '@author EFate');
ok(/@license\s+MIT/.test(src), '@license MIT');
ok(/@namespace\s+js-hub\/zhihu-enhance/.test(src), '@namespace');
ok(/@version\s+\d+\.\d+\.\d+/.test(src), '@version');
ok(src.indexOf('@updateURL') > -1 && src.indexOf('@downloadURL') > -1, 'updateURL/downloadURL');
ok(src.indexOf('@noframes') > -1, '@noframes');
ok(src.indexOf('GM_xmlhttpRequest') === -1 && src.indexOf('XMLHttpRequest') === -1 &&
   src.indexOf('fetch(') === -1, '零网络请求');
ok(src.indexOf('arguments.callee') === -1, '无严格模式违禁写法');
ok(src.indexOf('@require') === -1 && src.indexOf('@resource') === -1, '零外部依赖');
eq(src.split(/GM_registerMenuCommand\(/).length - 1 >= 2, true, '菜单命令存在（设置面板 + 夜间模式）');

// ======================================================================
// 第 7-10 组 · e2e（jsdom 场景，每场景独立文档）
// ======================================================================
if (JSDOM) {
    function dom(html) { return new JSDOM('<!DOCTYPE html><html><body>' + html + '</body></html>').window.document; }

    // ---- 场景 1：直链化 ----
    group('e2e · 直链化');
    api.__setOpt('directLink', true);
    var d1 = dom(
        '<a id="jump" href="https://link.zhihu.com/?target=https%3A%2F%2Fexample.com%2Fa">外链</a>' +
        '<a id="inner" href="https://www.zhihu.com/question/123">站内</a>' +
        '<a id="plain" href="https://example.com/plain">普通外链</a>');
    var n1 = api.applyLink(d1);
    eq(n1, 1, '仅中转链接被改写');
    eq(d1.getElementById('jump').getAttribute('href'), 'https://example.com/a', 'href 已直链化');
    eq(d1.getElementById('inner').getAttribute('href'), 'https://www.zhihu.com/question/123', '站内链接原样');
    eq(d1.getElementById('plain').getAttribute('href'), 'https://example.com/plain', '普通外链原样');
    eq(api.applyLink(d1), 0, '重复执行幂等（0 改写）');

    // ---- 场景 2：发布时间置顶 ----
    group('e2e · 时间置顶');
    api.__setOpt('timeTop', true);
    var d2 = dom(
        '<div class="ContentItem AnswerItem">' +
        '  <div class="ContentItem-meta"><span class="AuthorInfo">作者甲</span></div>' +
        '  <div class="RichContent">正文</div>' +
        '  <div class="ContentItem-time" data-tooltip="发布于 2020-03-04 12:00">编辑于 2021-05-06 12:00</div>' +
        '</div>' +
        '<div class="ContentItem AnswerItem">' +
        '  <div class="ContentItem-meta"><span class="AuthorInfo">作者乙</span></div>' +
        '  <div class="ContentItem-time" data-tooltip="发布于 2020-01-02">发布于 2020-01-02</div>' +
        '</div>');
    var n2 = api.applyTime(d2);
    var cards = d2.querySelectorAll('.ContentItem');
    var t1 = cards[0].querySelector('.ContentItem-time'), t2 = cards[1].querySelector('.ContentItem-time');
    ok(n2 >= 2, '两条时间均处理');
    ok(cards[0].querySelector('.ContentItem-meta').contains(t1), '卡片 1 时间已移至 meta（置顶）');
    eq(t1.textContent, '发布于 2020-03-04 12:00 · 编辑于 2021-05-06 12:00',
        '文本只有「编辑于」时，用 tooltip 里的隐藏发布时间补全');
    ok(cards[1].querySelector('.ContentItem-meta').contains(t2), '卡片 2 时间已置顶');
    eq(t2.textContent, '发布于 2020-01-02', '已有发布时间原样保留');
    eq(api.applyTime(d2), 0, '重复执行幂等');

    // ---- 场景 3：原图替换 ----
    group('e2e · 原图');
    api.__setOpt('picOriginal', true);
    var d3 = dom(
        '<img id="i1" src="https://picx.zhimg.com/v2-abc_b.jpg" data-actualsrc="https://picx.zhimg.com/v2-abc_b.jpg">' +
        '<img id="i2" src="https://pic1.zhimg.com/50/v2-def_hd.jpg">' +
        '<img id="i3" src="https://cdn.example.com/x_b.jpg">');
    var n3 = api.applyImg(d3);
    eq(n3, 2, '两张知乎图被替换');
    eq(d3.getElementById('i1').getAttribute('src'), 'https://picx.zhimg.com/v2-abc.jpg', 'i1 已原图');
    eq(d3.getElementById('i1').getAttribute('data-actualsrc'), 'https://picx.zhimg.com/v2-abc.jpg', '懒加载占位同步');
    eq(d3.getElementById('i2').getAttribute('src'), 'https://pic1.zhimg.com/v2-def.jpg', 'i2 /50/ 与 _hd 处理');
    eq(d3.getElementById('i3').getAttribute('src'), 'https://cdn.example.com/x_b.jpg', '外域图不动');
    eq(api.applyImg(d3), 0, '重复执行幂等');

    // 原图增强：data-actualsrc 指向不同原图时直接信任（不走正则剥后缀）
    eq(api.pickOriginal({ getAttribute: function (k) { return k === 'src' ? 'https://picx.zhimg.com/v2-x_720w.jpg' : 'https://picx.zhimg.com/v2-x_original.jpg'; }, hasAttribute: function () { return true; } }),
        'https://picx.zhimg.com/v2-x_original.jpg', 'data-actualsrc 与原图不同 → 信任原图');
    eq(api.pickOriginal({ getAttribute: function (k) { return k === 'src' ? 'https://picx.zhimg.com/v2-x_b.jpg' : null; }, hasAttribute: function () { return false; } }),
        'https://picx.zhimg.com/v2-x.jpg', '无 data-actualsrc → 回退剥后缀');

    // ---- 场景 4：开关关闭时不执行 ----
    group('e2e · 开关门控');
    api.__setOpt('directLink', false);
    api.__setOpt('timeTop', false);
    api.__setOpt('picOriginal', false);
    var d4 = dom(
        '<a href="https://link.zhihu.com/?target=https%3A%2F%2Fexample.com%2Fa">跳转</a>' +
        '<div class="ContentItem"><div class="ContentItem-time">编辑于 2021-01-01</div></div>' +
        '<img src="https://picx.zhimg.com/v2-abc_b.jpg">');
    eq(api.applyLink(d4), 0, 'directLink 关 → 不改写');
    eq(api.applyTime(d4), 0, 'timeTop 关 → 不移动');
    eq(api.applyImg(d4), 0, 'picOriginal 关 → 不替换');
    eq(d4.querySelector('a').getAttribute('href'),
        'https://link.zhihu.com/?target=https%3A%2F%2Fexample.com%2Fa', '关闭时链接原样');

    // ---- 场景 5：sticky 卡片清理 ----
    group('e2e · sticky 清理');
    api.__setOpt('hideSidebar', true);
    var d5 = dom(
        '<div style="position: sticky; top: 10px" id="s1"><div class="Card">推荐卡</div></div>' +
        '<div style="position:sticky" id="s2"><p>无关内容</p></div>');
    api.cleanSticky(d5);
    eq(d5.getElementById('s1').style.display, 'none', '含 Card 的 sticky 容器隐藏');
    ok(d5.getElementById('s2').style.display !== 'none', '无关 sticky 容器不动');

    // ---- 场景 6：专栏文章页目录（结构上溯隐藏 + 两代结构覆盖）----
    group('e2e · 文章页目录');
    var d6 = dom(
        '<div class="Post-content">' +
        '  <div class="Post-SideActions" id="tocbox"><a aria-label="边栏锚点" href="#"><span>目录</span></a><div>一、讯飞星火</div></div>' +
        '  <div class="Post-Row-Content-left"><h1>正文标题</h1></div>' +
        '</div>');
    ok(d6.querySelector('a[aria-label="边栏锚点"]') !== null, '旧代目录锚点可被语义选择器定位');
    api.__setOpt('hideSidebar', true);
    var n6 = api.cleanSticky(d6);
    ok(n6 >= 1, 'cleanSticky 处理了目录面板');
    eq(d6.getElementById('tocbox').style.display, 'none', '目录面板容器被隐藏');
    ok(d6.querySelector('.Post-SideActions').getAttribute('data-zhx-toc') === '1', '侧栏标记落幂等标记');
    api.cleanSticky(d6);   // 幂等复跑
    eq(d6.getElementById('tocbox').style.display, 'none', '幂等：重复调用不改变结果');

    // 场景 6b：新代文章页 —— 目录面板无 a[aria-label]，只有 .Post-SideActions，
    // 且它包在无类名 wrapper 里（必须上溯才藏得住整块）。这是用户截图反馈的主场景。
    var d6b = dom(
        '<div class="Post-content">' +
        '  <div><div><div class="Post-SideActions" id="toc2"><span>目录</span><div>一、讯飞星火</div></div></div></div>' +
        '  <div class="Post-NormalMain"><div class="Post-Header"><h1>标题</h1></div></div>' +
        '</div>');
    ok(d6b.querySelector('a[aria-label="边栏锚点"]') === null, '新代结构确实没有旧 aria-label 锚点');
    var n6b = api.cleanSticky(d6b);
    ok(n6b >= 1, '新代结构下 cleanSticky 仍能定位目录面板（不依赖 aria-label）');
    // 上溯应藏掉包住目录的那个无类名 wrapper（hideAncestor 从标记的直接父级开始）
    var wrapper = d6b.getElementById('toc2').parentNode;
    eq(wrapper.style.display, 'none', '新代目录面板的外层无类名容器被上溯隐藏');
    eq(d6b.getElementById('toc2').style.display, '', '标记元素自身未被改样式（幂等标记独立）');

    var css6 = api.buildCSS({ hideSidebar: true });
    ok(/div\[data-za-detail-view-path-module="RightSideBar"\][^{]*\{/.test(css6), 'CSS 内含侧栏语义属性规则');
    ok(/\.Post-NormalMain[^{]*\{[^}]*margin:[^;}]*auto/.test(css6), 'CSS 含新代正文宿主居中规则');
    ok(!/\.Post-Row-Content-left[^}]*width:\s*690px/.test(css6), '正文列不再被写死 690px');
} else {
    console.log('（未找到 jsdom，跳过 e2e 场景）');
}

// ======================================================================
// 第 11 组 · 文档核验（README 纯功能文档约定）
// ======================================================================
group('文档核验');
var readmePath = path.join(__dirname, '../README.md');
if (fs.existsSync(readmePath)) {
    var md = fs.readFileSync(readmePath, 'utf8');
    ok(!/\d+\.\d+\.\d+/.test(md), 'README 不写版本号');
    ok(md.indexOf('规范') === -1, 'README 不引用设计规范');
    ok(md.indexOf('updateURL') === -1 && md.indexOf('zh.') === -1 && md.indexOf('OPT_DEFS') === -1,
        'README 不写内部标识符');
    ok(md.indexOf('**EFate**') > -1, 'README 文末 Author 段');
    keys.forEach(function (k) { ok(md.indexOf(k) === -1, 'README 不含内部键名 ' + k); });
    Object.keys(defs).forEach(function (k) {
        ok(md.indexOf(defs[k].label) > -1, 'README 覆盖开关说明「' + defs[k].label + '」');
    });
} else {
    ok(false, 'README.md 不存在');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
