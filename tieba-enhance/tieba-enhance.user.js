// ==UserScript==
// @name         贴吧清爽净化助手
// @namespace    js-hub/tieba-enhance
// @version      1.0.0
// @description  净化（广告/活动横幅/悬浮器件/会员推广）、精简（右侧栏居中/签名档/楼层杂物/彩名恢复）、阅读（帖子宽屏/图片原图/楼主高亮）、中转链接直链化 —— 12 个开关，4 组分类，菜单打开设置面板，零依赖零网络请求
// @author       EFate
// @license      MIT
// @match        *://tieba.baidu.com/*
// @match        *://*.tieba.baidu.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/tieba-enhance/tieba-enhance.user.js
// @downloadURL  https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/tieba-enhance/tieba-enhance.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ======================================================================
    // L1 配置层 · 选项定义表（一切开关的唯一来源）、选择器表与存储键约定 tb.*
    // ======================================================================

    var VERSION = '1.0.0';
    var PREFIX = 'tb';           // 存储键前缀：tb.<开关名>
    var MARK = 'data-tb';        // DOM 幂等标记前缀：data-tb-<任务>
    var LZ_CLASS = 'tbx-lz-floor';   // 楼主楼层高亮类（L3 出样式，L5 打标）

    var GROUPS = ['净化', '精简', '阅读', '链接'];

    var OPT_DEFS = {
        // —— 净化 ——
        hideAds:          { group: '净化', label: '去除广告模块',     tip: '隐藏列表与楼层中插入的推广卡片、凤巢信息流等广告节点', def: true },
        hideActivity:     { group: '净化', label: '隐藏活动横幅',     tip: '隐藏顶部活动推广条、信息推荐轮播与帖子页品牌横幅', def: true },
        hideFloatWidget:  { group: '净化', label: '隐藏悬浮器件',     tip: '隐藏页面两侧的对联广告、侧边吸附浮层与底部关注提示', def: true },
        hideMemberPromo:  { group: '净化', label: '隐藏会员推广',     tip: '隐藏会员/超级会员购买引导、楼层成就徽章与签名推广提示', def: true },
        // —— 精简 ——
        hideRightSide:    { group: '精简', label: '隐藏右侧栏并居中', tip: '隐藏帖子页与主页右侧信息栏，主栏内容居中显示', def: true },
        hideSign:         { group: '精简', label: '隐藏签名档',       tip: '回复下方的个人签名图与分割线不再显示', def: false },
        hideFloorClutter: { group: '精简', label: '隐藏楼层杂物',     tip: '隐藏分享按钮、送礼按钮、发帖成功推广等干扰元素', def: true },
        plainName:        { group: '精简', label: '会员彩名恢复默认', tip: '列表与帖子页的会员彩色昵称恢复为常规文字颜色', def: true },
        // —— 阅读 ——
        wideThread:       { group: '阅读', label: '帖子页宽屏',       tip: '放宽帖子页内容列宽，正文图片随列宽自适应', def: true },
        picOriginal:      { group: '阅读', label: '图片原图显示',     tip: '帖子内图片自动加载原始尺寸，替代压缩缩略图', def: true },
        highlightLZ:      { group: '阅读', label: '高亮楼主楼层',     tip: '楼主发出的楼层以淡蓝底色标出，长帖快速定位', def: false },
        // —— 链接 ——
        directLink:       { group: '链接', label: '中转链接直链化',   tip: '帖子里的外链跳转中转页直接还原为目标网址', def: true }
    };

    // CSS 隐藏类选择器表：开关名 → 选择器列表（每条选择器只归属一个开关，避免功能重叠）。
    // 全部选择器取自长期维护的公开净化实践与贴吧稳定结构，未命中时无副作用。
    var AD_SEL = {
        hideAds: [
            // 列表/楼层插入广告的复杂判据不走 CSS（置顶夹层防误伤），由 L4 纯函数 + L5 执行
            '[ad-dom-img]',
            '.fengchao-wrap-feed',
            '[class*="-ad-"]',
            '[class$="-ad"]',
            '[id*="_ad_"]',
            '#error_404_iframe'
        ],
        hideActivity: [
            '.bus-top-activity-wrap',
            '#plat_recom_carousel',
            '#banner_pb_customize',
            '#branding_ads'
        ],
        hideFloatWidget: [
            'body > .j_couplet',
            '.tbui_aside_float_bar + div',
            'div[id*="aside-ad"]',
            '#fc-wrap',
            '.xiu8_follow_warn'
        ],
        hideMemberPromo: [
            '.u_member',
            '.aside_region.celebrity',
            '.j-placeholder-pay-member',
            '.icon-crown-super-non',
            '.achievement_medal_section',
            '.achievement_medal_wrapper',
            '.sign_tip_sbox_1key',
            '.p-post-forbid-speech'
        ],
        hideRightSide: [
            '.right_section',
            '.aside_region.my_app',
            '.lu-search-box',
            '#lu-user-right[class*="_"]'
        ],
        hideSign: [
            '.d_sign',
            '.d_sign_split'
        ],
        hideFloorClutter: [
            '.share_thread',
            '.post-foot-send-gift-btn',
            '.quick-reply-desc',
            '.poster_success .success-foot-tip',
            '#pb-footer-header'
        ]
    };

    // ======================================================================
    // L2 数据结构层 · OPT 单一数据源（loadOpts 唯一入口，saveOpt 唯一出口，readOpt 唯一归一）
    // ======================================================================

    var OPT = {};

    // 单值归一（唯一合法判据）：布尔项非布尔一律回落默认值。
    // 读、写两条路都过它 ——「存进去的」与「用起来的」永远一致；手改存储的坏值不会生效。
    function readOpt(name, v) {
        var d = OPT_DEFS[name];
        if (!d) return false;
        return (typeof v === 'boolean') ? v : d.def;
    }

    function loadOpts() {
        for (var name in OPT_DEFS) {
            OPT[name] = readOpt(name, GM_getValue(PREFIX + '.' + name));
        }
        return OPT;
    }

    function saveOpt(name, value) {
        var v = readOpt(name, value);   // 写前归一：坏值不落盘
        if (!(name in OPT_DEFS)) return v;
        OPT[name] = v;
        GM_setValue(PREFIX + '.' + name, v);
        return v;
    }

    // ======================================================================
    // L3 样式层 · CSS 按开关拼装；document-start 注入先于首帧渲染，天然无闪烁
    // ======================================================================

    function hideRule(sels) {
        return sels.join(',\n') + '{display:none !important}';
    }

    // 组装全部规则（依赖 OPT）。「样式规则 = 开关 → 选择器表」的唯一拼装点。
    function buildStyle(o) {
        var rules = [];
        if (o.hideAds) rules.push(hideRule(AD_SEL.hideAds));
        if (o.hideActivity) rules.push(hideRule(AD_SEL.hideActivity));
        if (o.hideFloatWidget) rules.push(hideRule(AD_SEL.hideFloatWidget));
        if (o.hideMemberPromo) rules.push(hideRule(AD_SEL.hideMemberPromo));

        if (o.hideRightSide) {
            rules.push(hideRule(AD_SEL.hideRightSide));
            // 隐藏右栏后主栏居中；float:none 解除贴吧双栏布局
            rules.push('#content{margin:0 auto !important;float:none !important}');
        }
        if (o.hideSign) rules.push(hideRule(AD_SEL.hideSign));
        if (o.hideFloorClutter) rules.push(hideRule(AD_SEL.hideFloorClutter));

        if (o.plainName) {
            // 列表页彩名类 + 帖子页作者名：一律恢复继承色，防渐变字底
            rules.push(
                '.j_thread_list .red_text,.j_thread_list .red-text,' +
                '.j_thread_list .vip_red,.j_thread_list .vip-red,' +
                '.j_thread_list .sign_highlight{color:inherit !important}',
                '.d_name .p_author_name{color:inherit !important;text-shadow:none !important}'
            );
        }

        if (o.wideThread) {
            // 温和放大主栏（默认约 980px），窄窗口自然收缩；正文图随列宽自适应
            rules.push(
                '#content{width:1200px !important;max-width:96vw !important;box-sizing:border-box !important}',
                '.d_post_content .BDE_Image{height:auto !important;max-width:100% !important}'
            );
        }
        if (o.highlightLZ) {
            rules.push('.' + LZ_CLASS + '{background:#f0f7ff !important;box-shadow:inset 3px 0 0 #4a9eff !important}');
        }
        return rules.join('\n');
    }

    var STYLE_ID = 'tb-style';

    function ensureStyleEl() {
        var el = document.getElementById(STYLE_ID);
        if (el) return el;
        el = document.createElement('style');
        el.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(el);
        return el;
    }

    // 首次注入：document-start 时 head 可能未就绪，挂到 documentElement 上也立即生效
    function applyStyle() {
        ensureStyleEl().textContent = buildStyle(OPT);
    }

    // 重扫描/设置变更：原地改 textContent，不删节点不留空档
    function rebuildStyle() {
        applyStyle();
    }

    // document-start 阶段 style 挂在 documentElement 上；head 就绪后归位，保证层叠优先级
    function placeStyle() {
        var el = document.getElementById(STYLE_ID);
        if (el && document.head && el.parentNode !== document.head) {
            document.head.appendChild(el);
        }
    }

    // ======================================================================
    // L4 核心逻辑层 · 纯函数（UMD 导出，测试直接 require 真实代码）
    // ======================================================================

    // 中转跳转链接 → 目标直链。返回 null 表示无需改写（幂等：直链不含中转特征）。
    // 路径：① href 参数 ?url=/?u= 携带编码目标，解码提取；② safecheck 类中转的
    // 锚文本本身即目标 URL，作兜底。解码结果必须是 http(s) 外链且非百度系域名 ——
    // 拿不准的不改写（识别红线：宁可不处理，不误处理）。
    function resolveTiebaLink(href, text) {
        if (!href || typeof href !== 'string' || href.indexOf('http') !== 0) return null;
        if (!/(jump\.bdimg\.com|jump2\.bdimg\.com|jump2\.baidu\.com|jump\.baidu\.com)/.test(href)) return null;

        function hostOf(u) {
            var m = u.match(/^https?:\/\/([^\/?#]+)/i);
            return m ? m[1].toLowerCase() : '';
        }
        function isForeign(u) {
            return /^https?:\/\//i.test(u) && !/(^|\.)(baidu\.com|bdimg\.com|bdstatic\.com|bcebos\.com)$/i.test(hostOf(u));
        }
        function extractUrl(raw) {
            var m = raw.match(/^https?:\/\/[^\s"'<>，。；、）】【\u4e00-\u9fff]+/i);
            return m ? m[0] : null;
        }

        // ① href 参数解码（url= / u=）
        var qi = href.indexOf('?');
        if (qi > -1) {
            var pairs = href.slice(qi + 1).split('#')[0].split('&');
            for (var i = 0; i < pairs.length; i++) {
                var kv = pairs[i];
                var eq = kv.indexOf('=');
                if (eq < 0) continue;
                var key = kv.slice(0, eq);
                if (key !== 'url' && key !== 'u') continue;
                try {
                    var dec = decodeURIComponent(kv.slice(eq + 1));
                    var direct = extractUrl(dec);
                    if (direct && isForeign(direct)) return direct;
                } catch (e) { /* 解码失败走兜底 */ }
            }
        }

        // ② 锚文本兜底：safecheck 中转的链接文字即目标 URL
        var t = (typeof text === 'string' ? text : '').trim();
        if (t.indexOf('http') === 0) {
            var cand = extractUrl(t);
            if (cand && isForeign(cand)) return cand;
        }
        return null;
    }

    // 帖子图 → 原图 URL。返回 null 表示无需改写（幂等：已是原图原样返回 null）。
    // 优先取 data-original（静态渲染失败时的真实图源）；否则把贴吧图片 CDN 的
    // 尺寸段（/forum/w?=?N/、/wh=N,M/ 等）替换为原图目录 /forum/pic/item/。
    function pickOriginalUrl(src, dataOriginal) {
        var d = (typeof dataOriginal === 'string' ? dataOriginal : '').trim();
        if (d.indexOf('http') === 0 && d.indexOf('/forum/pic/item/') > -1) return d;

        if (!src || typeof src !== 'string') return null;
        var clean = src.split('#')[0].split('?')[0];
        var fi = clean.indexOf('/forum/');
        if (fi < 0) return null;
        var tail = clean.slice(fi);                     // '/forum/...'
        if (tail.indexOf('/forum/pic/item/') === 0) return null;   // 已是原图（幂等）
        // 真实结构：/forum/<尺寸段>/sign=<hash>/<文件>.<ext>；原图目录为 /forum/pic/item/<文件>.<ext>
        var segs = tail.split('/');
        var file = segs[segs.length - 1];
        if (!file || !/\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)) return null;
        var sizeSeg = segs[2];
        if (!sizeSeg || sizeSeg === 'pic' || sizeSeg.indexOf('sign=') === 0) return null;
        return clean.slice(0, fi) + '/forum/pic/item/' + file;
    }

    // 楼层 → 楼主判据的原料：data-field JSON 里的 author.user_id。
    // 解析失败一律返回 null（不处理、不猜）。
    function floorAuthorId(el) {
        if (!el || el.nodeType !== 1) return null;
        var raw = el.getAttribute('data-field');
        if (!raw) return null;
        try {
            var d = JSON.parse(raw);
            var uid = d && d.author && d.author.user_id;
            return (uid !== undefined && uid !== null) ? uid : null;
        } catch (e) {
            return null;
        }
    }

    // 列表插入广告判据（L5 sweepListAds 的唯一实现，测试直接喂真实结构）：
    // 正常帖子（含置顶）都携带 data-tid；插入广告既无 data-tid 也不属于置顶夹层。
    // 父级必须是 #thread_list 直下 —— 置顶夹层容器内部的节点天然不进入判据。
    function isListAd(el) {
        if (!el || el.nodeType !== 1 || el.tagName !== 'LI') return false;
        if (el.getAttribute('data-tid')) return false;
        if (el.hasAttribute(MARK + '-ad')) return false;
        var cls = (el.className || '') + '';
        if (cls.indexOf('thread_top_list_folder') > -1) return false;
        var df = el.getAttribute('data-field') || '';
        if (df.indexOf('author_') > -1) return false;
        var p = el.parentElement;
        if (!p || p.id !== 'thread_list') return false;
        return true;
    }

    // 楼层插入广告判据：正常楼层 data-field 含 "content" 键且携带 data-tid；
    // 广告楼层两者皆缺。class 不含 l_post 的一律不判（避免误伤工具节点）。
    function isFloorAd(el) {
        if (!el || el.nodeType !== 1) return false;
        var cls = (el.className || '') + '';
        if (cls.indexOf('l_post') < 0) return false;
        if (el.getAttribute('data-tid')) return false;
        if (el.hasAttribute(MARK + '-ad')) return false;
        var df = el.getAttribute('data-field') || '';
        if (df.indexOf('"content"') > -1 || df.indexOf('content\\') > -1) return false;
        return true;
    }

    // ======================================================================
    // L5 执行层 · DOM 改写，重入幂等（标记位防重复处理）
    // ======================================================================

    // 中转链接直链化：只扫中转域名的 a，处理过的一律打标记跳过
    function rewriteLinks(root, o) {
        if (!o.directLink) return 0;
        var list = root.querySelectorAll('a[href*="jump.bdimg.com"],a[href*="jump2.bdimg.com"],a[href*="jump2.baidu.com"],a[href*="jump.baidu.com"]');
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            if (a.hasAttribute(MARK + '-link')) continue;
            a.setAttribute(MARK + '-link', '1');
            var direct = resolveTiebaLink(a.getAttribute('href'), a.textContent);
            if (direct) {
                a.setAttribute('href', direct);
                n++;
            }
        }
        return n;
    }

    // 帖子图原图化：只处理 .BDE_Image（帖子正文图），列表缩略图有懒加载机制不动
    function normalizePics(root, o) {
        if (!o.picOriginal) return 0;
        var imgs = root.querySelectorAll('img.BDE_Image');
        var n = 0;
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            if (img.hasAttribute(MARK + '-pic')) continue;
            img.setAttribute(MARK + '-pic', '1');
            var orig = pickOriginalUrl(img.getAttribute('src'), img.getAttribute('data-original'));
            if (orig) {
                img.setAttribute('src', orig);
                n++;
            }
        }
        return n;
    }

    // 楼主楼层高亮：一楼作者即楼主（贴吧语义），同作者楼层全量重算，天然幂等
    function markLZFloors(o) {
        if (!o.highlightLZ) return 0;
        var list = document.querySelector('#j_p_postlist');
        if (!list) return 0;
        var floors = list.querySelectorAll('.l_post');
        if (!floors.length) return 0;
        var lz = floorAuthorId(floors[0]);
        if (lz === null) return 0;
        var n = 0;
        for (var i = 0; i < floors.length; i++) {
            var f = floors[i];
            var id = floorAuthorId(f);
            if (id === null) continue;
            if (id === lz) {
                if (!f.classList.contains(LZ_CLASS)) {
                    f.classList.add(LZ_CLASS);
                    n++;
                }
            } else {
                f.classList.remove(LZ_CLASS);
            }
        }
        return n;
    }

    // 列表/楼层插入广告清扫：CSS 判据不可表达的部分（置顶夹层防误伤）由纯函数判定
    function sweepListAds(o) {
        if (!o.hideAds) return 0;
        var n = 0;
        var tl = document.querySelector('#thread_list');
        if (tl) {
            for (var i = 0; i < tl.children.length; i++) {
                var li = tl.children[i];
                if (li.hasAttribute(MARK + '-ad')) continue;
                if (isListAd(li)) {
                    li.setAttribute(MARK + '-ad', '1');
                    li.style.display = 'none';
                    n++;
                }
            }
        }
        var pl = document.querySelector('#j_p_postlist');
        if (pl) {
            for (var j = 0; j < pl.children.length; j++) {
                var el = pl.children[j];
                if (el.hasAttribute(MARK + '-ad')) continue;
                if (isFloorAd(el)) {
                    el.setAttribute(MARK + '-ad', '1');
                    el.style.display = 'none';
                    n++;
                }
            }
        }
        return n;
    }

    // 一次全量清扫：启动与 Watcher 重扫共用；单项失败不拖整体
    function domPass(o) {
        o = o || OPT;
        var r = { links: 0, pics: 0, lz: 0, ads: 0 };
        try { r.links = rewriteLinks(document, o); } catch (e) { /* 单项失败不拖整体 */ }
        try { r.pics = normalizePics(document, o); } catch (e) { /* 单项失败不拖整体 */ }
        try { r.lz = markLZFloors(o); } catch (e) { /* 单项失败不拖整体 */ }
        try { r.ads = sweepListAds(o); } catch (e) { /* 单项失败不拖整体 */ }
        return r;
    }

    // ======================================================================
    // L6 UI 层 · 设置面板（ghb 视觉规范，tb- 前缀；懒挂载，菜单唯一入口）
    // ======================================================================

    var PANEL_CSS = [
        'html{--tb-accent:#2da44e;--tb-accent-2:#1a7f37;--tb-accent-fg:#ffffff;',
        '--tb-good:#2da44e;--tb-warn:#d29922;--tb-bad:#f85149;}',
        '.tb-scope{',
        '--tb-bg:#0d1117;--tb-bg-2:#161b22;--tb-bg-3:#21262d;',
        '--tb-bd:#30363d;--tb-bd-2:#21262d;',
        '--tb-fg:#e6edf3;--tb-fg-2:#8b949e;--tb-fg-3:#6e7681;',
        '--tb-shadow:0 16px 44px rgba(0,0,0,.5);',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
        'color:var(--tb-fg);font-size:13px;line-height:1.5;}',
        '@media (prefers-color-scheme: light){',
        '.tb-scope{--tb-bg:#ffffff;--tb-bg-2:#f6f8fa;--tb-bg-3:#eaeef2;',
        '--tb-bd:#d0d7de;--tb-bd-2:#d8dee4;',
        '--tb-fg:#1f2328;--tb-fg-2:#59636e;--tb-fg-3:#818b98;',
        '--tb-shadow:0 16px 44px rgba(31,35,40,.16);}}',
        '#tb-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s;}',
        '#tb-overlay.tb-open{opacity:1;pointer-events:auto;}',
        '#tb-panel{position:fixed;left:50%;top:50%;z-index:2147483002;width:460px;max-width:calc(100vw - 32px);max-height:84vh;',
        'background:var(--tb-bg);border:1px solid var(--tb-bd);border-radius:14px;box-shadow:var(--tb-shadow);',
        'display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translate(-50%,-46%) scale(.97);pointer-events:none;',
        'transition:opacity .22s,transform .22s cubic-bezier(.4,0,.2,1);}',
        '#tb-panel.tb-open{opacity:1;transform:translate(-50%,-50%) scale(1);pointer-events:auto;}',
        '.tb-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--tb-bd-2);flex:none;}',
        '.tb-head h2{margin:0;font-size:15px;font-weight:600;color:var(--tb-fg);}',
        '.tb-head .tb-ver{font-size:11px;color:var(--tb-fg-2);border:1px solid var(--tb-bd);border-radius:999px;padding:1px 7px;}',
        '.tb-tabs{display:flex;border-bottom:1px solid var(--tb-bd-2);flex:none;background:var(--tb-bg-2);}',
        '.tb-tab{flex:1;padding:10px 0;border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:13px;',
        'color:var(--tb-fg-2);border-bottom:2px solid transparent;transition:color .15s,background .15s;}',
        '.tb-tab:hover{color:var(--tb-fg);background:var(--tb-bg-3);}',
        '.tb-tab.tb-on{color:var(--tb-fg);font-weight:600;border-bottom-color:var(--tb-accent);}',
        '.tb-body{flex:1;overflow-y:auto;min-height:180px;}',
        '.tb-body::-webkit-scrollbar{width:8px;}',
        '.tb-body::-webkit-scrollbar-thumb{background:var(--tb-bd);border-radius:4px;}',
        '.tb-page{display:none;} .tb-page.tb-on{display:block;}',
        '.tb-setting{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;transition:background .12s;}',
        '.tb-setting:hover{background:var(--tb-bg-2);}',
        '.tb-st-t{font-size:13px;color:var(--tb-fg);}',
        '.tb-st-d{font-size:11.5px;color:var(--tb-fg-2);margin-top:2px;}',
        '.tb-switch{position:relative;width:40px;height:22px;flex:none;cursor:pointer;}',
        '.tb-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1;}',
        '.tb-switch i{display:block;width:40px;height:22px;border-radius:11px;background:var(--tb-bd);transition:background .22s;position:relative;}',
        '.tb-switch i::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;',
        'transition:transform .22s cubic-bezier(.4,0,.2,1);}',
        '.tb-switch input:checked + i{background:var(--tb-accent);}',
        '.tb-switch input:checked + i::after{transform:translateX(18px);}',
        '.tb-icon-btn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:none;border-radius:6px;',
        'background:transparent;color:var(--tb-fg-2);cursor:pointer;font-size:14px;transition:background .15s,color .15s;}',
        '.tb-icon-btn:hover{background:var(--tb-bg-3);color:var(--tb-fg);}'
    ].join('\n');

    var uiBuilt = false;

    // 开关行 DOM：标题 + 说明 + 开关（label/说明来自 OPT_DEFS，单一来源）
    function makeSettingRow(name) {
        var d = OPT_DEFS[name];
        var row = document.createElement('div');
        row.className = 'tb-setting';
        var left = document.createElement('div');
        var t = document.createElement('div');
        t.className = 'tb-st-t';
        t.textContent = d.label;
        var tip = document.createElement('div');
        tip.className = 'tb-st-d';
        tip.textContent = d.tip;
        left.appendChild(t);
        left.appendChild(tip);
        var lab = document.createElement('label');
        lab.className = 'tb-switch';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('data-opt', name);
        input.checked = OPT[name];
        var i = document.createElement('i');
        lab.appendChild(input);
        lab.appendChild(i);
        row.appendChild(left);
        row.appendChild(lab);
        return row;
    }

    function buildUI() {
        if (uiBuilt) return;

        var style = document.createElement('style');
        style.id = 'tb-panel-style';
        style.textContent = PANEL_CSS;
        document.head.appendChild(style);

        var overlay = document.createElement('div');
        overlay.id = 'tb-overlay';
        var panel = document.createElement('div');
        panel.id = 'tb-panel';
        panel.className = 'tb-scope';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', '贴吧清爽净化助手设置');

        var head = document.createElement('div');
        head.className = 'tb-head';
        var h2 = document.createElement('h2');
        h2.textContent = '贴吧清爽净化助手';
        var ver = document.createElement('span');
        ver.className = 'tb-ver';
        ver.textContent = 'v' + VERSION;
        var closeBtn = document.createElement('button');
        closeBtn.className = 'tb-icon-btn';
        closeBtn.id = 'tb-close';
        closeBtn.textContent = '✕';
        closeBtn.setAttribute('aria-label', '关闭');
        head.appendChild(h2);
        head.appendChild(ver);
        head.appendChild(closeBtn);

        var tabs = document.createElement('div');
        tabs.className = 'tb-tabs';
        var body = document.createElement('div');
        body.className = 'tb-body';

        var namesByGroup = {};
        for (var name in OPT_DEFS) {
            var g = OPT_DEFS[name].group;
            (namesByGroup[g] = namesByGroup[g] || []).push(name);
        }
        GROUPS.forEach(function (g, idx) {
            var tab = document.createElement('button');
            tab.className = 'tb-tab' + (idx === 0 ? ' tb-on' : '');
            tab.setAttribute('data-tab', g);
            tab.textContent = g;
            tabs.appendChild(tab);

            var page = document.createElement('div');
            page.className = 'tb-page' + (idx === 0 ? ' tb-on' : '');
            page.setAttribute('data-page', g);
            (namesByGroup[g] || []).forEach(function (n) {
                page.appendChild(makeSettingRow(n));
            });
            body.appendChild(page);
        });

        panel.appendChild(head);
        panel.appendChild(tabs);
        panel.appendChild(body);
        document.body.appendChild(overlay);
        document.body.appendChild(panel);
        uiBuilt = true;
    }

    function openPanel() {
        buildUI();
        document.getElementById('tb-overlay').classList.add('tb-open');
        document.getElementById('tb-panel').classList.add('tb-open');
    }

    function closePanel() {
        var o = document.getElementById('tb-overlay');
        var p = document.getElementById('tb-panel');
        if (o) o.classList.remove('tb-open');
        if (p) p.classList.remove('tb-open');
    }

    function bindPanelEvents() {
        // 事件委托：面板只绑一次
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!uiBuilt) return;
            if (t && t.id === 'tb-overlay') { closePanel(); return; }
            if (t && (t.id === 'tb-close' || (t.closest && t.closest('#tb-close')))) { closePanel(); return; }
            var tab = t && t.closest ? t.closest('.tb-tab') : null;
            if (tab) {
                var g = tab.getAttribute('data-tab');
                var all = document.querySelectorAll('.tb-tab');
                for (var i = 0; i < all.length; i++) all[i].classList.remove('tb-on');
                tab.classList.add('tb-on');
                var pages = document.querySelectorAll('.tb-page');
                for (var j = 0; j < pages.length; j++) {
                    pages[j].classList.toggle('tb-on', pages[j].getAttribute('data-page') === g);
                }
            }
        }, false);

        document.addEventListener('change', function (ev) {
            var t = ev.target;
            if (!t || !t.getAttribute || !t.hasAttribute('data-opt')) return;
            var name = t.getAttribute('data-opt');
            if (!(name in OPT_DEFS)) return;
            saveOpt(name, t.checked);
            rebuildStyle();   // CSS 类功能即时生效免刷新
            domPass(OPT);     // DOM 类功能立即补清扫
        }, false);

        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') closePanel();   // 面板规范：Esc 关闭（唯一允许的快捷键）
        }, false);
    }

    // ======================================================================
    // L7 Watcher 层 · 唯一的 DOM 监听者（MutationObserver，250ms 防抖）
    // ======================================================================

    var _debTimer = null;

    function watch() {
        if (typeof MutationObserver === 'undefined') return;
        var mo = new MutationObserver(function () {
            if (_debTimer) clearTimeout(_debTimer);
            _debTimer = setTimeout(function () {
                _debTimer = null;
                domPass(OPT);
            }, 250);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ======================================================================
    // 启动序列 · loadOpts → applyStyle → (DOMContentLoaded) placeStyle + domPass → watch
    // ======================================================================

    function registerMenu() {
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('打开设置面板', openPanel);
        }
    }

    function start() {
        placeStyle();      // head 就绪后归位：静态规则层叠优先于站点样式
        bindPanelEvents();
        domPass(OPT);
        watch();
    }

    function boot() {
        loadOpts();
        applyStyle();      // document-start：CSS 隐藏先于首帧渲染，防闪
        registerMenu();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }
    }

    // ======================================================================
    // UMD 导出 · 测试 require 真实代码；浏览器环境照常启动
    // ======================================================================

    var API = {
        VERSION: VERSION, PREFIX: PREFIX, MARK: MARK, GROUPS: GROUPS,
        OPT_DEFS: OPT_DEFS, AD_SEL: AD_SEL, LZ_CLASS: LZ_CLASS,
        readOpt: readOpt, saveOpt: saveOpt,
        buildStyle: buildStyle, hideRule: hideRule,
        resolveTiebaLink: resolveTiebaLink, pickOriginalUrl: pickOriginalUrl,
        floorAuthorId: floorAuthorId, isListAd: isListAd, isFloorAd: isFloorAd,
        rewriteLinks: rewriteLinks, normalizePics: normalizePics, bindPanelEvents: bindPanelEvents,
        markLZFloors: markLZFloors, sweepListAds: sweepListAds, domPass: domPass,
        openPanel: openPanel, closePanel: closePanel, buildUI: buildUI,
        __setOpt: function (name, value) { OPT[name] = value; },   // 测试注入开关用
        __getOpt: function (name) { return OPT[name]; }
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = API;
    } else {
        boot();
    }
})();
