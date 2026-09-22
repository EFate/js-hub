// ==UserScript==
// @name         知乎阅读增强助手
// @namespace    js-hub/zhihu-enhance
// @version      1.0.1
// @description  净化（登录弹窗/侧边栏/顶栏）、阅读（时间置顶/原图/限高/聚焦框）、链接直链化、夜间模式 —— 11 个开关 4 组分类，菜单打开设置面板，零依赖零网络请求
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

    var VERSION = '1.0.1';
    var PREFIX = 'zh';           // 存储键前缀：zh.<开关名>
    var MARK = 'data-zhx';       // DOM 幂等标记前缀：data-zhx-<任务>

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
    // 三条路径：link.zhihu.com/?target= 参数解码 → 编码 URL 片段兜底 → 放弃。
    // 幂等：已是直链的输入不含中转特征，原样返回 null。
    function resolveLink(href) {
        if (!href || href.indexOf('http') !== 0) return null;
        var KEY = 'link.zhihu.com/?target=';
        var idx = href.indexOf(KEY);
        if (idx > -1) {
            var target = href.substring(idx + KEY.length);
            var amp = target.indexOf('&');
            if (amp > -1) target = target.substring(0, amp);
            try { target = decodeURIComponent(target); } catch (e) { /* 保留原串 */ }
            return /^https?:\/\//i.test(target) ? target : null;
        }
        // 兜底：href 内嵌编码的完整 URL（中转脚本拼参）。
        // 先在编码态按 & 截断再解码 —— 目标 URL 自身的 & 是 %26，不会被误切。
        var pos = Math.max(href.lastIndexOf('https%3A%2F%2F'), href.lastIndexOf('http%3A%2F%2F'));
        if (pos > -1) {
            var frag = href.substring(pos);
            var a2 = frag.indexOf('&');
            if (a2 > -1) frag = frag.substring(0, a2);
            try { frag = decodeURIComponent(frag); } catch (e) { /* 保留原串 */ }
            if (/^https?:\/\//i.test(frag) && !/^https?:\/\/([a-z0-9-]+\.)*zhihu\.com(\/|$)/i.test(frag)) return frag;
        }
        return null;
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
            .GlobalSideBar, .Question-sideColumn, .Search-sideColumn, .Topstory-sideColumn,
            .Post-SideActions, .Post-Sub, .Post-Row-Content-right,
            .Card.AnswerAuthor, .Card.AuthorCard, .HotSearchCard, .Question-sideColumnAdContainer,
            div[style*="position: sticky"] .Card, div[style*="position:sticky"] .Card,
            .Post-SideActions + div[style*="position: sticky"], .Post-SideActions + div[style*="position:sticky"] {
                display: none !important;
            }
            html { overflow-y: scroll !important; overflow-x: hidden !important; }
            .Topstory-container, .Search-container { width: 694px !important; min-width: 694px !important; margin: 0 auto !important; padding: 0 !important; }
            .Topstory { display: flex !important; justify-content: center !important; }
            .Topstory-mainColumn, .Search-mainColumn { width: 100% !important; margin: 0 !important; float: none !important; }
            .Question-main { display: block !important; width: 694px !important; margin: 0 auto !important; }
            .Question-mainColumn { width: 694px !important; margin: 0 auto !important; float: none !important; }
            .QuestionPage .ListShortcut { width: 694px !important; margin: 0 auto !important; }
            .Post-content, .Post-Row-Content { display: flex !important; justify-content: center !important; width: 100% !important; }
            .Post-Row-Content-left { margin: 0 auto !important; width: 690px !important; max-width: 690px !important; flex: none !important; }
            .Post-Main { margin: 0 auto !important; width: 100% !important; }
            .Comment-container { margin: 0 auto !important; width: 690px !important; max-width: 690px !important; }
            .ColumnPageHeader-content { margin: 0 auto !important; width: 690px !important; max-width: 1000px !important; }
            .Topstory-container, .Topstory-mainColumn, .Question-mainColumn, .Question-main,
            .Post-Row-Content, .Post-Row-Content-left, .Post-Main {
                transition: none !important; animation: none !important; transform: none !important;
            }
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
            var to = normalizeImg(img.getAttribute('src'));
            if (to) {
                img.setAttribute('src', to);
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

    // sticky 卡片兜底清理（内联样式容器里藏的推荐卡，CSS 选择器够不到）
    function cleanSticky(doc) {
        if (!OPT.hideSidebar) return;
        var divs = doc.querySelectorAll('div[style*="position: sticky"], div[style*="position:sticky"]');
        for (var i = 0; i < divs.length; i++) {
            var d = divs[i];
            if (d.style.display !== 'none' && d.querySelector('.Card, .AnswerAuthor, .HotSearchCard')) {
                d.style.display = 'none';
            }
        }
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
        if (name === 'hideSidebar') cleanSticky(document);
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
        buildCSS: buildCSS, resolveLink: resolveLink, normalizeImg: normalizeImg, pickTime: pickTime,
        applyLink: applyLink, applyTime: applyTime, applyImg: applyImg, cleanSticky: cleanSticky,
        __setOpt: function (name, value) { OPT[name] = value; }   // 测试注入开关用
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = API;
    } else {
        boot();
    }
})();
