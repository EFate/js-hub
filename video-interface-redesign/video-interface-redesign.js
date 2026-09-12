// ==UserScript==
// @name         视频站界面净化重组助手
// @namespace    https://github.com/EFate
// @version      1.0.4
// @description  评分制识别小视频站（不依赖固定域名，换域自动跟随），识别到立刻自动进入净化模式：四通道清广告（弹窗拦截 · 注入拦截 · 悬浮清扫 · 防回弹），并重组界面：分类折叠、搜索置顶、卡片栅格规整、杂物清理。全程无 UI 侵入。
// @author       EFate
// @license      MIT
// @updateURL    https://gh-proxy.com/https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/video-interface-redesign/video-interface-redesign.js
// @downloadURL  https://gh-proxy.com/https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/video-interface-redesign/video-interface-redesign.js
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-start
// ==/UserScript==

/*
 * ============================================================================
 *  视频站界面净化重组助手 · 架构总览（单文件，自顶向下分层，禁止跨层反向依赖）
 * ============================================================================
 *
 *   L1  CONFIG      检测签名表 · 广告模式规则 · 重组样式参数 · 存储键（唯一事实来源）
 *   L2  FOUNDATION  Utils（选择器/防抖/日志） · Store（GM 持久化 + 内存兜底）
 *   L3  DETECT      SiteDetector 指纹评分 → 阈值判定 → 每域名缓存一次
 *   L4  NETGUARD    NetGuard：window.open 弹窗拦截 · script/iframe 注入拦截
 *   L5  CLEAN       AdSweeper 悬浮/内嵌广告清扫 + 防回弹 · LayoutEngine 界面重组
 *   L6  VIEW        Toast 轻提示（唯一 UI，操作反馈用）
 *   L7  BOOTSTRAP   装配启动（body 就绪即判定 · 识别到立刻自动净化 · 负向重试） · Watcher · 油猴菜单
 *
 *   依赖自上而下单向。识别采用「评分制 + 硬门槛」：标题/分类导航/排行榜/视频卡片
 *   四类指纹加权打分，达标且卡片与导航双硬门槛同时满足才激活；其余站点只付出
 *   一次快照采集的成本。所有清理动作幂等并带 data-vir 标记，可安全重扫。
 *
 *   性能红线：识别每域名仅一次；清扫走防抖 MutationObserver，单轮限量；
 *   快照采集只做计数与正则，禁止全页序列化。
 */

