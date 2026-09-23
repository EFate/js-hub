// ==UserScript==
// @name         知乎阅读增强助手
// @namespace    js-hub/zhihu-enhance
// @version      1.4.1
// @description  净化（登录弹窗/侧边栏/顶栏）、阅读（时间置顶/原图/限高/聚焦框/角标高亮/GIF）、链接直链化、夜间模式 —— 11 个开关 4 组分类，菜单打开设置面板，零依赖零网络请求
// @author       EFate
// @license      MIT
// @match        *://*.zhihu.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @updateURL    https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/zhihu-enhance/zhihu-enhance.user.js
// @downloadURL  https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/zhihu-enhance/zhihu-enhance.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ======================================================================
    // L1 配置层 · 选项定义表（一切开关的唯一来源）与存储键约定 zh.*
    // ======================================================================

    var VERSION = '1.4.1';
    var PREFIX = 'zh';           // 存储键前缀：zh.<开关名>
    var MARK = 'data-zhx';       // DOM 幂等标记前缀：data-zhx-<任务>
    // 文章页阅读宽度上限（px）。上提到常量区是为了让 L3 样式层与 L5 执行层共用同一来源，
    // 避免「CSS 写一个值、运行时写另一个值」的漂移（本项目曾在版本号上踩过同类两处不一致的坑）。
    var READ_W = 1500;

    var GROUPS = ['净化', '阅读', '链接', '外观'];

    var OPT_DEFS = {
        hideLogin:      { group: '净化', label: '隐藏登录弹窗',       tip: '未登录浏览时不再弹出登录框，页面保持可滚动', def: true },
        hideSidebar:    { group: '净化', label: '隐藏侧边栏并居中内容', tip: '隐藏各页面右侧边栏与推荐卡片，主栏内容居中显示', def: true },
        autoHideHeader: { group: '净化', label: '下滚自动隐藏顶栏',   tip: '向下滚动时收起顶部导航栏，向上滚动时恢复', def: false },
        timeTop:        { group: '阅读', label: '发布时间移至顶部',   tip: '回答的发布/编辑时间显示在开头；只有「编辑于」时补全具体发布日期', def: true },
        picOriginal:    { group: '阅读', label: '图片原图显示',       tip: '自动加载未压缩的原始尺寸图片', def: true },
        picMaxHeight:   { group: '阅读', label: '限制图片最大高度',   tip: '正文图片最高 500px，避免长图刷屏', def: true },
        hoverFocus:     { group: '阅读', label: '悬停时高亮当前卡片', tip: '鼠标悬停的回答/搜索结果卡片显示淡蓝色边框', def: true },
        refHighlight:   { group: '阅读', label: '引用角标高亮',       tip: '文内引用序号以蓝色加粗显示，便于定位参考资料', def: true },
        gifPlay:        { group: '阅读', label: 'GIF 自动播放',       tip: '点击页面任意位置后，静置的 GIF 图自动开始播放', def: false },
        directLink:     { group: '链接', label: '跳转链接直链化',     tip: '站内外链不再经过中转确认页，直接打开目标网址', def: true },
        nightMode:      { group: '外观', label: '夜间模式',           tip: '深色主题，切换即时生效无需刷新', def: false }
    };

    // ======================================================================
    // L2 数据结构层 · OPT 单一数据源（loadOpts 唯一入口，saveOpt 唯一出口）
    // ======================================================================

    var OPT = {};

    function loadOpts() {
        for (var name in OPT_DEFS) {
            var v = GM_getValue(PREFIX + '.' + name);
            OPT[name] = (typeof v === 'boolean') ? v : OPT_DEFS[name].def;
        }
        return OPT;
    }

    function saveOpt(name, value) {
        OPT[name] = value;
        GM_setValue(PREFIX + '.' + name, value);
    }

    // ======================================================================
    // L4 核心逻辑层 · 纯函数（UMD 导出，测试直接 require 真实代码）
    // ======================================================================

    // 知乎跳转链接 → 目标直链。返回 null 表示无需改写。
    // 三条路径（命中即返回，优先最明确的）：
    // ① link.zhihu.com/?target= 参数解码；② 任意 ?next=/&next= 内嵌编码 URL 解码；
    // ③ href 内嵌编码完整 URL 兜底。幂等：已是直链不含中转特征，原样返回 null。
    function resolveLink(href) {
        if (!href || href.indexOf('http') !== 0) return null;
        // ① 最明确的中转形态：link.zhihu.com/?target=<编码URL>
        var idx = href.indexOf('link.zhihu.com/?target=');
        if (idx > -1) {
            var target = href.substring(idx + 'link.zhihu.com/?target='.length);
            var amp = target.indexOf('&');
            if (amp > -1) target = target.substring(0, amp);
            target = safeDecode(target);
            return isForeign(target) ? target : null;
        }
        // ② 知乎站内链接携带编码目标（?next= / &next=）——最普遍的直跳场景
        var q = href.match(/[?&]next=([^&]+)/);
        if (q) {
            var next = safeDecode(q[1]);
            return isForeign(next) ? next : null;
        }
        // ③ 兜底：href 内嵌编码的完整 URL（中转脚本拼参）。
        // 先在编码态按 & 截断再解码 —— 目标 URL 自身的 & 是 %26，不会被误切。
        var pos = Math.max(href.lastIndexOf('https%3A%2F%2F'), href.lastIndexOf('http%3A%2F%2F'));
        if (pos > -1) {
            var frag = href.substring(pos);
            var a2 = frag.indexOf('&');
            if (a2 > -1) frag = frag.substring(0, a2);
            frag = safeDecode(frag);
            if (isForeign(frag)) return frag;
        }
        return null;
    }

    function safeDecode(s) {
        try { return decodeURIComponent(s); } catch (e) { return s; }
    }
    // 目标必须是 http(s) 且不是知乎站内（站内链接无中转，不动）
    function isForeign(u) {
        return /^https?:\/\//i.test(u) && !/^https?:\/\/([a-z0-9-]+\.)*zhihu\.com(\/|$)/i.test(u);
    }

    // zhimg 尺寸后缀白名单 —— 白名单之外一律不动，避免误伤 hash
    var IMG_SUFFIX = /^_(xs|s|m|l|xl|hd|r|b|qk|is|it|wdaz|720w|1440w)\.(jpg|jpeg|png|webp|gif)$/i;

    function normalizeImg(src) {
        if (!src || src.indexOf('zhimg.com') === -1) return null;
        var out = src.replace(/\/50\//, '/');
        var m = out.match(/(_[^_\/]+)\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i);
        // 仅剥离白名单尺寸后缀；非白名单后缀（含 hash 特征）一律不动。
        // 后缀在扩展名之前，用整段匹配替换而非按长度截断
        if (m && IMG_SUFFIX.test(m[1] + '.' + m[2])) {
            out = out.replace(m[0], '.' + m[2] + (m[3] || ''));
        }
        return out === src ? null : out;
    }

    // 原图目标解析：优先信任知乎原生 data-actualsrc 懒加载原图（最准确，
    // 带 hash 的新尺寸参数也不会被误剥），该属性缺失时才回退到 normalizeImg 剥尺寸后缀。
    // 返回 null 表示无需替换（保持现状）。
    function pickOriginal(img) {
        var src = img.getAttribute('src') || '';
        var actual = img.hasAttribute ? img.getAttribute('data-actualsrc') : null;
        // data-actualsrc 是知乎官方提供的原图地址，且与当前 src 不同 → 直接信任
        if (actual && actual !== src && actual.indexOf('zhimg.com') > -1) return actual;
        // 无原生原图信息，回退到尺寸后缀剥离
        return normalizeImg(src);
    }

    // 从「发布于 …」「编辑于 …」文本中提取绝对时间；取不到返回 null，不硬造
    var TIME_RE = /(发布于|发布时间)\s*((?:\d{4}[年\-/])?\d{1,2}[月\-/]\d{1,2}[日]?(?:\s*\d{2}:\d{2})?)|\u7f16\u8f91\u4e8e\s*((?:\d{4}[年\-/])?\d{1,2}[月\-/]\d{1,2}[日]?(?:\s*\d{2}:\d{2})?)/g;

    function pickTime(text) {
        if (!text) return null;
        TIME_RE.lastIndex = 0;
        var m, publish = null, edit = null;
        while ((m = TIME_RE.exec(text)) !== null) {
            if (m[1] && !publish) publish = m[2];
            else if (!m[1] && !edit) edit = m[3];
        }
        if (!publish && !edit) return null;
        return { publish: publish, edit: edit };
    }

    // ======================================================================
    // L3 样式层 · buildCSS 按开关拼装；夜间主题常驻、由 data-theme 门控
    // ======================================================================

    function buildCSS(opt) {
        var css = '';
        if (opt.hideLogin) css += `
            html { overflow: auto !important; margin-right: 0 !important; }
            .Modal-enter, .Modal-enter-active, .Modal-enter-done { display: none !important; }
        `;
        if (opt.hideSidebar) css += `
            /* 侧栏隐藏：四轨选取，先稳后兜。
               ① 知乎埋点语义属性（data-za-detail-view-path-module 标记右侧栏）—— 跨改版最稳定；
               ② 语义类名（GlobalSideBar / *-sideColumn / Card.*）—— 长期沿用；
               ③ 目录面板 .Catalog —— 知乎「文章目录」模块的根判据。ref/知乎优化1.js:10303
                  正是用 .Catalog.isCatalogV2 隐藏目录；其内部 .CatalogModule-title-<hash>
                  的后缀是构建哈希（ref 里 sggN4 / 9caZz 两个版本并存即证），每发版必变，
                  因此只能认 .Catalog 这一层，不能写到模块名；
               ④ 结构特征（sticky 容器内的推荐卡等）—— 兜住无类名的内联布局。 */
            div[data-za-detail-view-path-module="RightSideBar"],
            .GlobalSideBar, .Question-sideColumn, .Search-sideColumn, .Topstory-sideColumn,
            .Post-SideActions, .Post-Sub, .Post-Row-Content-right, .Catalog,
            .Card.AnswerAuthor, .Card.AuthorCard, .HotSearchCard, .Question-sideColumnAdContainer,
            .Recommendations-Main, .Question-mainColumnLogin, .Pc-card.Card,
            div[style*="position: sticky"] .Card, div[style*="position:sticky"] .Card,
            .Post-SideActions + div[style*="position: sticky"], .Post-SideActions + div[style*="position:sticky"] {
                display: none !important;
            }
            html { overflow-y: scroll !important; overflow-x: hidden !important; }

            /* —— 首页 / 搜索页：锁定标准内容宽度并居中 —— */
            .Topstory-container, .Search-container { width: 694px !important; min-width: 694px !important; margin: 0 auto !important; padding: 0 !important; }
            .Topstory { display: flex !important; justify-content: center !important; }
            .Topstory-mainColumn, .Search-mainColumn { width: 100% !important; margin: 0 !important; float: none !important; }

            /* —— 问题页：主栏居中 —— */
            .Question-main { display: block !important; width: 694px !important; margin: 0 auto !important; }
            .Question-mainColumn { width: 694px !important; margin: 0 auto !important; float: none !important; }
            .QuestionPage .ListShortcut { width: 694px !important; margin: 0 auto !important; }

            /* —— 专栏文章页：隐藏左侧目录 + 让正文真正居中放宽 ——
               知乎文章页的布局容器类名「三代演进」，写死任何一代都迟早过时：
                 第一代（纯哈希类名）：行容器 .css-kjzwqj / 正文列 .css-c0fani / 侧栏 .css-1ni4jcm
                     —— ref/知乎优化1.js:997-1001，且它的「放宽」是运行时取宽：
                        $(".css-c0fani").width($(".css-kjzwqj").width())；
                 第二代（旧语义名）：.Post-Row-Content > .Post-Row-Content-left + .Post-Row-Content-right
                     —— ref/知乎优化4.js:108-125；
                 第三代（新语义名）：.Post-NormalMain / .Post-NormalSub
                     —— ref/知乎优化3.js:385，且只在 zhuanlan 域生效（location.hostname 含 zhuanlan）。

               「侧栏都隐藏了为什么还靠左」——这是本轮的核心问题：
               正文列宽度被**写死**（通常 690px），而它的父级是 display:flex 的整行（正文列 + 目录 + 右侧栏）。
               把侧栏 display:none 之后，行里只剩正文列，而行的默认 justify-content:flex-start
               让它**贴在左侧**，右侧腾出的空间全成了空白。所以光「隐藏」不够，必须
               ① 让正文列本身变宽（放宽）或 ② 让行容器居中 —— ref 的做法是两者都做。

               本轮修正（v1.4.1）：阅读上限 1000px → READ_W（1500px），且上限随视口自适应
               （宽屏 1500px、窄屏 88vw）。起因是用户反馈「居中好了，但左右空太多」——
               居中解决的是「位置」，加宽解决的是「宽度」，两者缺一不可。
               ② 居中改用「双 auto 外边距」写法 —— 对 block 父级（需自身有确定宽度）与 flex 父级
                  （auto 外边距优先吸收剩余空间）**都成立**。上一版用 flex:0 1 auto + 父级
                  justify-content，一旦父级不是 flex 就整体失效，这是上一版在真实页面不生效的关键；
               ③ 每个可能充当「行容器」的层都先解除宽度约束（width/max-width 双 100%），
                  避免上溯链上出现「窄墙」把正文困在左侧；
               ④ 目录面板改用 .Catalog 判据（见上方隐藏列表），执行层另有上溯兜底。 */
            .Post-content, .Post-Row-Content, .Post-NormalMain, .Post-NormalSub {
                width: 100% !important; max-width: 100% !important; margin: 0 auto !important;
            }

            /* 正文列：撑满可用宽度（上限 READ_W：宽屏 1500px、窄屏 88vw）并居中。
               margin-left/right:auto 是唯一同时适配 block 与 flex 两种父级的居中手段。
               box-sizing 与 width:100% 必须成对给出，否则内边距会叠加把宽列顶出容器。 */
            .Post-NormalMain > div, .Post-NormalSub > div,
            .Post-Row-Content-left, .Post-Main,
            .Post-NormalMain .Post-Header,
            .Post-NormalMain .Post-RichTextContainer {
                width: 100% !important;
                max-width: ${READ_W}px !important;
                box-sizing: border-box !important;
                margin-left: auto !important;
                margin-right: auto !important;
            }
            .Comment-container {
                width: 100% !important; max-width: ${READ_W}px !important;
                box-sizing: border-box !important;
                margin-left: auto !important; margin-right: auto !important;
                padding-left: 0 !important; padding-right: 0 !important;
            }
            .ColumnPageHeader-content {
                max-width: ${READ_W}px !important;
                margin-left: auto !important; margin-right: auto !important;
            }

            .Topstory-container, .Topstory-mainColumn, .Question-mainColumn, .Question-main,
            .Post-content, .Post-Row-Content, .Post-Row-Content-left, .Post-NormalMain, .Post-NormalSub, .Post-Main {
                transition: none !important; animation: none !important; transform: none !important;
            }
            /* 首屏页脚防闪现：知乎 SPA 在正文水合前会先把页脚（帮助/举报/备案）渲染出来，
               造成「打开时闪一下再消失」。启动期由 html[data-zhx-booting] 先藏住，
               主内容就绪后脚本移除该属性，页脚恢复正常显示（正常的关于页不受影响）。
               判据同时覆盖新版 <footer> 与旧版 .zh-footer，避免只认单一类名。 */
            html[data-zhx-booting] footer,
            html[data-zhx-booting] .zh-footer { visibility: hidden !important; }
        `;
        if (opt.autoHideHeader) css += `
            header.AppHeader { transition: transform 0.25s ease !important; position: sticky !important; top: 0 !important; z-index: 999 !important; }
            header.AppHeader.is-hidden { transform: translateY(-100%) !important; }
            header.AppHeader.is-hidden ~ main { margin-top: -60px !important; }
        `;
        if (opt.picMaxHeight) css += `
            .ztext .content_image, .ztext .origin_image, .GifPlayer img { max-height: 500px !important; width: auto !important; }
        `;
        if (opt.hoverFocus) css += `
            .List-item:hover, .TopstoryItem:hover, .SearchResult-Card:hover {
                outline: 1px solid rgba(48, 140, 255, 0.4); outline-offset: -1px; border-radius: 6px;
            }
        `;
        if (opt.refHighlight) css += `
            .ztext sup { color: #0084ff; font-weight: 600; }
            .ztext sup a { color: #0084ff !important; }
        `;
        // 夜间主题：始终输出，html[data-theme=dark] 不存在时不产生任何效果
        css += NIGHT_CSS;
        return css;
    }

    var NIGHT_CSS = `
        html[data-theme=dark] { color-scheme: dark; }
        html[data-theme=light] { color-scheme: light; }
        html[data-theme=dark] body { color: #d3d3d3 !important; background: rgb(18,18,18) !important; }
        html[data-theme=dark] .AppHeader { background: rgb(18,18,18) !important; }
        html[data-theme=dark] .AppHeader a { color: #d3d3d3 !important; }
        html[data-theme=dark] .AppHeader .is-active, html[data-theme=dark] .AppHeader .is-active a { color: #0084ff !important; }
        html[data-theme=dark] .AppHeader input { color: #d3d3d3 !important; }
        html[data-theme=dark] .AppHeader input::placeholder { color: #8590a6 !important; }
        html[data-theme=dark] .SearchBar-input input.Input { color: #d3d3d3 !important; }
        html[data-theme=dark] .Input-wrapper, html[data-theme=dark] .InputLike { border: 1px solid #444 !important; }
        html[data-theme=dark] .QuestionHeader-title, html[data-theme=dark] .QuestionRichText,
        html[data-theme=dark] .RichContent-inner, html[data-theme=dark] .List-headerText,
        html[data-theme=dark] .ContentItem-title, html[data-theme=dark] .CommentContent,
        html[data-theme=dark] .CommentItemV2-content .RichText, html[data-theme=dark] .UserLink-link,
        html[data-theme=dark] .Post-Title, html[data-theme=dark] .Post-RichTextContainer p,
        html[data-theme=dark] .PostItem-titleText, html[data-theme=dark] .PostItem-Summary,
        html[data-theme=dark] .Card-headerText, html[data-theme=dark] .Modal-title,
        html[data-theme=dark] .Tabs-link, html[data-theme=dark] .NumberBoard-itemValue,
        html[data-theme=dark] .HotItem-title { color: #d3d3d3 !important; }
        html[data-theme=dark] .HotItem-title:hover { color: #0084ff; }
        html[data-theme=dark] .RichContent a, html[data-theme=dark] .ContentItem a { color: #8590a6 !important; }
        html[data-theme=dark] .Tabs-link.AppHeader-TabsLink { color: #d3d3d3 !important; }
        html[data-theme=dark] .PlaceHolder, html[data-theme=dark] .PlaceHolder-inner,
        html[data-theme=dark] .skeleton { background: #121212 !important; }
        html[data-theme=dark] .PlaceHolder-bg { background-color: #1b1b1b !important; background-image: linear-gradient(90deg,#1b1b1b 0,#2e2e2e 25%,#2e2e2e 75%,#1b1b1b) !important; }
        html[data-theme=dark] .skeleton__line { background-color: #1b1b1b !important; background-image: linear-gradient(90deg,#1b1b1b 0,#2e2e2e 25%,#2e2e2e 75%,#1b1b1b) !important; }
        html[data-theme=dark] .highlight pre, html[data-theme=dark] code { background: #212429 !important; color: #d3d3d3 !important; }
        html[data-theme=dark] .CornerButton { background: #1a1a1a !important; border: none !important; }
        html[data-theme=dark] .CornerButton:hover { background: #151a23 !important; }
        html[data-theme=dark] img { filter: brightness(0.6) !important; }
        html[data-theme=dark] canvas { filter: brightness(0.8) !important; }
        html[data-theme=dark] .css-97fdvh { background: #8080801c; color: #d3d3d3; border: none; }
    `;

    // ======================================================================
    // L5 执行层 · DOM 动作（全部带 data-zhx 幂等标记，重复调用零副作用）
    // ======================================================================

    function applyLink(doc) {
        if (!OPT.directLink) return 0;
        var n = 0;
        var list = doc.querySelectorAll('a[href]');
        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            if (a.hasAttribute(MARK + '-link')) continue;
            var to = resolveLink(a.getAttribute('href'));
            if (to) { a.setAttribute('href', to); n++; }
            a.setAttribute(MARK + '-link', '1');
        }
        return n;
    }

    function applyTime(doc) {
        if (!OPT.timeTop) return 0;
        var n = 0;
        var times = doc.querySelectorAll('.ContentItem-time:not([' + MARK + '-time])');
        for (var i = 0; i < times.length; i++) {
            var el = times[i];
            el.setAttribute(MARK + '-time', '1');
            var text = el.textContent || '';
            var tooltip = el.getAttribute('data-tooltip') || '';
            var t = pickTime(tooltip) || pickTime(text);
            // 只有「编辑于」时补全具体发布时间
            if (t && t.publish && text.indexOf('发布于') === -1) {
                el.textContent = '发布于 ' + t.publish + (text.trim() ? ' · ' + text.trim() : '');
            }
            // 发布时间移至卡片顶部 meta 区
            var card = el.closest ? el.closest('.ContentItem') : null;
            if (card) {
                var meta = card.querySelector('.ContentItem-meta');
                if (meta && el.parentNode !== meta) { meta.appendChild(el); n++; }
                else if (!meta) n++;
            }
        }
        return n;
    }

    function applyImg(doc) {
        if (!OPT.picOriginal) return 0;
        var n = 0;
        var imgs = doc.querySelectorAll('img[src*="zhimg.com"]:not([' + MARK + '-img])');
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            img.setAttribute(MARK + '-img', '1');
            var to = pickOriginal(img);
            if (to) {
                img.setAttribute('src', to);
                // 同步 data-actualsrc，避免懒加载框架回填占位图
                if (img.hasAttribute('data-actualsrc')) img.setAttribute('data-actualsrc', to);
                n++;
            }
        }
        return n;
    }

    function playGifs(doc) {
        if (!OPT.gifPlay) return;
        var gifs = doc.querySelectorAll('.GifPlayer');
        for (var i = 0; i < gifs.length; i++) {
            var g = gifs[i];
            if (g.hasAttribute(MARK + '-gif')) continue;
            g.setAttribute(MARK + '-gif', '1');
            try { g.click(); } catch (e) { /* 忽略 */ }
        }
    }

    // 侧栏兜底清理（内联样式容器里的推荐卡、无类名的侧栏容器 —— CSS 选择器够不到，
    // 需按结构特征上溯定位。这是 ref 脚本 'a[aria-label="边栏锚点"]'.closest('div') 的等价做法，
    // 但 aria-label 判据属知乎旧代结构，新代目录已不再使用，故改为「结构上溯」为主。）
    function hideAncestor(el, skipTags) {
        // 从 el 向上找到首个可挂样式的块级容器并隐藏；返回是否成功
        var box = el.parentNode;
        for (var k = 0; k < 5 && box && box.tagName !== 'BODY'; k++) {
            if (/^(DIV|SECTION|ASIDE|NAV)$/.test(box.tagName)) break;
            box = box.parentNode;
        }
        if (box && box.tagName !== 'BODY' && box.style) {
            if (box.style.display !== 'none') { box.style.display = 'none'; return true; }
        }
        return false;
    }

    // 正文根的候选选择器（知乎渲染器产物，跨代长期稳定）。
    // 唯一用途是充当「安全红线」：一旦上溯到的容器包含它，就绝不再往上藏 ——
    // 这条红线在 v1.3.2 里被做过头了（当时直接禁止上溯、只藏 .Catalog 自己），
    // 结果目录的**外层占位列**（常无类名）留在 flex 行里继续占位，把正文挤向一侧。
    var POST_ROOT_SEL = '.ztext, .RichText, .Post-RichTextContainer, article,' +
        ' .Post-NormalMain, .Post-NormalSub, .Post-Row-Content-left, .Post-content';

    // 从 el 起向上扩张，隐藏「仍不包含正文根」的最外层块级容器。
    // 若 el 的直接父级就已含正文，则退让为只处理 el 自身（绝不波及正文）。
    function hideColumn(el, doc) {
        var box = el;
        var node = el.parentNode;
        for (var k = 0; k < 4 && node && node.tagName !== 'BODY' && node.tagName !== 'HTML'; k++) {
            if (!/^(DIV|SECTION|ASIDE|NAV|MAIN)$/.test(node.tagName)) break;
            if (node.querySelector && node.querySelector(POST_ROOT_SEL)) break;   // 安全红线：含正文即停
            box = node;
            node = node.parentNode;
        }
        if (!box || !box.style) return false;
        if (box.tagName === 'BODY' || box.tagName === 'HTML') return false;
        if (box.style.display !== 'none') { box.style.setProperty('display', 'none', 'important'); return true; }
        return false;
    }

    function cleanSticky(doc) {
        if (!OPT.hideSidebar) return 0;
        var n = 0;
        // ① sticky 容器内的推荐卡
        var divs = doc.querySelectorAll('div[style*="position: sticky"], div[style*="position:sticky"]');
        for (var i = 0; i < divs.length; i++) {
            var d = divs[i];
            if (d.style.display !== 'none' && d.querySelector('.Card, .AnswerAuthor, .HotSearchCard')) {
                d.style.display = 'none';
                n++;
            }
        }

        // ② 目录面板 .Catalog：它本身就是面板根（ref/知乎优化1.js:10303 正是
        //    `.Catalog.isCatalogV2 { display:none }` 直接隐藏），内层 .CatalogModule-title-<hash>
        //    的后缀是构建哈希（ref 里 sggN4 / 9caZz 两版并存即证），每发版必变，只能认 .Catalog 这层。
        //    v1.3.2 曾「只藏自己、禁止上溯」，结果外层无类名的占位列留在 flex 行里，
        //    正文被挤到一侧 —— 这正是「隐藏了侧栏为什么还靠左」的直接成因。
        //    现改为：保底藏面板自身 + hideColumn() 安全上溯，把占位列一并收掉。
        var cats = doc.querySelectorAll('.Catalog:not([' + MARK + '-toc])');
        for (var c = 0; c < cats.length; c++) {
            var cat = cats[c];
            cat.setAttribute(MARK + '-toc', '1');
            var chid = false;
            if (cat.style.display !== 'none') { cat.style.setProperty('display', 'none', 'important'); chid = true; }
            if (hideColumn(cat, doc)) chid = true;                       // 上溯：外层占位列一并收掉
            if (chid) n++;
        }

        // ③ 左侧面板（目录 / 操作栏）：.Post-SideActions 是它的可靠标记。
        //    关键认知：CSS 里已给它 display:none，但**它的外层容器**（常无类名）仍留在
        //    flex 行里占位，把正文挤向一侧 —— 这正是「侧栏都隐藏了为什么还靠左」的成因。
        //    故必须上溯收掉占位容器（hideColumn 自带「含正文即停」的安全红线）。
        var sides = doc.querySelectorAll('.Post-SideActions:not([' + MARK + '-side])');
        for (var s = 0; s < sides.length; s++) {
            var sd = sides[s];
            sd.setAttribute(MARK + '-side', '1');
            if (hideColumn(sd, doc)) n++;
        }

        // ④ 旧代侧栏锚点：a[aria-label="边栏锚点"] 是 inline <a>，藏它本身不生效，
        //    须上溯到块级容器 —— 即 ref/知乎优化1.js 的 `.closest('div').hide()` 等价做法。
        //    注意：.Post-SideActions（左侧悬浮操作栏）只在 CSS 里整块 display:none，
        //    此处不做上溯 —— 它是定位元素，占不到文档流，上溯只会误伤行容器。
        var anchors = doc.querySelectorAll('a[aria-label="边栏锚点"]:not([' + MARK + '-toc])');
        for (var j = 0; j < anchors.length; j++) {
            var a = anchors[j];
            a.setAttribute(MARK + '-toc', '1');
            if (hideAncestor(a)) n++;
        }
        return n;
    }

    // 阅读上限随视口自适应（纯函数，可测）：
    // 宽屏放开到 READ_W（1500px），窄屏收成 88% 视口 —— 保证任何屏宽下左右留白都不过多。
    // 下限 900px 是给「窗口被拖得很窄」兜底，避免读数被压到不可用。
    function readCap(vw) {
        if (!vw) return READ_W;
        return Math.min(READ_W, Math.max(900, Math.round(vw * 0.88)));
    }

    // 文章页布局自适应（v1.4.0）：不依赖任何类名，纯几何驱动。
    //
    // 为什么改成几何驱动：专栏页布局容器的类名「三代演进」（哈希 .css-* → .Post-Row-Content*
    // → .Post-NormalMain*），写死任何一代都会在别的代上整条落空 —— 这正是此前几版
    // 在真实页面「一条规则都没命中」的原因。故改为自正文根出发，沿祖先链逐级修正。
    //
    // 四件事：
    //   ① 解除窄宽度上限（正文列常写死 690px 上下；视口级约束保持不动）；
    //   ② 双 auto 外边距居中 —— 对 block 父级与 flex 父级都成立（flex 下 auto 外边距
    //      优先吸收剩余空间），这是唯一不关心父级 display 的居中写法。
    //      v1.3.2 只解宽度、从不设 margin，等于「放开了却没搬动」，是本轮修复的重点；
    //   ③ 清掉为侧栏留位的不对称内边距（一侧内距远大于另一侧时）；
    //   ④ 隐藏行内「窄且几乎没有文字」的兄弟列 —— 目录 / 侧栏的占位列。
    //
    // 布局判据只能在运行时取。jsdom 无布局引擎（getBoundingClientRect 恒 0），
    // 此时本函数自动降级为「只按计算样式做规则式修正」，仍然安全且可测。
    function fixPostLayout(doc) {
        if (!OPT.hideSidebar) return 0;
        var win = doc.defaultView;
        if (!win || typeof win.getComputedStyle !== 'function') return 0;
        // 限定文章页：/p/<id> 路径，或页面里确实存在文章正文容器
        var path = (win.location && win.location.pathname) || '';
        if (!/^\/p\/\d+/.test(path) && !doc.querySelector('.Post-RichTextContainer')) return 0;
        var root = doc.querySelector('.Post-RichTextContainer, .RichText.ztext, .ztext');
        if (!root) return 0;

        var capW = readCap(win.innerWidth);   // 阅读上限：宽屏 1500px / 窄屏 88vw

        var n = 0, el = root, chain = [], i, cs, pcs, mw, p, cw, pw, iw, isNarrow, isRowFlex;
        for (i = 0; i < 8 && el && el.tagName !== 'BODY' && el.tagName !== 'HTML'; i++) {
            chain.push(el);
            el = el.parentNode;
        }
        for (i = 0; i < chain.length; i++) {
            el = chain[i];
            cs = null; pcs = null;
            try { cs = win.getComputedStyle(el); } catch (e) {}
            p = el.parentNode;
            if (p && p.tagName !== 'BODY' && p.tagName !== 'HTML') {
                try { pcs = win.getComputedStyle(p); } catch (e) {}
            }

            // ① 解除窄宽度上限：正文列常被写死 690px 上下。
            //    比阅读上限还窄的 max-width 一律解除（可能是知乎的 690，也可能是旧版脚本自己
            //    v1.3.2 写死的 1000）；比阅读上限更宽的约束（视口级）保持不动，避免拉变形页头页脚。
            if (cs && cs.maxWidth && cs.maxWidth !== 'none' && /px$/.test(cs.maxWidth)) {
                mw = parseFloat(cs.maxWidth);
                if (mw > 0 && mw < capW) { el.style.setProperty('max-width', 'none', 'important'); n++; }
            }

            // ② 加宽（本轮重点）：v1.4.0 只「解上限」不「撑宽度」，而正文列的窄往往来自**
            //    自身写死的宽度**（无论是 CSS 类给的，还是内联 style 给的 690px —— 在计算样式里
            //    读到的就是 690px），于是居中生效了、左右却各留一大片空白。用户反馈正是这个形态。
            //    判据（任一成立即视为「被写死的窄列」）：
            //      · 计算宽度明显窄于父级可用宽度（CSS 类写死的情形）
            //      · 内联宽度是 px 且小于阅读上限（第一代脚本面对的情形）
            //    动作：
            //      · 父级是 row 方向 flex 容器 → flex-grow 增长（flex-basis 写死的宽度会被填平）
            //      · 其余（block 等）          → width: 100%
            //    两条都同时给 box-sizing:border-box，否则内边距会叠加把宽列顶出容器产生横向滚动。
            //    注意不能写 width:auto —— flex 行内 auto 会缩成内容宽度，越改越窄。
            cw = pxOf(cs && cs.width);
            pw = pxOf(pcs && pcs.width);
            iw = pxOf(el.style && el.style.width);
            isNarrow = (cw > 0 && pw > 0 && cw < pw - 24) || (iw > 0 && iw < capW);
            if (isNarrow) {
                isRowFlex = !!(pcs && /^(inline-)?flex$/.test(pcs.display) &&
                    /^row/.test(pcs.flexDirection || 'row'));
                if (isRowFlex) {
                    if (!(parseFloat(cs && cs.flexGrow) > 0)) {
                        el.style.setProperty('flex-grow', '1', 'important');
                        n++;
                    }
                } else {
                    el.style.setProperty('width', '100%', 'important');
                    n++;
                }
                el.style.setProperty('box-sizing', 'border-box', 'important');
                el.style.setProperty('max-width', capW + 'px', 'important');
                el.style.setProperty('margin-left', 'auto', 'important');
                el.style.setProperty('margin-right', 'auto', 'important');
            }

            // ③ 居中：双 auto 外边距（block / flex 父级通吃）
            el.style.setProperty('margin-left', 'auto', 'important');
            el.style.setProperty('margin-right', 'auto', 'important');

            // ④ 清掉为侧栏留位的不对称内边距
            if (cs) {
                var pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
                if (pl > pr + 40) { el.style.setProperty('padding-left', '0', 'important'); n++; }
                if (pr > pl + 40) { el.style.setProperty('padding-right', '0', 'important'); n++; }
            }
        }
        // ⑤ 链上最外层（最接近 body 的那层）收阅读上限：解除宽度后避免在超宽屏上撑到满屏
        var outer = chain[chain.length - 1];
        if (outer && outer.style) {
            outer.style.setProperty('max-width', capW + 'px', 'important');
            outer.style.setProperty('margin-left', 'auto', 'important');
            outer.style.setProperty('margin-right', 'auto', 'important');
            n++;
        }
        // ⑥ 隐藏行内占位列
        n += hideNarrowCols(win, chain);
        return n;
    }

    // 计算样式里的长度取 px 数值；非 px（auto / 100% / '' / none / fit-content…）一律返回 0。
    function pxOf(v) {
        return (v && /^-?\d+(\.\d+)?px$/.test(v)) ? parseFloat(v) : 0;
    }

    // 行走行列清理：以「元素实测宽度 > 0」作为「环境有布局引擎」的开关 ——
    // jsdom 无布局引擎、宽度恒 0，若只判 w < 320 会把所有兄弟列误判成窄列。
    function hideNarrowCols(win, chain) {
        var n = 0, i, k;
        for (i = 0; i < chain.length; i++) {
            var p = chain[i].parentNode;
            if (!p || !p.children || p.children.length < 2) continue;
            var pcs;
            try { pcs = win.getComputedStyle(p); } catch (e) { continue; }
            if (!pcs || (pcs.display !== 'flex' && pcs.display !== 'grid' && pcs.display !== 'inline-flex')) continue;
            for (k = 0; k < p.children.length; k++) {
                var sib = p.children[k];
                if (sib === chain[i] || !sib.getBoundingClientRect) continue;
                if (sib.getAttribute(MARK + '-col')) continue;
                var w = sib.getBoundingClientRect().width;
                var txt = (sib.textContent || '').replace(/\s+/g, '').length;
                // 「窄」+「几乎没有正文文字」两条同时成立才动手，避免误伤正文列
                if (w > 0 && w < 320 && txt < 100) {
                    sib.setAttribute(MARK + '-col', '1');
                    sib.style.setProperty('display', 'none', 'important');
                    n++;
                }
            }
        }
        return n;
    }

    // ======================================================================
    // 文章页布局诊断（临时，v1.4.0 引入，定位完成后移除）
    //
    // 知乎对未登录的自动化浏览器返回反爬空壳（文章页 body 仅 173 字节，
    // zhuanlan 直连亦 403），真实 DOM 取不到，只能靠推断 —— 这是此前几轮
    // 「改了却不生效」的根本障碍。故本版在「自愈后仍判定未居中」时，把关键
    // 几何与结构信息以细横幅暴露在页顶，让真实 DOM 结构能随截图回传。
    //
    // 横幅自带验收信号：页面没有横幅 = 布局已判定正常。
    // ======================================================================

    // 纯函数（可测）：正文列是否明显偏离居中位置。null = 正常或无法判定。
    function layoutVerdict(w, left, viewport) {
        if (!w || !viewport || w >= viewport) return null;
        return Math.abs(left - (viewport - w) / 2) > 40 ? 1 : null;
    }

    var DIAG_ID = 'zhx-diag';

    function dropDiag(doc) {
        var d = doc.getElementById(DIAG_ID);
        if (d && d.parentNode) d.parentNode.removeChild(d);
    }

    function runDiag(doc) {
        if (!OPT.hideSidebar) { dropDiag(doc); return; }
        var win = doc.defaultView;
        var root = doc.querySelector('.Post-RichTextContainer, .RichText.ztext, .ztext');
        if (!win || !root || !root.getBoundingClientRect) { dropDiag(doc); return; }
        var r = root.getBoundingClientRect();
        if (!layoutVerdict(r.width, r.left, win.innerWidth)) { dropDiag(doc); return; }
        var f = function (s) { return doc.querySelector(s) ? '1' : '0'; };
        var marks = 'Cat' + f('.Catalog') + ' PNM' + f('.Post-NormalMain') +
            ' PC' + f('.Post-content') + ' PRC' + f('.Post-Row-Content') +
            ' SAct' + f('.Post-SideActions') + ' ztext' + f('.ztext');
        var chain = [], el = root, i;
        for (i = 0; i < 6 && el && el.tagName !== 'BODY'; i++) {
            var w = Math.round(el.getBoundingClientRect().width);
            var cls = String(el.className || '').split(/\s+/)[0] || '-';
            chain.push(el.tagName.toLowerCase() + '.' + cls + '[' + w + ']');
            el = el.parentNode;
        }
        var line1 = 'zhx ' + VERSION + ' | 视口' + win.innerWidth +
            ' 正文宽' + Math.round(r.width) + ' 左' + Math.round(r.left) +
            ' 应为' + Math.round((win.innerWidth - r.width) / 2) + ' | ' + marks;
        var line2 = '祖先: ' + chain.join(' > ');
        var d = doc.getElementById(DIAG_ID);
        if (!d) {
            d = doc.createElement('div');
            d.id = DIAG_ID;
            d.setAttribute('style', 'position:fixed;left:0;right:0;top:0;z-index:2147483003;' +
                'background:rgba(13,17,23,.94);color:#e6edf3;border-bottom:1px solid #30363d;' +
                'font:11px/16px ui-monospace,Consolas,monospace;padding:3px 8px;' +
                'white-space:nowrap;overflow-x:auto;');
            var la = doc.createElement('div'); la.textContent = line1;
            var lb = doc.createElement('div'); lb.textContent = line2;
            d.appendChild(la); d.appendChild(lb);
            (doc.body || doc.documentElement).appendChild(d);
        } else {
            if (d.children[0]) d.children[0].textContent = line1;
            if (d.children[1]) d.children[1].textContent = line2;
        }
    }

    // 节流：Watcher 每次心跳都会触发 dynRun，诊断只需在布局稳定后判定一次
    var diagPending = false;
    function scheduleDiag(doc) {
        if (diagPending) return;
        diagPending = true;
        setTimeout(function () { diagPending = false; runDiag(doc); }, 1500);
    }

    function toggleNight(on) {
        document.documentElement.setAttribute('data-theme', on ? 'dark' : 'light');
        watchNight(on);
    }

    // ======================================================================
    // L6 UI 层 · 设置面板（ghb 设计系统，zhx- 前缀，懒挂载）+ GM 菜单 + Toast
    // ======================================================================

    var UI_CSS = `
        .zhx-scope {
            --zhx-bg:#0d1117; --zhx-bg-2:#161b22; --zhx-bg-3:#21262d;
            --zhx-bd:#30363d; --zhx-bd-2:#21262d;
            --zhx-fg:#e6edf3; --zhx-fg-2:#8b949e;
            --zhx-accent:#2da44e; --zhx-accent-2:#1a7f37; --zhx-accent-fg:#ffffff;
            --zhx-shadow:0 16px 44px rgba(0,0,0,.5);
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
            color:var(--zhx-fg); font-size:13px; line-height:1.5;
        }
        #zhx-overlay { position:fixed; top:0; right:0; bottom:0; left:0; z-index:2147483001; background:rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .2s; }
        #zhx-overlay.zhx-open { opacity:1; pointer-events:auto; }
        #zhx-panel { position:fixed; left:50%; top:50%; z-index:2147483002; width:460px; max-width:calc(100vw - 32px); max-height:84vh;
            background:var(--zhx-bg); border:1px solid var(--zhx-bd); border-radius:14px; box-shadow:var(--zhx-shadow);
            display:flex; flex-direction:column; overflow:hidden; opacity:0; transform:translate(-50%,-46%) scale(.97); pointer-events:none;
            transition:opacity .22s, transform .22s cubic-bezier(.4,0,.2,1); }
        #zhx-panel.zhx-open { opacity:1; transform:translate(-50%,-50%) scale(1); pointer-events:auto; }
        .zhx-head { display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid var(--zhx-bd-2); flex:none; }
        .zhx-head h2 { margin:0; font-size:15px; font-weight:600; color:var(--zhx-fg); }
        .zhx-ver { font-size:11px; color:var(--zhx-fg-2); border:1px solid var(--zhx-bd); border-radius:999px; padding:1px 7px; }
        .zhx-icon-btn { margin-left:auto; width:28px; height:28px; display:flex; align-items:center; justify-content:center; border:none; border-radius:6px;
            background:transparent; color:var(--zhx-fg-2); cursor:pointer; font-size:16px; transition:background .15s, color .15s; }
        .zhx-icon-btn:hover { background:var(--zhx-bg-3); color:var(--zhx-fg); }
        .zhx-body { flex:1; overflow-y:auto; min-height:180px; padding:6px 0 12px; }
        .zhx-body::-webkit-scrollbar { width:8px; }
        .zhx-body::-webkit-scrollbar-thumb { background:var(--zhx-bd); border-radius:4px; }
        .zhx-group-title { padding:12px 16px 4px; font-size:11px; font-weight:600; letter-spacing:.05em; color:var(--zhx-fg-2); text-transform:uppercase; }
        .zhx-row { display:flex; align-items:center; gap:10px; padding:8px 16px; transition:background .12s; }
        .zhx-row:hover { background:var(--zhx-bg-2); }
        .zhx-row-text { flex:1; min-width:0; }
        .zhx-row-label { font-size:13px; color:var(--zhx-fg); }
        .zhx-row-tip { font-size:11px; color:var(--zhx-fg-2); margin-top:1px; }
        .zhx-switch { position:relative; width:40px; height:22px; flex:none; cursor:pointer; }
        .zhx-switch input { position:absolute; top:0; left:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; z-index:1; }
        .zhx-switch i { display:block; width:40px; height:22px; border-radius:11px; background:var(--zhx-bd); transition:background .22s; position:relative; }
        .zhx-switch i::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff;
            transition:transform .22s cubic-bezier(.4,0,.2,1); }
        .zhx-switch input:checked + i { background:var(--zhx-accent); }
        .zhx-switch input:checked + i::after { transform:translateX(18px); }
        .zhx-foot { padding:8px 16px; border-top:1px solid var(--zhx-bd-2); font-size:11px; color:var(--zhx-fg-2); flex:none; }
        #zhx-toasts { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:2147483004; display:flex;
            flex-direction:column; gap:8px; align-items:center; pointer-events:none; }
        .zhx-toast { padding:9px 14px; border-radius:8px; font-family:inherit; font-size:13px; color:#fff;
            background:#1f6feb; box-shadow:0 6px 20px rgba(0,0,0,.35); opacity:0; transform:translateY(12px);
            transition:opacity .22s, transform .22s; }
        .zhx-toast.zhx-show { opacity:1; transform:none; }
        .zhx-toast.zhx-ok { background:var(--zhx-accent); }
    `;

    var els = {};   // 懒挂载的 DOM 引用

    // Toast 容器启动即挂载（不可见空容器）：菜单切换开关时无需先打开面板也有反馈
    function ensureToasts() {
        if (document.getElementById('zhx-toasts')) return;
        var toasts = document.createElement('div');
        toasts.id = 'zhx-toasts';
        document.body.appendChild(toasts);
    }

    function mountUI() {
        if (els.panel) return;
        var style = document.createElement('style');
        style.textContent = UI_CSS;
        document.head.appendChild(style);

        var overlay = document.createElement('div');
        overlay.id = 'zhx-overlay';

        var panel = document.createElement('div');
        panel.id = 'zhx-panel';
        panel.className = 'zhx-scope';
        panel.innerHTML =
            '<div class="zhx-head"><h2>知乎阅读增强</h2><span class="zhx-ver">v' + VERSION + '</span>' +
            '<button class="zhx-icon-btn" title="关闭（Esc）">✕</button></div>' +
            '<div class="zhx-body"></div>' +
            '<div class="zhx-foot">改动即时生效，无需刷新页面。</div>';

        var body = panel.querySelector('.zhx-body');
        GROUPS.forEach(function (g) {
            var gt = document.createElement('div');
            gt.className = 'zhx-group-title';
            gt.textContent = g;
            body.appendChild(gt);
            Object.keys(OPT_DEFS).forEach(function (name) {
                var def = OPT_DEFS[name];
                if (def.group !== g) return;
                var row = document.createElement('div');
                row.className = 'zhx-row';
                row.innerHTML =
                    '<div class="zhx-row-text"><div class="zhx-row-label"></div><div class="zhx-row-tip"></div></div>' +
                    '<label class="zhx-switch"><input type="checkbox"><i></i></label>';
                row.querySelector('.zhx-row-label').textContent = def.label;
                row.querySelector('.zhx-row-tip').textContent = def.tip;
                var cb = row.querySelector('input');
                cb.checked = !!OPT[name];
                cb.addEventListener('change', function () { applyOpt(name, cb.checked); });
                body.appendChild(row);
            });
        });

        ensureToasts();

        document.body.appendChild(overlay);
        document.body.appendChild(panel);

        els = { overlay: overlay, panel: panel };

        overlay.addEventListener('click', closePanel);
        panel.querySelector('.zhx-icon-btn').addEventListener('click', closePanel);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && els.panel.classList.contains('zhx-open')) closePanel();
        });
    }

    function openPanel() { mountUI(); els.overlay.classList.add('zhx-open'); els.panel.classList.add('zhx-open'); }
    function closePanel() { els.overlay.classList.remove('zhx-open'); els.panel.classList.remove('zhx-open'); }

    function toast(msg, kind) {
        if (!document.body) return;
        ensureToasts();   // 自给自足：无论面板/启动时序如何，反馈都可达
        var box = document.getElementById('zhx-toasts');
        if (!box) return;
        var t = document.createElement('div');
        t.className = 'zhx-toast' + (kind ? ' zhx-' + kind : '');
        t.textContent = msg;
        box.appendChild(t);
        requestAnimationFrame(function () { t.classList.add('zhx-show'); });
        setTimeout(function () {
            t.classList.remove('zhx-show');
            setTimeout(function () { t.remove(); }, 250);
        }, 2200);
    }

    // 开关变更的唯一应用路径：存储 → 对应生效手段 → 菜单标签刷新
    function applyOpt(name, value) {
        saveOpt(name, value);
        var def = OPT_DEFS[name];
        if (name === 'nightMode') { toggleNight(value); registerMenu(); return; }
        if (name === 'autoHideHeader') { watchScroll(value); rebuildStyle(); return; }
        if (def) rebuildStyle();
        if (name === 'directLink') applyLink(document);
        if (name === 'timeTop') applyTime(document);
        if (name === 'picOriginal') applyImg(document);
        if (name === 'gifPlay' && value) playGifs(document);
        if (name === 'hideSidebar') {
            cleanSticky(document);
            fixPostLayout(document);
            scheduleDiag(document);
            // 关闭净化时若启动标记还在（极早期切换），立即解除，避免页脚被长期遮挡
            if (!value) document.documentElement.removeAttribute('data-zhx-booting');
        }
    }

    function rebuildStyle() {
        var el = document.getElementById('zhx-style');
        if (el) el.textContent = buildCSS(OPT);
    }

    var menuIds = [];   // 已注册菜单句柄，重注册前先摘除，避免菜单项堆积

    function registerMenu() {
        if (typeof GM_unregisterMenuCommand === 'function') {
            for (var i = 0; i < menuIds.length; i++) {
                try { GM_unregisterMenuCommand(menuIds[i]); } catch (e) { /* 忽略 */ }
            }
        }
        menuIds = [];
        menuIds.push(GM_registerMenuCommand('⚙ 设置面板', openPanel));
        menuIds.push(GM_registerMenuCommand((OPT.nightMode ? '🌙' : '☀️') + ' 夜间模式：' + (OPT.nightMode ? '开' : '关'), function () {
            applyOpt('nightMode', !OPT.nightMode);
            toast(OPT.nightMode ? '夜间模式已开启' : '夜间模式已关闭', 'ok');
        }));
    }

    // ======================================================================
    // L7 Watcher 层 · 唯一的监听者（MutationObserver / scroll / data-theme 守护）
    // ======================================================================

    function debounce(fn, wait) {
        var timer = null;
        return function () {
            if (timer) return;
            timer = setTimeout(function () { timer = null; fn(); }, wait);
        };
    }

    function dynRun() {
        applyLink(document);
        applyTime(document);
        applyImg(document);
        cleanSticky(document);
        fixPostLayout(document);
        scheduleDiag(document);
    }

    var observer = null;

    function startObserver() {
        if (observer) return;
        observer = new MutationObserver(debounce(dynRun, 200));
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    // scroll 监听（autoHideHeader 专用，随开关挂载/卸载）
    var scrollHandler = null, lastY = 0;

    function watchScroll(on) {
        if (on && !scrollHandler) {
            var tick = false;
            scrollHandler = function () {
                if (tick) return;
                tick = true;
                setTimeout(function () {
                    tick = false;
                    var header = document.querySelector('header.AppHeader');
                    if (!header) return;
                    var y = window.scrollY || 0;
                    if (y > lastY && y > 80) header.classList.add('is-hidden');
                    else header.classList.remove('is-hidden');
                    lastY = y;
                }, 120);
            };
            window.addEventListener('scroll', scrollHandler, { passive: true });
        } else if (!on && scrollHandler) {
            window.removeEventListener('scroll', scrollHandler);
            scrollHandler = null;
            var header = document.querySelector('header.AppHeader');
            if (header) header.classList.remove('is-hidden');
        }
    }

    // data-theme 守护：夜间模式开启时，站点重置主题则立即写回
    var nightGuard = null;

    function watchNight(on) {
        if (on && !nightGuard) {
            nightGuard = new MutationObserver(function () {
                if (OPT.nightMode && document.documentElement.getAttribute('data-theme') !== 'dark') {
                    document.documentElement.setAttribute('data-theme', 'dark');
                }
            });
            nightGuard.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        } else if (!on && nightGuard) {
            nightGuard.disconnect();
            nightGuard = null;
        }
    }

    // GIF 自动播放：第一次用户点击后触发一次（capture 一次性监听）
    function watchGifTrigger() {
        var handler = function () {
            document.removeEventListener('click', handler, true);
            if (OPT.gifPlay) setTimeout(function () { playGifs(document); }, 300);
        };
        document.addEventListener('click', handler, true);
    }

    // 首屏页脚防闪现：document-start 先打标记藏住页脚，主内容出现后立即解除。
    // 知乎 SPA 在正文水合前会先渲染页脚（帮助/举报/备案），表现为「打开时闪一下」。
    // 解除判据：主内容区出现任一真实内容节点（首页/问题页/文章页各取一个锚点）。
    var bootUnmarker = null;

    function watchBootMark() {
        if (!OPT.hideSidebar) return;                      // 与侧栏净化同组：未开启则不介入
        var root = document.documentElement;
        root.setAttribute('data-zhx-booting', '1');
        var done = false;
        function unmark() {
            if (done) return;
            done = true;
            root.removeAttribute('data-zhx-booting');
            if (bootUnmarker) { bootUnmarker.disconnect(); bootUnmarker = null; }
        }
        var sel = '.Topstory-container, .Question-mainColumn, .Post-content, .Search-container, .App-main > *';
        function ready() {
            var el = document.querySelector(sel);
            return !!(el && el.children.length > 0);
        }
        // 主路径：主内容一出现就解除（MutationObserver，不做轮询）
        bootUnmarker = new MutationObserver(function () { if (ready()) unmark(); });
        bootUnmarker.observe(document.documentElement, { childList: true, subtree: true });
        // 兜底：最多观察 4 秒，无论锚点是否命中都解除，绝不长期遮挡页脚
        setTimeout(unmark, 4000);
        if (ready()) unmark();
    }

    // ======================================================================
    // 启动 · document-start 注入样式防闪烁，DOMContentLoaded 后挂监听
    // ======================================================================

    function boot() {
        loadOpts();

        var styleEl = document.createElement('style');
        styleEl.id = 'zhx-style';
        styleEl.textContent = buildCSS(OPT);
        var target = document.head || document.documentElement;
        if (target) target.appendChild(styleEl);
        else requestAnimationFrame(function () { (document.head || document.documentElement).appendChild(styleEl); });

        watchBootMark();   // 越早越好：紧贴样式注入，抢在页脚渲染之前

        if (OPT.nightMode) {
            document.documentElement.setAttribute('data-theme', 'dark');
            watchNight(true);
        } else {
            document.documentElement.setAttribute('data-theme', 'light');
        }

        registerMenu();

        function start() {
            startObserver();
            watchScroll(OPT.autoHideHeader);
            dynRun();
            watchGifTrigger();
            ensureToasts();
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
        else start();
    }

    // ======================================================================
    // UMD 导出 · 测试 require 真实代码；浏览器环境照常启动
    // ======================================================================

    var API = {
        VERSION: VERSION, GROUPS: GROUPS, OPT_DEFS: OPT_DEFS,
        buildCSS: buildCSS, resolveLink: resolveLink, safeDecode: safeDecode, isForeign: isForeign,
        normalizeImg: normalizeImg, pickOriginal: pickOriginal, pickTime: pickTime,
        applyLink: applyLink, applyTime: applyTime, applyImg: applyImg, cleanSticky: cleanSticky,
        fixPostLayout: fixPostLayout, hideColumn: hideColumn, hideNarrowCols: hideNarrowCols,
        layoutVerdict: layoutVerdict, runDiag: runDiag, scheduleDiag: scheduleDiag,
        DIAG_ID: DIAG_ID, READ_W: READ_W, readCap: readCap,
        __setOpt: function (name, value) { OPT[name] = value; }   // 测试注入开关用
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = API;
    } else {
        boot();
    }
})();
