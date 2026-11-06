// ==UserScript==
// @name         知乎美化整合版
// @namespace    https://www.zhihu.com/
// @version      2026.7.31
// @description  帖子默认折叠；点击左外侧空白切换展开/折叠，收起时回到展开前锚点 + 背景闪动；菜单可开关宽屏、移除侧边栏、隐藏顶栏、调整图片高度、适配深色模式。
// @author       quellan
// @match        *://*.zhihu.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @license GPL-3.0
// ==/UserScript==

(function () {
    'use strict';

    // ====== 1. 菜单定义 ======
    var menu_ALL = [
        ['menu_leftToggle',  '左侧空白切换展开/折叠', '点击帖子左外侧空白切换对应帖子的展开/折叠', true],
        ['menu_flash',       '收起时背景闪动提示',    '收起帖子时背景闪动三下提示位置', true],
        ['menu_widescreenDisplay',          '宽屏显示', '各页面开启宽屏显示（刷新后查看效果）', ''],
        ['menu_widescreenDisplayIndex',     '首页',     '宽屏显示', true],
        ['menu_widescreenDisplayQuestion',  '问题页',   '宽屏显示', true],
        ['menu_widescreenDisplaySearch',    '搜索页、话题页', '宽屏显示', true],
        ['menu_widescreenDisplayCollection','收藏页',   '宽屏显示', true],
        ['menu_widescreenDisplayPost',      '文章页',   '宽屏显示', false],
        ['menu_widescreenDisplayWidth',     '宽屏宽度', '宽屏宽度 (默认 1000)', '1000'],
        ['menu_hideSidebar', '移除右侧侧边栏',     '隐藏知乎所有页面右侧边栏、广告、作者卡片', true],
        ['menu_picHeight',   '调整图片最大高度',    '限制帖子内图片最大高度为 500px', true],
        ['menu_hideTitle',   '向下翻时自动隐藏顶栏', '向下翻时自动隐藏顶栏', true],
        ['menu_nightMode',   '夜间模式',              '开启/关闭夜间模式', false]
    ], menu_ID = [];

    // ====== 2. 函数声明（hoisted）======

    function safe(fn) {
        try { fn(); } catch (e) { console.error('[zhihu-enhance]', fn.name, e); }
    }

    function registerMenuCommand() {
        for (const id of menu_ID) { try { GM_unregisterMenuCommand(id); } catch (e) {} }
        menu_ID = [];
        for (let i = 0; i < menu_ALL.length; i++) {
            const item = menu_ALL[i];
            item[3] = GM_getValue(item[0]);
            if (item[0] === 'menu_widescreenDisplay') {
                menu_ID.push(GM_registerMenuCommand(`#️⃣ ${item[1]}`, function () {
                    menu_setting(item[1], item[2], [
                        menu_ALL[i + 1], menu_ALL[i + 2], menu_ALL[i + 3],
                        menu_ALL[i + 4], menu_ALL[i + 5], menu_ALL[i + 6]
                    ]);
                }));
            } else if (item[0] === 'menu_nightMode') {
                menu_ID.push(GM_registerMenuCommand((item[3] ? '✅' : '❌') + ' ' + item[1], function () {
                    menu_nightMode_toggle(item[3]);
                }));
            } else if (item[0].indexOf('menu_widescreenDisplay') === -1) {
                menu_ID.push(GM_registerMenuCommand(`${item[3] ? '✅' : '❌'} ${item[1]}`, function () {
                    menu_switch(item[3], item[0], item[2]);
                }));
            }
        }
    }

    function menu_value(menuName) {
        for (const menu of menu_ALL) {
            if (menu[0] === menuName) return menu[3];
        }
    }

    function menu_switch(currentVal, Name, Tips) {
        GM_setValue(Name, !currentVal);
        GM_notification({
            text: `${currentVal ? '已关闭' : '已开启'} [${Tips}] 功能\n（点击刷新网页后生效）`,
            timeout: 3500,
            onclick: function () { location.reload(); }
        });
        registerMenuCommand();
    }

    function menu_nightMode_toggle(currentVal) {
        var newVal = !currentVal;
        GM_setValue('menu_nightMode', newVal);
        if (newVal) {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.setAttribute('data-theme', 'light');
        }
        GM_notification({
            text: (newVal ? '已开启' : '已关闭') + ' 夜间模式',
            timeout: 2000,
        });
        registerMenuCommand();
    }

    function menu_setting(title, tips, menu) {
        const styleEl = document.createElement('style');
        styleEl.textContent = `
            .zhihuE_SettingBackdrop_1 {position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 203; display: flex; flex-direction: column; justify-content: center; overflow: auto;}
            .zhihuE_SettingBackdrop_2 {position: absolute; top: 0; right: 0; bottom: 0; left: 0; z-index: 0; background-color: rgba(18,18,18,.65);}
            .zhihuE_SettingRoot {position: relative; z-index: 1; margin: 0 auto; min-width: 400px; max-width: 600px; color: #535353; background-color: #fff; border-radius: 3px;}
            .zhihuE_SettingHeader {padding: 10px 20px; color: #fff; font-weight: bold; background-color: #3994ff; border-radius: 3px 3px 0 0;}
            .zhihuE_SettingHeader span {float: right; cursor: pointer;}
            .zhihuE_SettingMain {padding: 10px 20px;}
            .zhihuE_SettingMain input[type=text] {width: 50px; margin: 0 4px;}
            .zhihuE_SettingMain label {margin-right: 20px; user-select: none; cursor: pointer; vertical-align: middle;}
            .zhihuE_SettingMain hr {border: 0.5px solid #f4f4f4;}
        `;
        document.head.appendChild(styleEl);
        let html = `<div class="zhihuE_SettingBackdrop_1"><div class="zhihuE_SettingBackdrop_2"></div><div class="zhihuE_SettingRoot">
            <div class="zhihuE_SettingHeader">${title}<span class="zhihuE_SettingClose" title="点击关闭">✕</span></div>
            <div class="zhihuE_SettingMain"><p>${tips}</p><hr>`;
        for (let i = 0; i < menu.length; i++) {
            if (menu[i][0] === 'menu_widescreenDisplayWidth') {
                html += `<label>${menu[i][2]}：<input name="${menu[i][0]}" type="text" value="${GM_getValue(menu[i][0])}"></label><br>`;
            } else if (GM_getValue(menu[i][0])) {
                html += `<label><input name="zhihuE_Setting_Checkbox" type="checkbox" value="${menu[i][0]}" checked>${menu[i][1]}</label><br>`;
            } else {
                html += `<label><input name="zhihuE_Setting_Checkbox" type="checkbox" value="${menu[i][0]}">${menu[i][1]}</label><br>`;
            }
        }
        html += `</div></div></div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        setTimeout(function () {
            document.querySelector('.zhihuE_SettingClose').onclick = function () {
                this.closest('.zhihuE_SettingBackdrop_1').remove();
                styleEl.remove();
            };
            document.querySelector('.zhihuE_SettingBackdrop_2').onclick = function (e) {
                if (e.target === this) document.querySelector('.zhihuE_SettingClose').click();
            };
            document.getElementsByName('zhihuE_Setting_Checkbox').forEach(function (cb) {
                cb.addEventListener('click', function () { GM_setValue(this.value, this.checked); });
            });
            document.getElementsByName('menu_widescreenDisplayWidth')[0].onchange = function () {
                GM_setValue(this.name, this.value);
            };
        }, 100);
    }

    function addStyle() {
        let style = `
            .Question-mainColumnLogin { display: none !important; }
            .Pc-card.Card { display: none !important; }
            .Recommendations-Main { display: none !important; }
        `;
        if (location.pathname === '' || location.pathname === 'hot' || location.pathname === 'follow') {
            style += `
                .TopstoryItem--advertCard { display: none !important; }
                main.App-main > .Topstory > div:not(.Topstory-container) { display: none !important; }
            `;
        }
        if (menu_value('menu_hideSidebar')) style += hideSidebarCSS;
        if (menu_value('menu_widescreenDisplayIndex')) style += style_widescreenDisplayIndex;
        if (menu_value('menu_widescreenDisplayQuestion') && location.pathname.indexOf('question') > -1) style += style_widescreenDisplayQuestion;
        if (menu_value('menu_widescreenDisplaySearch') && (location.pathname === 'search' || location.pathname.indexOf('club') > -1 || location.pathname.indexOf('topic') > -1)) style += style_widescreenDisplaySearch;
        if (menu_value('menu_widescreenDisplayCollection') && location.pathname.indexOf('collection') > -1) style += style_widescreenDisplayCollection;
        if (menu_value('menu_widescreenDisplayPost') && location.hostname.indexOf('zhuanlan') > -1 && location.pathname.indexOf('edit') === -1) style += style_widescreenDisplayPost;
        if (menu_value('menu_hideTitle')) style += style_hideTitle;
        if (menu_value('menu_picHeight')) style += style_picHeight;
        style += style_flash;
        style += style_nightMode;

        const styleEl = document.createElement('style');
        styleEl.textContent = style;
        // document-start 时 document.lastChild 可能是 DocumentType，appendChild 会抛错；
        // 用 document.head（已存在则用）或 document.documentElement（<html>，一定存在）
        const target = document.head || document.documentElement;
        if (target) target.appendChild(styleEl);
        else requestAnimationFrame(function () { (document.head || document.documentElement).appendChild(styleEl); });
    }

    function initHideHeaderScroll() {
        if (!menu_value('menu_hideTitle')) return;
        const headerSel = 'header.AppHeader';
        let lastScrollY = 0, headerEl = null;
        const threshold = 80;
        function throttle(fn, delay) {
            let timer = null;
            return function (...args) {
                if (!timer) {
                    timer = setTimeout(function () { fn.apply(this, args); timer = null; }, delay);
                }
            };
        }
        function handleScroll() {
            if (!headerEl) headerEl = document.querySelector(headerSel);
            if (!headerEl) return;
            const currY = window.scrollY;
            if (currY > lastScrollY && currY > threshold) headerEl.classList.add('is-hidden');
            else headerEl.classList.remove('is-hidden');
            lastScrollY = currY;
        }
        window.addEventListener('scroll', throttle(handleScroll, 30));
        const observer = new MutationObserver(throttle(function () {
            headerEl = document.querySelector(headerSel);
        }, 100));
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    function initSidebarObserver() {
        if (!menu_value('menu_hideSidebar')) return;
        function debounce(func, wait) {
            let timeout;
            return function (...args) {
                clearTimeout(timeout);
                timeout = setTimeout(function () { func.apply(this, args); }, wait);
            };
        }
        function cleanSidebarCard() {
            requestAnimationFrame(function () {
                document.querySelectorAll('div[style*="position: sticky"], div[style*="position:sticky"]').forEach(function (div) {
                    if (div.style.display !== 'none' && div.querySelector('.Card, .AnswerAuthor, .HotSearchCard')) {
                        div.style.display = 'none';
                    }
                });
            });
        }
        const observer = new MutationObserver(debounce(cleanSidebarCard, 50));
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cleanSidebarCard);
        else cleanSidebarCard();
    }

    // ====== 3. 折叠/展开 + 闪动 + 锚点（核心功能）======

    function isInteractive(el) {
        if (!el || el.nodeType !== 1) return false;
        if (INTERACTIVE_TAGS.includes(el.tagName)) return true;
        const role = el.getAttribute && el.getAttribute('role');
        if (role && INTERACTIVE_ROLES.includes(role)) return true;
        if (el.classList && INTERACTIVE_CLASSES.some(c => el.classList.contains(c))) return true;
        return false;
    }

    function findByText(scope, texts) {
        if (!scope) return null;
        for (const b of scope.querySelectorAll('button')) {
            if (texts.includes((b.textContent || '').trim())) return b;
        }
        return null;
    }

    // fireClick 派发的 click 会冒泡到 document 触发 onClick，用标志位阻止二次执行
    let isFiringClick = false;
    // 状态锁：同一帖子 1 秒内禁止重复触发，防止抖动
    let lastToggle = { el: null, time: 0 };

    // 模拟真实鼠标点击：mousedown → mouseup → click
    // span.click() 对知乎的 span.RichContent-collapsedText 不生效，需派发完整事件序列
    function fireClick(el) {
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
        try {
            const r = el.getBoundingClientRect();
            opts.clientX = r.left + r.width / 2;
            opts.clientY = r.top + r.height / 2;
        } catch (e) {}
        isFiringClick = true;
        try {
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
            return true;
        } catch (e) {
            try { el.click(); return true; } catch (e2) { return false; }
        } finally {
            isFiringClick = false;
        }
    }

    // 独立覆盖层 div 闪动，不依赖目标元素 class，不受 React 重新渲染影响
    // 用 absolute 定位 + 绝对坐标，滚动时覆盖层跟随帖子移动
    function flashElement(el) {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const h = Math.min(rect.height, 200); // 限制高度避免展开态跨多条帖子
        const flash = document.createElement('div');
        flash.className = 'zhihu-flash-overlay';
        flash.style.cssText =
            'position:absolute;top:' + (rect.top + window.scrollY) + 'px;left:' + rect.left + 'px;' +
            'width:' + rect.width + 'px;height:' + h + 'px;';
        document.body.appendChild(flash);
        setTimeout(function () { flash.remove(); }, 1300);
    }

    function findMoreButton(scope) {
        if (!scope) return null;
        return scope.querySelector('.ContentItem-more') || findByText(scope, ['阅读全文', '展开阅读全文']);
    }

    function findCollapseButton(scope) {
        if (!scope) return null;
        return scope.querySelector('.RichContent-collapsedText') ||
            scope.querySelector('.ContentItem-collapse') ||
            findByText(scope, ['收起', '收起全文']);
    }

    function toggleContent(content, card) {
        if (!content) return;
        const anchorHolder = card || content;
        if (content.classList.contains('is-collapsed')) {
            // 折叠态 → 展开：记录展开前帖子顶部相对视口位置，供折叠时回到此锚点
            anchorHolder.dataset.zhihuAnchor = String(content.getBoundingClientRect().top);
            const moreBtn = findMoreButton(content) || findMoreButton(card);
            if (moreBtn) fireClick(moreBtn);
            else content.classList.remove('is-collapsed');
        } else {
            // 展开态 → 折叠：先回到展开前锚点，再触发收起
            // scrollTo 在 fireClick 之前，不会打断知乎收起逻辑；同步执行无延迟
            const anchor = parseFloat(anchorHolder.dataset.zhihuAnchor || '');
            if (!isNaN(anchor)) {
                const rect = content.getBoundingClientRect();
                window.scrollTo(0, rect.top + window.scrollY - anchor);
            }
            const collapseBtn = findCollapseButton(content) || findCollapseButton(card);
            if (collapseBtn) fireClick(collapseBtn);
            else content.classList.add('is-collapsed');
            if (GM_getValue('menu_flash', true)) flashElement(content);
        }
    }

    function onClick(e) {
        if (e.button !== 0) return;
        if (isInteractive(e.target)) return;
        if (isFiringClick) return; // 忽略 fireClick 派发的 click，避免二次触发
        const x = e.clientX, y = e.clientY;
        const contents = document.querySelectorAll('.RichContent');
        for (const content of contents) {
            const rect = content.getBoundingClientRect();
            if (y < rect.top || y > rect.bottom) continue;   // y 不在该帖子范围，跳过
            // y 匹配 + 点击在左外侧空白，才执行切换
            if (x < rect.left) {
                // 状态锁：同一帖子 1 秒内禁止重复触发
                const now = Date.now();
                if (lastToggle.el === content && now - lastToggle.time < 1000) return;
                lastToggle = { el: content, time: now };
                const card = content.closest('.ContentItem, .List-item, .TopstoryItem, .Card');
                toggleContent(content, card);
                e.preventDefault();
                e.stopPropagation();
                return; // 命中目标帖子后终止，避免下方帖子重复触发
            }
            // 仅 y 匹配但 x 在内容区，继续遍历下一条（不 return）
        }
    }

    function startClickToggle() {
        if (!menu_value('menu_leftToggle')) return;
        function start() {
            if (!document.body) { requestAnimationFrame(start); return; }
            document.addEventListener('click', onClick, true);
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
        else start();
    }

    // ====== 4. CSS 常量（必须在 safe 调用之前定义，避免 TDZ）======
    const INTERACTIVE_TAGS = ['A', 'BUTTON', 'IMG', 'INPUT', 'VIDEO', 'SVG', 'TEXTAREA', 'SELECT', 'CANVAS'];
    const INTERACTIVE_ROLES = ['button', 'link', 'checkbox', 'tab', 'menuitem'];
    const INTERACTIVE_CLASSES = ['VoteButton', 'Button', 'ContentItem-actions', 'ContentItem-meta'];

    const sidebarSelectors = [
        '.GlobalSideBar', '.Question-sideColumn', '.Post-SideActions', '.Post-Sub',
        '.Post-Row-Content-right', '.Search-sideColumn', '.Topstory-sideColumn',
        '.Card.AnswerAuthor', '.Card.AuthorCard', '.HotSearchCard', '.Question-sideColumnAdContainer'
    ].join(', ');
    const hideSidebarCSS = `
        ${sidebarSelectors},
        div[style*="position: sticky"] .Card, div[style*="position:sticky"] .Card,
        .Post-SideActions + div[style*="position: sticky"], .Post-SideActions + div[style*="position:sticky"] {
            display: none !important;
        }
        html { overflow-y: scroll !important; overflow-x: hidden !important; }
    `;
    const W = () => GM_getValue('menu_widescreenDisplayWidth');
    const style_widescreenDisplayIndex = `.Topstory-mainColumn, .QuestionWaiting-mainColumn { width: inherit !important; } .GlobalSideBar { display: none !important; } .Topstory-container { width: ${W()}px; }`;
    const style_widescreenDisplayQuestion = `.Question-mainColumn, .ListShortcut, .QuestionWaiting-mainColumn { width: inherit !important; } .Question-sideColumn, .GlobalSideBar { display: none !important; } .QuestionWaiting-mainColumn { margin-right: 0 !important; } .Question-main { width: ${W()}px; }`;
    const style_widescreenDisplaySearch = `.SearchMain, .ContentLayout-mainColumn, .Club-mainColumn, .Post-mainColumn { width: inherit !important; } .SearchSideBar, .ContentLayout-sideColumn, .Card.QuestionHeaderTopicMeta, .ClubSideBar { display: none !important; } .Search-container, .ContentLayout, .Club-container, .Post-container { width: ${W()}px; }`;
    const style_widescreenDisplayCollection = `.CollectionsDetailPage-mainColumn { width: inherit !important; } .CollectionDetailPageSideBar { display: none !important; } .CollectionsDetailPage { width: ${W()}px; }`;
    const style_widescreenDisplayPost = `.Post-SideActions { left: calc(10vw) !important; } .Post-NormalMain .Post-Header, .Post-NormalMain > div, .Post-NormalSub > div { width: ${W()}px !important; }`;
    const style_hideTitle = `
        header.AppHeader { transition: transform 0.25s ease !important; position: sticky !important; top: 0 !important; z-index: 999 !important; }
        header.AppHeader.is-hidden { transform: translateY(-100%) !important; }
        body { transition: padding-top 0.25s ease !important; }
        header.AppHeader.is-hidden ~ main { margin-top: -60px !important; }
    `;
    const style_picHeight = `.ztext .content_image, .ztext .origin_image, .GifPlayer img { max-height: 500px !important; width: auto !important; }`;
    const style_flash = `
        @keyframes zhihu-flash-anim { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
        .zhihu-flash-overlay { background-color: rgba(255, 200, 60, 0.45); pointer-events: none; z-index: 99999; animation: zhihu-flash-anim 0.4s ease-in-out 3; }
    `;
    const style_nightMode = `
        html[data-theme=dark] body { color: #d3d3d3 !important; background: rgb(18,18,18) !important; }
        html[data-theme=dark] .AppHeader { background: rgb(18,18,18) !important; }
        html[data-theme=dark] .AppHeader a { color: #d3d3d3 !important; }
        html[data-theme=dark] .AppHeader .is-active,
        html[data-theme=dark] .AppHeader .is-active a { color: #0084FF !important; }
        html[data-theme=dark] .AppHeader input { color: #d3d3d3 !important; }
        html[data-theme=dark] .AppHeader input::placeholder { color: #8590a6 !important; }
        html[data-theme=dark] .SearchBar-input input.Input { color: #d3d3d3 !important; }
        html[data-theme=dark] .Zi--Bell path { fill: #8590a6; }
        html[data-theme=dark] .Zi--Comments path { fill: #8590a6; }
        html[data-theme=dark] .Input-wrapper { border: 1px solid #444 !important; }
        html[data-theme=dark] .AppHeaderProfileMenu-item.css-1e76yen { color: #d3d3d3 !important; }
        html[data-theme=dark] .QuestionHeader-title,
        html[data-theme=dark] .QuestionRichText,
        html[data-theme=dark] .RichContent-inner,
        html[data-theme=dark] .List-headerText,
        html[data-theme=dark] .ContentItem-title,
        html[data-theme=dark] .CommentTopbar-title,
        html[data-theme=dark] .CommentContent,
        html[data-theme=dark] .CommentItemV2-content .RichText,
        html[data-theme=dark] .UserLink-link,
        html[data-theme=dark] .Post-Title,
        html[data-theme=dark] .Post-RichTextContainer p,
        html[data-theme=dark] .PostItem-titleText,
        html[data-theme=dark] .PostItem-Title,
        html[data-theme=dark] .PostItem-Summary,
        html[data-theme=dark] .Card-headerText,
        html[data-theme=dark] .Modal-title,
        html[data-theme=dark] .Tabs-link,
        html[data-theme=dark] .NumberBoard-itemValue { color: #d3d3d3 !important; }
        html[data-theme=dark] .css-w8abe7,
        html[data-theme=dark] .css-12qxk2,
        html[data-theme=dark] .css-huwkhm,
        html[data-theme=dark] .css-wgpue5,
        html[data-theme=dark] .css-17714ul,
        html[data-theme=dark] .css-ul9l2m,
        html[data-theme=dark] .css-iue0mv,
        html[data-theme=dark] .css-7wvdjh,
        html[data-theme=dark] .css-tpyajk,
        html[data-theme=dark] .css-13445jb { background: rgb(18,18,18) !important; }
        html[data-theme=dark] .Tabs-link.AppHeader-TabsLink { color: #d3d3d3 !important; }
        html[data-theme=dark] .AppHeaderProfileMenu .Button.Menu-item { color: #d3d3d3; }
        html[data-theme=dark] img { filter: brightness(0.6) !important; }
        html[data-theme=dark] canvas { filter: brightness(0.8) !important; }
        html[data-theme=dark] .Zi--FormatBold,
        html[data-theme=dark] .Zi--FormatItalic,
        html[data-theme=dark] .Zi--FormatHeader,
        html[data-theme=dark] .Zi--FormatBlockquote,
        html[data-theme=dark] .Zi--InsertOrderedList,
        html[data-theme=dark] .Zi--InsertUnorderedList,
        html[data-theme=dark] .Zi--InsertReference,
        html[data-theme=dark] .Zi--InsertDivider,
        html[data-theme=dark] .Zi--InsertCatalog { fill: #d3d3d3; }
        html[data-theme=dark] .InputLike { border: 1px solid #444 !important; }
        html[data-theme=dark] .css-97fdvh { background: #8080801c; color: #d3d3d3; border: none; }
        html[data-theme=dark] .css-10sdhww,
        html[data-theme=dark] .css-haouk6,
        html[data-theme=dark] .css-hrmgdd { background: rgb(18,18,18) !important; }
        html[data-theme=dark] .css-1yumt4k a,
        html[data-theme=dark] .RichContent a,
        html[data-theme=dark] .ContentItem a { color: #8590a6 !important; }
        html[data-theme=dark] .PlaceHolder,
        html[data-theme=dark] .PlaceHolder-inner,
        html[data-theme=dark] .skeleton { background: #121212 !important; }
        html[data-theme=dark] .PlaceHolder-bg { background-color: #1b1b1b !important; background-image: linear-gradient(90deg,#1b1b1b 0,#2e2e2e 25%,#2e2e2e 75%,#1b1b1b) !important; }
        html[data-theme=dark] .PlaceHolder-bg svg path { fill: #121212 !important; }
        html[data-theme=dark] .skeleton__line { background-color: #1b1b1b !important; background-image: linear-gradient(90deg,#1b1b1b 0,#2e2e2e 25%,#2e2e2e 75%,#1b1b1b) !important; }
        html[data-theme=dark] .skeleton__line::after { background-color: #1b1b1b !important; box-shadow: none !important; }
        html[data-theme=dark] .css-kt4t4n,
        html[data-theme=dark] .css-p1wstz,
        html[data-theme=dark] .css-h9kawn { background: #191b1f !important; }
        html[data-theme=dark] .css-70t8h2 { background: #121212 !important; border-bottom: 20px solid #121212; }
        html[data-theme=dark] .css-wqf2py:hover { color: #0084ff !important; }
        html[data-theme=dark] .css-172osot,
        html[data-theme=dark] .css-3dzt4y { background: #191b1f !important; }
        html[data-theme=dark] .css-exogbb { background: #191b1f !important; }
        html[data-theme=dark] .css-1n0llfn a { color: #d3d3d3 !important; }
        html[data-theme=dark] .css-z19u8v { border-bottom: 1px solid #444 !important; }
        html[data-theme=dark] .css-1851sov { color: #d3d3d3 !important; }
        html[data-theme=dark] .HotItem-title { color: #d3d3d3; }
        html[data-theme=dark] .HotItem-title:hover { color: #0084ff; }
        html[data-theme=dark] .HotSearchCard-title,
        html[data-theme=dark] .HotSearchCard-itemText { color: #d3d3d3; }
        html[data-theme=dark] .popover-root-jPqox,
        html[data-theme=dark] .popover-header-xeHyh { background: #121212 !important; }
        html[data-theme=dark] .popover-header-xeHyh div:last-of-type { background: #444 !important; }
        html[data-theme=dark] .highlight pre,
        html[data-theme=dark] code { background: #212429 !important; color: #d3d3d3 !important; }
        html[data-theme=dark] .css-1olvdus pre,
        html[data-theme=dark] .css-1olvdus code { background: #212429 !important; }
        html[data-theme=dark] .CornerButton { background: #1a1a1a !important; border: none !important; }
        html[data-theme=dark] .CornerButton:hover { background: #151a23 !important; }
        html[data-theme=dark] .CornerButton svg { fill: #8590a6 !important; }
        html[data-theme=dark] .CornerButton:hover svg { fill: #0084FF !important; }
    `;

    // ====== 5. 启动（必须在所有 const 定义之后，避免 TDZ ReferenceError）======
    for (let i = 0; i < menu_ALL.length; i++) {
        if (GM_getValue(menu_ALL[i][0]) == null) GM_setValue(menu_ALL[i][0], menu_ALL[i][3]);
    }
    safe(registerMenuCommand);
    if (GM_getValue('menu_nightMode')) {
        var applyNight = function () {
            document.documentElement.setAttribute('data-theme', 'dark');
        };
        if (document.readyState === 'complete') {
            safe(applyNight);
        } else {
            window.addEventListener('load', function () { safe(applyNight); });
        }
        // 监听 html 属性变化，若被知乎重置则重新应用
        var nightObserver = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                if (m.attributeName === 'data-theme' && GM_getValue('menu_nightMode')) {
                    if (document.documentElement.getAttribute('data-theme') !== 'dark') {
                        document.documentElement.setAttribute('data-theme', 'dark');
                    }
                }
            });
        });
        nightObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } else {
        // 夜间模式未开启时，强制亮色模式，防止知乎原生暗色模式干扰
        document.documentElement.setAttribute('data-theme', 'light');
    }
    safe(addStyle);
    safe(initHideHeaderScroll);
    safe(initSidebarObserver);
    safe(startClickToggle);
})();