(function (root, factory) {
    var api = factory(root);
    // Node 环境导出内部 API 供冒烟测试；浏览器挂到 window.__VIR__
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.__VIR__ = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    /* ======================================================================
     * L1 CONFIG — 常量、存储键、检测签名、广告规则（唯一事实来源）
     * ====================================================================== */
    var CONFIG = {
        VERSION: '1.0.4',
        PREFIX: 'vir',
        KEYS: {
            ENABLED: 'vir.enabled',      // 全局开关（默认 true）
            STRENGTH: 'vir.strength',    // 清理强度：normal | strong
            EXEMPT: 'vir.exempt',        // 豁免域名列表（JSON 数组）
            STATS: 'vir.stats'           // 累计统计 { blocked, swept }
        },
        DETECT: {
            THRESHOLD: 7,                // 激活分数线
            W_TITLE: 2,                  // 标题命中视频关键词
            W_META: 1,                   // meta keywords 命中
            W_NAV: 3,                    // 分类导航指纹
            W_RANK: 2,                   // 排行榜 tab 指纹
            W_CARDS: 3,                  // 视频卡片栅格指纹
            W_PATH: 1,                   // URL 路径指纹
            NAV_MIN_LINKS: 12,           // 分类导航：容器内短文本链接下限
            NAV_KEEP: 8,                 // 折叠后保留的链接数（约 2 行）
            RANK_MIN: 3,                 // 排行榜 tab 下限
            CARDS_MIN: 8,                // 视频卡片下限
            HARD_NAV: 10,                // 硬门槛：导航链接数
            HARD_CARDS: 6,               // 硬门槛：卡片数
            TITLE_RE: /视频|影视|影院|传媒|影片|新片|短片|追剧|剧场|福利|在线观看/,
            META_RE: /视频|影视|影院|影片|剧集|高清/,
            RANK_RE: /^(热播|总|月|周|日|年)排行榜$/,
            CARD_DATE_RE: /\d{1,2}-\d{1,2}|\d{4}-\d{2}-\d{2}/,
            PATH_RE: /\/(vod|detail|play|type|video|vplay|api\.php\/provide)/i
        },
        AD: {
            /* 广告资源 URL 指纹（用于弹窗拦截与注入拦截） */
            URL_RE: new RegExp(
                'doubleclick\\.net|googlesyndication|googletagservices|googleadservices' +
                '|\\.tanx\\.com|cpro\\.baidu|pos\\.baidu|hm\\.baidu|cnzz\\.|umeng\\.' +
                '|miaozhen|allyes|admaster|adsame|adview|adcdn|mediav\\.com' +
                '|\\/ads?\\/[a-z0-9_-]+\\.(js|php)|\\/adjs|\\/gg\\/|\\/gg\\.(js|php)|guanggao' +
                '|\\/abc\\/[a-z0-9_]+\\.js|\\/000\\/' +
                '|\\/uv\\.js|\\/tk\\.js|\\/kstk\\.js', 'i'),
            /* 悬浮/内嵌广告的 class·id 黑名单指纹 */
            NAME_RE: /(^|[-_0-9])(ad|ads|adv|advert|advertisement|gg|bnn|banner|float|floating|popup|popover|suspend|kefu|service|downapp|appdown|qrcode|follow|wx|weixin|tip|tips|notice|dialog|layer|mask|ticket|ico)([-_0-9]|$)/i,
            /* 友情链接/公告等杂物指纹 */
            CLUTTER_RE: /(friendlink|friendly[-_]?link|yq[-_]?link|blogroll|beian|icp|gonggao|announce|marquee|tongji|statistic)/i,
            SWEEP_LIMIT: 24             // 单轮清扫移除上限，防误伤失控
        },
        LAYOUT: {
            CARD_MIN: 6,                // 栅格规整：容器内卡片下限
            SEARCH_TOP: 360             // 搜索栏 sticky：表单距页顶上限（px）
        }
    };

    /* ======================================================================
     * L2 FOUNDATION — Utils · Store
     * ====================================================================== */
    var Utils = {
        qs: function (sel, ctx) { return (ctx || document).querySelector(sel); },
        qsa: function (sel, ctx) {
            return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
        },
        debounce: function (fn, ms) {
            var t = null;
            return function () {
                var args = arguments, self = this;
                clearTimeout(t);
                t = setTimeout(function () { fn.apply(self, args); }, ms);
            };
        },
        host: function () {
            try { return (root.location && root.location.hostname) || ''; }
            catch (e) { return ''; }
        },
        log: function () {
            if (root.console && root.console.log) {
                var args = Array.prototype.slice.call(arguments);
                args.unshift('[VIR]');
                root.console.log.apply(root.console, args);
            }
        }
    };

    var Store = (function () {
        /* GM 存储优先，Node/无授权环境内存兜底 */
        var mem = {};
        var hasGM = typeof root.GM_getValue === 'function' && typeof root.GM_setValue === 'function';
        function get(key, def) {
            try {
                var v = hasGM ? root.GM_getValue(key, def) : mem[key];
                if (v === undefined || v === null) return def;
                return v;
            } catch (e) { return def; }
        }
        function set(key, val) {
            try {
                if (hasGM) root.GM_setValue(key, val);
                else mem[key] = val;
            } catch (e) { /* 存储失败不阻塞 */ }
        }
        function getJSON(key, def) {
            var v = get(key, def);
            if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = def; } }
            return v || def;
        }
        return {
            isEnabled: function () { return get(CONFIG.KEYS.ENABLED, true) !== false; },
            setEnabled: function (v) { set(CONFIG.KEYS.ENABLED, !!v); },
            strength: function () { return get(CONFIG.KEYS.STRENGTH, 'normal'); },
            setStrength: function (s) { set(CONFIG.KEYS.STRENGTH, s === 'strong' ? 'strong' : 'normal'); },
            isExempt: function (host) {
                var list = getJSON(CONFIG.KEYS.EXEMPT, []);
                return list.indexOf(host) !== -1;
            },
            toggleExempt: function (host) {
                var list = getJSON(CONFIG.KEYS.EXEMPT, []);
                var i = list.indexOf(host);
                if (i === -1) list.push(host); else list.splice(i, 1);
                set(CONFIG.KEYS.EXEMPT, list);
                return i === -1; // true = 已加入豁免
            },
            stats: function () { return getJSON(CONFIG.KEYS.STATS, { blocked: 0, swept: 0 }); },
            addStats: function (delta) {
                var s = getJSON(CONFIG.KEYS.STATS, { blocked: 0, swept: 0 });
                s.blocked += delta.blocked || 0;
                s.swept += delta.swept || 0;
                set(CONFIG.KEYS.STATS, s);
            },
            resetStats: function () { set(CONFIG.KEYS.STATS, { blocked: 0, swept: 0 }); }
        };
    })();

    /* ======================================================================
     * L3 DETECT — SiteDetector：快照 → 评分 → 判定（纯函数，可测）
     * ====================================================================== */
    var SiteDetector = {
        _cache: {}, // { host: { verdict, score, snapshot } }

        /** 纯评分：snapshot = { title, meta, navLinks, rankTabs, cards, path } */
        score: function (s) {
            var D = CONFIG.DETECT, sc = 0;
            if (D.TITLE_RE.test(s.title || '')) sc += D.W_TITLE;
            if (D.META_RE.test(s.meta || '')) sc += D.W_META;
            if (s.navLinks >= D.NAV_MIN_LINKS) sc += D.W_NAV;
            else if (s.navLinks >= 8) sc += 1;
            if (s.rankTabs >= D.RANK_MIN) sc += D.W_RANK;
            if (s.cards >= D.CARDS_MIN) sc += D.W_CARDS;
            else if (s.cards >= 4) sc += 1;
            if (D.PATH_RE.test(s.path || '')) sc += D.W_PATH;
            return sc;
        },

        /** 纯判定：分数线 + 三重硬门槛，压掉新闻门户等误报
         *  门槛 1：评分达线；门槛 2：导航 AND 卡片数量足；门槛 3：至少命中一个强特征
         *  （标题指纹 / 排行榜 tab / 路径指纹），防止纯数量拼分误激活 */
        verdict: function (s) {
            var D = CONFIG.DETECT;
            var sc = this.score(s);
            if (sc < D.THRESHOLD) return { active: false, score: sc };
            if (s.navLinks < D.HARD_NAV) return { active: false, score: sc };
            if (s.cards < D.HARD_CARDS) return { active: false, score: sc };
            var strongHit = D.TITLE_RE.test(s.title || '') ||
                s.rankTabs >= D.RANK_MIN ||
                D.PATH_RE.test(s.path || '');
            if (!strongHit) return { active: false, score: sc };
            return { active: true, score: sc };
        },

        /** 判定：正向结果每域名缓存；负向不缓存（内容后到的页面需持续重试） */
        judge: function (host) {
            var cached = this._cache[host];
            if (cached && cached.active) return cached;
            var snap = this.collect();
            var r = this.verdict(snap);
            r.snapshot = snap;
            if (r.active) {
                this._cache[host] = r;
                Utils.log('识别', host, '评分', r.score, '→ 视频站，激活');
            } else {
                Utils.log('识别', host, '评分', r.score, '→ 暂不激活（内容未就绪将继续重试）');
            }
            return r;
        },

        /** DOM 快照采集（只计数，不序列化） */
        collect: function () {
            var doc = root.document;
            if (!doc || !doc.body) {
                return { title: '', meta: '', navLinks: 0, rankTabs: 0, cards: 0, path: '' };
            }
            var D = CONFIG.DETECT;
            var metaEl = Utils.qs('meta[name="keywords"], meta[name="description"]', doc);
            var meta = metaEl ? (metaEl.content || '') : '';

            // 指纹 1：分类导航——短文本叶子链接按 2 级祖先聚桶取最大
            //（兼容链接被逐个 div 包裹的模板，不依赖 :scope > a 直链）
            var navBest = 0;
            var allAnchors = Utils.qsa('a', doc);
            for (var i = 0; i < allAnchors.length && navBest < D.NAV_MIN_LINKS; i++) {
                var a = allAnchors[i];
                var t = (a.textContent || '').trim();
                if (!t || t.length > 6) continue;
                if (a.querySelector && a.querySelector('img')) continue; // 排除卡片缩略图链接
                var anc = a;
                for (var lv = 0; lv < 2 && anc.parentNode; lv++) anc = anc.parentNode;
                if (!anc.__virNavN) anc.__virNavN = 0;
                navBest = Math.max(navBest, ++anc.__virNavN);
            }

            // 指纹 2：排行榜 tab
            var rankTabs = 0;
            for (var k = 0; k < allAnchors.length; k++) {
                var lt = (allAnchors[k].textContent || '').trim();
                if (D.RANK_RE.test(lt)) rankTabs++;
                if (rankTabs >= D.RANK_MIN) break;
            }

            // 指纹 3：视频卡片——img 所在容器内含日期（逐级上探 ≤5 级找卡片盒子）。
            // 不要求 img 必须在 <a> 内：WAP 模板 a>div.log>img（日期在外层 foot），
            // PC 模板 li>p.img>img 且 a 为空覆盖层与 img 平级——'a img' 会数出 0。
            var cards = 0;
            var imgs = Utils.qsa('img', doc);
            for (var m = 0; m < imgs.length; m++) {
                var node = imgs[m].parentNode;
                var depth = 0;
                while (node && node !== doc.body && depth < 5) {
                    if (node.querySelector && node.querySelector('img') &&
                        D.CARD_DATE_RE.test(node.textContent || '')) {
                        cards++;
                        break;
                    }
                    node = node.parentNode;
                    depth++;
                }
                if (cards >= D.CARDS_MIN) break;
            }

            return {
                title: doc.title || '',
                meta: meta,
                navLinks: navBest,
                rankTabs: rankTabs,
                cards: cards,
                path: (root.location && root.location.pathname) || ''
            };
        }
    };

    /* ======================================================================
     * L4 NETGUARD — NetGuard：弹窗拦截 + 注入拦截（document-start 安装，激活后生效）
     * ====================================================================== */
    var NetGuard = {
        _installed: false,
        active: false,
        blocked: 0,

        install: function () {
            if (this._installed || !root.document) return;
            this._installed = true;
            var self = this;

            // 通道 1：window.open 弹窗拦截
            if (typeof root.open === 'function') {
                var rawOpen = root.open.bind(root);
                root.open = function (url) {
                    if (self.active && url && CONFIG.AD.URL_RE.test(String(url))) {
                        self._count();
                        return null;
                    }
                    return rawOpen.apply(root, arguments);
                };
            }

            // 通道 2：createElement(script/iframe) 的 src 注入拦截
            var doc = root.document;
            var rawCreate = doc.createElement.bind(doc);
            doc.createElement = function (tag) {
                var el = rawCreate.apply(doc, arguments);
                try {
                    if (self.active && /^(script|iframe)$/i.test(String(tag))) {
                        self._armSrcGuard(el);
                    }
                } catch (e) { /* 守卫失败不阻塞创建 */ }
                return el;
            };
            Utils.log('NetGuard 已安装（待激活）');
        },

        _armSrcGuard: function (el) {
            var self = this;
            var rawSetAttr = el.setAttribute.bind(el);
            el.setAttribute = function (name, val) {
                if (/^src$/i.test(String(name)) && CONFIG.AD.URL_RE.test(String(val))) {
                    self._count();
                    return;
                }
                return rawSetAttr(name, val);
            };
            var proto = root.HTMLScriptElement && el.tagName === 'SCRIPT'
                ? root.HTMLScriptElement.prototype
                : (root.HTMLIFrameElement && el.tagName === 'IFRAME' ? root.HTMLIFrameElement.prototype : null);
            if (proto) {
                var desc = Object.getOwnPropertyDescriptor(proto, 'src');
                if (desc && desc.set) {
                    Object.defineProperty(el, 'src', {
                        configurable: true,
                        get: desc.get,
                        set: function (v) {
                            if (CONFIG.AD.URL_RE.test(String(v))) { self._count(); return; }
                            desc.set.call(el, v);
                        }
                    });
                }
            }
        },

        _count: function () {
            this.blocked++;
            Store.addStats({ blocked: 1 });
            Utils.log('已拦截广告资源/弹窗 #' + this.blocked);
        },

        setActive: function (v) { this.active = !!v; }
    };

    /* ======================================================================
     * L5 CLEAN — AdSweeper 广告清扫（纯判定 decideFloat 可测）+ LayoutEngine
     * ====================================================================== */

    /** 纯判定：悬浮/遮挡元素是否为广告（info 为几何+特征快照） */
    function decideFloat(i) {
        if (i.textLen > 200) return false;                 // 富文本 = 正经内容
        var cover = i.w >= i.vw * 0.9 && i.h >= i.vh * 0.9;
        if (i.pos === 'fixed' && cover && (i.hasLink || i.hasMedia)) return true;   // 全屏遮罩
        var band = i.w >= i.vw * 0.75 && i.h >= 40 && i.h <= i.vh * 0.4;
        if (i.pos === 'fixed' && band && i.inBlacklist) return true;                // 顶/底横幅
        var corner = i.pos === 'fixed' && i.inBlacklist &&
            i.w <= i.vw * 0.5 && i.h <= i.vh * 0.6 && (i.hasLink || i.hasMedia);
        if (corner) return true;                                                    // 角标悬浮
        if (i.pos === 'absolute' && i.inBlacklist && i.hasLink && i.hasMedia &&
            i.w <= i.vw * 0.4 && i.h <= i.vh * 0.4) return true;                    // 内嵌小块
        return false;
    }

    /** 纯判定：一组链接文本是否构成可折叠分类导航 */
    function shouldCollapseNav(texts) {
        if (!texts || texts.length < CONFIG.DETECT.NAV_MIN_LINKS) return false;
        var shortN = 0;
        for (var i = 0; i < texts.length; i++) {
            var t = (texts[i] || '').trim();
            if (t && t.length <= 6) shortN++;
        }
        return shortN >= CONFIG.DETECT.NAV_MIN_LINKS;
    }

    var AdSweeper = {
        mo: null,
        removed: 0,

        start: function () {
            if (this.mo || !root.document || !root.document.body) return;
            var self = this;
            this.sweep();
            var schedule = Utils.debounce(function () {
                self.sweep();
                // 界面重组跟随内容后到：清扫时顺带重跑（各步骤幂等，带 data-vir 标记）
                try { LayoutEngine.run(); } catch (e) { /* 重组失败不影响清扫 */ }
            }, 800);
            this.mo = new root.MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    if (muts[i].addedNodes && muts[i].addedNodes.length) { schedule(); return; }
                }
            });
            this.mo.observe(root.document.documentElement, { childList: true, subtree: true });
        },

        stop: function () {
            if (this.mo) { this.mo.disconnect(); this.mo = null; }
        },

        sweep: function () {
            var doc = root.document;
            if (!doc || !doc.body || !Store.isEnabled()) return;
            var vw = root.innerWidth || 0, vh = root.innerHeight || 0;
            if (!vw || !vh) return;
            var removed = 0, limit = CONFIG.AD.SWEEP_LIMIT;
            var pool = [];

            // A. 悬浮/遮挡清扫：body 顶层子元素 + 黑名单 class/id 元素
            Array.prototype.forEach.call(doc.body.children || [], function (el) { pool.push(el); });
            Utils.qsa('div,section,aside,a,ins', doc).forEach(function (el) {
                var cls = el.className && el.className.baseVal !== undefined
                    ? el.className.baseVal : (el.className || '');
                if (CONFIG.AD.NAME_RE.test(el.id || '') || CONFIG.AD.NAME_RE.test(String(cls))) {
                    pool.push(el);
                }
            });
            for (var i = 0; i < pool.length && removed < limit; i++) {
                var el = pool[i];
                if (!el || !el.parentNode || el.getAttribute('data-vir') === 'ui') continue;
                if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') continue;
                var info = this._profile(el, vw, vh);
                if (!info) continue;
                if (decideFloat(info)) {
                    el.parentNode.removeChild(el);
                    removed++;
                }
            }

            // B. 内嵌广告资源：script/iframe src 命中广告 URL
            Utils.qsa('script[src],iframe[src]', doc).forEach(function (el) {
                if (removed >= limit) return;
                if (CONFIG.AD.URL_RE.test(el.src || '')) {
                    el.parentNode && el.parentNode.removeChild(el);
                    removed++;
                }
            });

            // C. 强力模式：黑名单 a>img 内嵌推广卡
            if (Store.strength() === 'strong') {
                Utils.qsa('a[target="_blank"]', doc).forEach(function (el) {
                    if (removed >= limit) return;
                    var cls = String(el.className || '') + ' ' + (el.id || '');
                    if (!CONFIG.AD.NAME_RE.test(cls)) return;
                    if (!el.querySelector('img')) return;
                    el.parentNode && el.parentNode.removeChild(el);
                    removed++;
                });
            }

            // D. 广告位容器：服务端渲染的 data-slots 占位（模板广告系统的挂载点）
            Utils.qsa('div[data-slots]', doc).forEach(function (el) {
                if (removed >= limit) return;
                el.parentNode && el.parentNode.removeChild(el);
                removed++;
            });

            // E. 静态图片广告：跨站绝对外链 + 内容仅为图片（视频站内容卡均为站内相对链接）
            var curHost = Utils.host();
            Utils.qsa('a[href]', doc).forEach(function (el) {
                if (removed >= limit) return;
                if (el.getAttribute('data-vir-swept')) return;
                var href = el.getAttribute('href') || '';
                if (!/^https?:\/\//i.test(href)) return;        // 相对链接 = 站内内容
                if (!el.querySelector('img')) return;
                if ((el.textContent || '').trim().length > 8) return; // 图+文字的导航外链不碰
                if (el.querySelector('video')) return;          // 播放器保护
                var dest = '';
                try { dest = new root.URL(href).hostname; } catch (e) { return; }
                if (!curHost || dest === curHost) return;
                el.setAttribute('data-vir-swept', '1');
                try { el.style.display = 'none'; } catch (e2) { /* 忽略 */ }
                removed++;
            });

            if (removed > 0) {
                this.removed += removed;
                Store.addStats({ swept: removed });
                Utils.log('本轮清扫移除', removed, '个元素');
            }
        },

        _profile: function (el, vw, vh) {
            var rect;
            try { rect = el.getBoundingClientRect(); } catch (e) { return null; }
            if (!rect || rect.width < 8 || rect.height < 8) return null;
            if (el.querySelector && el.querySelector('video')) return null;   // 播放器保护
            var cls = el.className && el.className.baseVal !== undefined
                ? el.className.baseVal : (el.className || '');
            var pos = 'static';
            try { pos = (root.getComputedStyle(el).position || 'static'); } catch (e) { /* 忽略 */ }
            return {
                w: Math.round(rect.width), h: Math.round(rect.height),
                vw: vw, vh: vh,
                pos: pos,
                hasLink: !!(el.querySelector && el.querySelector('a[href]')),
                hasMedia: !!(el.querySelector && el.querySelector('img,iframe,object,embed')),
                textLen: (el.textContent || '').trim().length,
                inBlacklist: CONFIG.AD.NAME_RE.test(el.id || '') || CONFIG.AD.NAME_RE.test(String(cls))
            };
        }
    };

    var LayoutEngine = {
        _cssDone: false,

        run: function () {
            this.injectCss();
            this.collapseNav();
            this.stickSearch();
            this.tidyCards();
            this.hideClutter();
        },

        injectCss: function () {
            if (this._cssDone || !root.document) return;
            this._cssDone = true;
            var css = [
                /* 搜索栏 sticky */
                '.vir-sticky-search{position:sticky;top:0;z-index:9999;background:inherit;box-shadow:0 2px 8px rgba(0,0,0,.35);padding:8px 4px;}',
                /* 分类折叠 */
                '.vir-nav a.vir-folded{display:none!important;}',
                '.vir-nav-toggle{display:block;width:100%;text-align:center;padding:8px 0;color:#8ab4f8!important;cursor:pointer;font-size:14px;}',
                /* 卡片栅格规整 */
                '.vir-grid{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}',
                '.vir-grid>*{margin:0!important;}',
                '.vir-grid img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;display:block;}',
                '.vir-grid .vir-card-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:1.5;}',
                /* 杂物隐藏 */
                '.vir-clutter{display:none!important;}',
                /* 广告位占位容器（模板广告系统挂载点） */
                'div[data-slots]{display:none!important;}'
            ].join('\n');
            try {
                if (typeof root.GM_addStyle === 'function') root.GM_addStyle(css);
                else {
                    var s = root.document.createElement('style');
                    s.setAttribute('data-vir', 'ui');
                    s.textContent = css;
                    (root.document.head || root.document.documentElement).appendChild(s);
                }
            } catch (e) { /* 忽略 */ }
        },

        /** 分类导航折叠（保留前 NAV_KEEP 个，其余可展开；只处理最主要的一组）。
         *  采用与 SiteDetector 一致的「短文本叶子链接按 2 级祖先聚桶」，不依赖直链子元素 */
        collapseNav: function () {
            var doc = root.document;
            var D = CONFIG.DETECT;
            var allAnchors = Utils.qsa('a', doc);
            var best = null, bestList = null;
            for (var i = 0; i < allAnchors.length; i++) {
                var a = allAnchors[i];
                var t = (a.textContent || '').trim();
                if (!t || t.length > 6) continue;
                if (a.querySelector && a.querySelector('img')) continue;
                var anc = a;
                for (var lv = 0; lv < 2 && anc.parentNode; lv++) anc = anc.parentNode;
                if (!anc.__virNavList) anc.__virNavList = [];
                anc.__virNavList.push(a);
                if (!bestList || anc.__virNavList.length > bestList.length) {
                    bestList = anc.__virNavList;
                    best = anc;
                }
            }
            if (!best || !bestList || bestList.length < D.NAV_MIN_LINKS) return;
            if (best.getAttribute('data-vir-nav') === '1') return;
            best.setAttribute('data-vir-nav', '1');
            best.classList.add('vir-nav');

            var texts = [];
            for (var j = 0; j < bestList.length; j++) texts.push(bestList[j].textContent);
            if (!shouldCollapseNav(texts)) return;

            for (var k = D.NAV_KEEP; k < bestList.length; k++) {
                bestList[k].classList.add('vir-folded');
            }
            var toggle = doc.createElement('div');
            toggle.className = 'vir-nav-toggle';
            toggle.setAttribute('data-vir', 'ui');
            toggle.textContent = '展开全部分类 ▾';
            toggle.addEventListener('click', function () {
                var folded = best.querySelectorAll('a.vir-folded');
                if (folded.length) {
                    Array.prototype.forEach.call(folded, function (el) { el.classList.remove('vir-folded'); });
                    toggle.textContent = '收起全部分类 ▴';
                } else {
                    for (var n = D.NAV_KEEP; n < bestList.length; n++) bestList[n].classList.add('vir-folded');
                    toggle.textContent = '展开全部分类 ▾';
                }
            });
            best.appendChild(toggle);
            Utils.log('已折叠分类导航（' + bestList.length + ' 项）');
        },

        /** 搜索栏 sticky 置顶 */
        stickSearch: function () {
            var doc = root.document;
            var forms = Utils.qsa('form', doc);
            for (var i = 0; i < forms.length; i++) {
                var f = forms[i];
                if (f.getAttribute('data-vir-search') === '1') continue;
                var input = f.querySelector('input[type="text"],input[type="search"],input:not([type])');
                if (!input) continue;
                var top = 0, node = f;
                while (node && node !== doc.body) { top += node.offsetTop || 0; node = node.offsetParent; }
                if (top > CONFIG.LAYOUT.SEARCH_TOP) continue;
                f.setAttribute('data-vir-search', '1');
                f.classList.add('vir-sticky-search');
                Utils.log('搜索栏已置顶 sticky');
                return;
            }
        },

        /** 视频卡片栅格规整（取 img 卡片最多的容器；img 即算卡，不要求包在 a 内） */
        tidyCards: function () {
            var doc = root.document;
            var containers = Utils.qsa('ul,div,section', doc);
            var bestC = null, bestItems = null;
            for (var i = 0; i < containers.length; i++) {
                var c = containers[i];
                if (c.getAttribute('data-vir-grid') === '1') return;
                var items = c.querySelectorAll(':scope > li, :scope > div');
                if (!items || items.length < CONFIG.LAYOUT.CARD_MIN) continue;
                var cardN = 0;
                for (var j = 0; j < items.length; j++) {
                    if (items[j].querySelector('img')) cardN++;
                }
                if (cardN < CONFIG.LAYOUT.CARD_MIN) continue;
                if (!bestItems || items.length > bestItems.length) {
                    bestC = c;
                    bestItems = items;
                }
            }
            if (!bestC || !bestItems) return;

            bestC.setAttribute('data-vir-grid', '1');
            bestC.classList.add('vir-grid');
            for (var k = 0; k < bestItems.length; k++) {
                // 标题取第一个不含 img 的 p/h3/h4（PC 模板首个 p 是含图缩略容器）
                var ps = bestItems[k].querySelectorAll('p, h3, h4');
                var titleNode = null;
                for (var s = 0; s < ps.length; s++) {
                    if (!ps[s].querySelector('img')) { titleNode = ps[s]; break; }
                }
                if (!titleNode) {
                    var spans = bestItems[k].querySelectorAll('span');
                    for (var s2 = 0; s2 < spans.length; s2++) {
                        if (!spans[s2].querySelector('img')) { titleNode = spans[s2]; break; }
                    }
                }
                var a = bestItems[k].querySelector('a');
                if (titleNode) {
                    titleNode.classList.add('vir-card-title');
                } else if (a && !a.querySelector('img')) {
                    a.classList.add('vir-card-title');
                }
            }
            Utils.log('已规整卡片栅格（' + bestItems.length + ' 张卡片）');
        },

        /** 杂物清理：友情链接/公告/统计等 */
        hideClutter: function () {
            var doc = root.document;
            Utils.qsa('div,section,footer,p,ul', doc).forEach(function (el) {
                if (el.getAttribute('data-vir-clutter') === '1') return;
                var cls = String(el.className || '') + ' ' + (el.id || '');
                if (!CONFIG.AD.CLUTTER_RE.test(cls)) return;
                var textLen = (el.textContent || '').trim().length;
                if (textLen > 400) return; // 长文本容器不碰
                el.setAttribute('data-vir-clutter', '1');
                el.classList.add('vir-clutter');
            });
        }
    };

    /* ======================================================================
     * L6 VIEW — Toast（唯一 UI：菜单/清理动作的轻提示，2.2s 自动消失）
     * ====================================================================== */
    var Toast = {
        show: function (msg) {
            var doc = root.document;
            if (!doc || !doc.body) return;
            var t = doc.createElement('div');
            t.setAttribute('data-vir', 'ui');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:2147483000;background:rgba(30,30,32,.92);color:#eee;padding:8px 16px;border-radius:8px;font-size:13px;font-family:sans-serif;border:1px solid rgba(255,255,255,.2);';
            doc.body.appendChild(t);
            setTimeout(function () { t.parentNode && t.parentNode.removeChild(t); }, 2200);
        }
    };

    /* ======================================================================
     * L7 BOOTSTRAP — 装配 · Watcher · 油猴菜单
     * ====================================================================== */
    var Bootstrap = {
        _started: false,
        _active: false,
        _lastUrl: '',

        start: function () {
            if (this._started || !root.document || !root.document.documentElement) return;
            this._started = true;
            var self = this;
            NetGuard.install();

            // 识别到立刻净化：不做长防抖，事件直达
            var run = function () { self._tick(); };
            root.addEventListener('DOMContentLoaded', run);
            root.addEventListener('load', run);
            root.addEventListener('popstate', run);
            root.addEventListener('hashchange', run);
            // document-start 下 body 未就绪：100ms 轮询，body 一出现立刻判定
            var tries = 0;
            var bodyTimer = setInterval(function () {
                tries++;
                if (root.document && root.document.body) {
                    clearInterval(bodyTimer);
                    run();
                } else if (tries > 100) clearInterval(bodyTimer);
            }, 100);
            // URL 变化兜底（SPA 路由）
            setInterval(function () {
                var url = root.location ? root.location.href : '';
                if (url !== self._lastUrl) run();
            }, 2000);
        },

        _tick: function () {
            var host = Utils.host();
            if (!host) return;
            this._lastUrl = root.location.href;

            if (!Store.isEnabled() || Store.isExempt(host)) {
                this._stopRetry();
                this._deactivate();
                return;
            }

            var judge = SiteDetector.judge(host);
            if (judge.active) {
                this._stopRetry();
                this._activate();
            } else {
                // 内容后到的页面：负向不缓存，重试直到就绪（上限 40 次 ≈ 100 秒）
                this._deactivate();
                this._startRetry();
            }
        },

        _startRetry: function () {
            if (this._retryTimer) return;
            var self = this;
            var n = 0;
            this._retryTimer = setInterval(function () {
                n++;
                if (n > 40 || !Store.isEnabled()) { self._stopRetry(); return; }
                var host = Utils.host();
                if (!host || Store.isExempt(host)) { self._stopRetry(); return; }
                var judge = SiteDetector.judge(host);
                if (judge.active) {
                    self._stopRetry();
                    self._lastUrl = root.location.href;
                    self._activate();
                }
            }, 2500);
        },

        _stopRetry: function () {
            if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
        },

        _activate: function () {
            if (this._active) return;
            this._active = true;
            NetGuard.setActive(true);
            AdSweeper.start();
            LayoutEngine.run();
            Utils.log('已激活：清理 + 重组运行中');
        },

        _deactivate: function () {
            if (!this._active) return;
            this._active = false;
            NetGuard.setActive(false);
            AdSweeper.stop();
        },

        registerMenu: function () {
            if (typeof root.GM_registerMenuCommand !== 'function') return;
            var host = Utils.host();
            root.GM_registerMenuCommand('启用 / 暂停净化', function () {
                Store.setEnabled(!Store.isEnabled());
                Toast.show(Store.isEnabled() ? '已启用（刷新后完全生效）' : '已暂停');
            });
            root.GM_registerMenuCommand('切换清理强度（标准/强力）', function () {
                Store.setStrength(Store.strength() === 'strong' ? 'normal' : 'strong');
                Toast.show('强度：' + (Store.strength() === 'strong' ? '强力' : '标准'));
            });
            root.GM_registerMenuCommand('豁免 / 恢复本站', function () {
                var added = Store.toggleExempt(host);
                Toast.show(added ? '本站已加入豁免（刷新后生效）' : '已取消豁免（刷新后生效）');
            });
            root.GM_registerMenuCommand('重置累计统计', function () {
                Store.resetStats();
                Toast.show('统计已重置');
            });
        }
    };

    /* —— 浏览器环境：装配启动；Node 环境：仅导出 —— */
    if (root.document && typeof root.document.createElement === 'function') {
        try {
            Bootstrap.start();
            if (typeof root.GM_registerMenuCommand === 'function') {
                Bootstrap.registerMenu();
            }
        } catch (e) {
            Utils.log('启动异常', e && e.message);
        }
    }

    /* —— 导出内部 API（测试与控制台调试） —— */
    return {
        CONFIG: CONFIG,
        Utils: Utils,
        Store: Store,
        SiteDetector: SiteDetector,
        NetGuard: NetGuard,
        AdSweeper: AdSweeper,
        LayoutEngine: LayoutEngine,
        decideFloat: decideFloat,
        shouldCollapseNav: shouldCollapseNav,
        Bootstrap: Bootstrap,
        Toast: Toast
    };
});
