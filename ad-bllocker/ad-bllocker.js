// ==UserScript==
// @name         全站广告净化器 ad-bllocker
// @namespace    https://github.com/EFate
// @version      2.0.0
// @description  适配所有网站的广告过滤：弹窗/弹底、广告SDK与矿机注入、全屏遮罩/插屏、悬浮角标/地板条、模板广告位、跨站图片外链、赞助角标信息流、内嵌推广卡八通道全覆盖；配置面板 github-accelerate 风格，支持白名单与强力模式。
// @author       EFate
// @license      MIT
// @updateURL    https://gh-proxy.com/https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/ad-bllocker/ad-bllocker.js
// @downloadURL  https://gh-proxy.com/https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/ad-bllocker/ad-bllocker.js
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
 *  全站广告净化器 ad-bllocker · 架构总览（单文件，自顶向下分层，禁止跨层反向依赖）
 * ============================================================================
 *
 *   L1  CONFIG      规则库（唯一事实来源）：URL_RE · NAME_RE · SPONSOR_RE · 存储键 bl.*
 *   L2  FOUNDATION  Utils · Store（GM 持久化 + 内存兜底 · 白名单读写口）
 *   L3  NET         NetGuard 弹窗/弹底拦截 + script·iframe 注入守卫（document-start 常开）
 *   L4  SWEEP       AdSweeper 八通道清扫 + MutationObserver 防回弹
 *   L5  VIEW        Launcher(右中圆钮) · Panel(状态/设置/白名单三 Tab) · Toast —— github-accelerate 风格
 *   L6  BOOTSTRAP   装配启动 · Watcher（URL 变化重扫）· 油猴菜单
 *
 *   广告类型 → 通道映射（调研：IAB 格式体系 + Wikipedia Online advertising 分类）：
 *   ┌────────────────────────┬──────────────────────────────┐
 *   │ 弹窗 Popup / 弹底 Pop-under │ ① window.open 拦截           │
 *   │ 广告SDK / 贴片脚本 / 矿机   │ ② createElement·src 守卫     │
 *   │ 全屏遮罩 / 插屏 Interstitial│ ③ 几何启发式（面积≥90%）     │
 *   │ 悬浮角标 / 地板条 / 撕页    │ ③ fixed + 黑名单指纹         │
 *   │ AdSense 等广告 iframe      │ ④ script/iframe src URL_RE   │
 *   │ 模板广告位（data-slots）    │ ⑤ 占位容器移除 + CSS 兜底    │
 *   │ 静态横幅 / 外链图广告      │ ⑥ 跨站绝对外链 + 纯图片      │
 *   │ 信息流原生（赞助角标）      │ ⑦ SPONSOR_RE 角标清除       │
 *   │ 内嵌推广卡（强力模式）      │ ⑧ target=_blank + 黑名单     │
 *   └────────────────────────┴──────────────────────────────┘
 *
 *   安全护栏：富文本容器（文本>200字符）不碰 · <video> 播放器不碰 · static 定位
 *   不碰 · 脚本自身 UI 带 data-bl="ui" 标记不误杀 · 单轮清扫上限 24。
 *   白名单站点完全静默（零扫描、零拦截）。已知限制：墙纸皮肤壁纸、返回键劫持
 *   不处理；视频贴片由 ② 通道在注入层拦截。
 */

(function (root, factory) {
    var api = factory(root);
    // Node 环境导出内部 API 供冒烟测试；浏览器挂到 window.__BL__
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.__BL__ = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    /* ======================================================================
     * L1 CONFIG — 常量、存储键、广告规则（唯一事实来源）
     * ====================================================================== */
    var CONFIG = {
        VERSION: '2.0.0',
        KEYS: {
            ENABLED: 'bl.enabled',        // 全局开关（默认 true）
            STRONG: 'bl.strong',          // 强力模式（默认 false）
            LAUNCHER: 'bl.launcher',      // 显示悬浮球（默认 true）
            WHITELIST: 'bl.whitelist',    // 白名单域名列表（JSON 数组）
            STATS: 'bl.stats'             // 累计统计 { blocked, swept }
        },
        AD: {
            /* 广告资源 URL 指纹：弹窗 / 注入 / iframe / 统计 / 矿机 / 推送诱导 */
            URL_RE: new RegExp(
                'doubleclick\\.net|googlesyndication|googletagservices|googleadservices' +
                '|\\.tanx\\.com|cpro\\.baidu|pos\\.baidu|hm\\.baidu|cnzz\\.|umeng\\.' +
                '|miaozhen|allyes|admaster|adsame|adview|adcdn|mediav\\.com' +
                '|\\/ads?\\/[a-z0-9_-]+\\.(js|php)|\\/adjs|\\/gg\\/|\\/gg\\.(js|php)|guanggao' +
                '|\\/abc\\/[a-z0-9_]+\\.js|\\/000\\/' +
                '|popads\\.net|popcash|propellerads|propellerclick|adsterra|hilltopads' +
                '|exoclick|juicyads|adcash|adskeeper|clickaine|revenuehat' +
                '|onesignal|webpushr|pushnami|sendpulse|pushwoosh|onepush' +
                '|coinhive|coinimp|minero|cryptoloot|jsecoin|cryptonight|deepminer' +
                '|\\/uv\\.js|\\/tk\\.js|\\/kstk\\.js', 'i'),
            /* 悬浮/内嵌广告的 class·id 黑名单指纹 */
            NAME_RE: /(^|[-_0-9])(ad|ads|adv|advert|advertisement|gg|bnn|banner|float|floating|popup|popover|suspend|kefu|service|downapp|appdown|qrcode|follow|wx|weixin|tip|tips|notice|dialog|layer|mask|ticket|ico)([-_0-9]|$)/i,
            /* 信息流赞助角标：元素文本仅为这些 token 时按广告角标处理 */
            SPONSOR_RE: /^(广告|推广|赞助| AD |AD|Ad|ad|Sponsored|sponsored|Promoted|promotion)$/,
            SWEEP_LIMIT: 24               // 单轮清扫移除上限，防误伤失控
        },
        UI: {
            LAUNCHER: 'bl-launcher',
            PANEL: 'bl-panel',
            OVERLAY: 'bl-overlay'
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
        host: function () {
            try { return (root.location && root.location.hostname) || ''; }
            catch (e) { return ''; }
        },
        debounce: function (fn, ms) {
            var t = null;
            return function () {
                var args = arguments, self = this;
                clearTimeout(t);
                t = setTimeout(function () { fn.apply(self, args); }, ms);
            };
        },
        log: function () {
            if (root.console && root.console.log) {
                var args = Array.prototype.slice.call(arguments);
                args.unshift('[BL]');
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
            isStrong: function () { return get(CONFIG.KEYS.STRONG, false) === true; },
            setStrong: function (v) { set(CONFIG.KEYS.STRONG, !!v); },
            showLauncher: function () { return get(CONFIG.KEYS.LAUNCHER, true) !== false; },
            setShowLauncher: function (v) { set(CONFIG.KEYS.LAUNCHER, !!v); },
            getWhitelist: function () { return getJSON(CONFIG.KEYS.WHITELIST, []); },
            isWhitelisted: function (host) {
                return this.getWhitelist().indexOf(host) !== -1;
            },
            addWhitelist: function (host) {
                var list = this.getWhitelist();
                if (list.indexOf(host) !== -1) return false;
                list.push(host);
                set(CONFIG.KEYS.WHITELIST, list);
                return true;
            },
            removeWhitelist: function (host) {
                var list = this.getWhitelist();
                var i = list.indexOf(host);
                if (i === -1) return false;
                list.splice(i, 1);
                set(CONFIG.KEYS.WHITELIST, list);
                return true;
            },
            stats: function () { return getJSON(CONFIG.KEYS.STATS, { blocked: 0, swept: 0 }); },
            addStats: function (delta) {
                var s = getJSON(CONFIG.KEYS.STATS, { blocked: 0, swept: 0 });
                s.blocked += delta.blocked || 0;
                s.swept += delta.swept || 0;
                set(CONFIG.KEYS.STATS, s);
            },
            resetStats: function () { set(CONFIG.KEYS.STATS, { blocked: 0, swept: 0 }); },
            resetAll: function () {
                set(CONFIG.KEYS.ENABLED, true);
                set(CONFIG.KEYS.STRONG, false);
                set(CONFIG.KEYS.LAUNCHER, true);
                set(CONFIG.KEYS.WHITELIST, []);
                set(CONFIG.KEYS.STATS, { blocked: 0, swept: 0 });
            }
        };
    })();

    /* ======================================================================
     * L3 NET — NetGuard：弹窗/弹底拦截 + 注入守卫（document-start 常开）
     * ====================================================================== */
    var NetGuard = {
        _installed: false,
        active: false,
        blocked: 0,

        install: function () {
            if (this._installed || !root.document) return;
            this._installed = true;
            var self = this;

            // 通道 ①：window.open 弹窗 / 弹底拦截
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

            // 通道 ②：createElement(script/iframe) 的 src 注入守卫
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

        setActive: function (v) {
            this.active = !!v;
        },

        _armSrcGuard: function (el) {
            var self = this;
            // Node/特殊环境无 HTML 元素原型时安全返回
            if (typeof root.HTMLScriptElement !== 'function' ||
                typeof root.HTMLIFrameElement !== 'function') return;
            var desc = Object.getOwnPropertyDescriptor(
                root.HTMLScriptElement.prototype, 'src');
            var descFr = Object.getOwnPropertyDescriptor(
                root.HTMLIFrameElement.prototype, 'src');
            var d = String(el.tagName).toLowerCase() === 'iframe' ? descFr : desc;
            if (!d || !d.set) return;
            // 只为每个新元素挂一次性 setter（覆盖原型 setter 的实例属性）
            Object.defineProperty(el, 'src', {
                configurable: true,
                enumerable: d.enumerable,
                get: function () { return d.get.call(this); },
                set: function (v) {
                    if (self.active && v && CONFIG.AD.URL_RE.test(String(v))) {
                        self._count();
                        return; // 丢弃广告资源
                    }
                    d.set.call(this, v);
                }
            });
        },

        _count: function () {
            this.blocked++;
            Store.addStats({ blocked: 1 });
        }
    };

    /* ======================================================================
     * L4 SWEEP — AdSweeper：八通道 DOM 清扫 + 防回弹 Observer（纯函数可测）
     * ====================================================================== */

    /** IAB 标准广告尺寸（±8% 容差）：leaderboard/medium rectangle/skyscraper 等 */
    var IAB_SIZES = [
        [728, 90], [468, 60], [970, 90], [970, 250], [300, 250], [336, 280],
        [160, 600], [300, 600], [120, 600], [320, 50], [320, 100], [250, 250]
    ];
    function isIabSize(w, h) {
        for (var i = 0; i < IAB_SIZES.length; i++) {
            var s = IAB_SIZES[i];
            if (Math.abs(w - s[0]) <= s[0] * 0.08 && Math.abs(h - s[1]) <= s[1] * 0.08) return true;
        }
        return false;
    }

    /** 纯判定：悬浮/遮挡元素是否为广告（info 为几何+特征快照） */
    function decideFloat(info) {
        if (info.pos !== 'fixed') return false;            // 只动 fixed 定位
        if (info.textLen > 200) return false;              // 富文本不碰
        if (info.inBlacklist) return true;                 // 黑名单指纹命中
        var areaRatio = (info.w * info.h) / (info.vw * info.vh);
        if (areaRatio >= 0.9 && (info.hasLink || info.hasMedia)) return true; // 全屏遮罩/插屏
        if (info.w >= info.vw * 0.75 && info.h <= info.vh * 0.18 &&
            (info.hasLink || info.hasMedia)) return true;  // 顶/底横幅地板条
        // 横幅 banner：fixed + 链接/媒体 + IAB 标准广告尺寸（728×90 等）
        if ((info.hasLink || info.hasMedia) && isIabSize(info.w, info.h)) return true;
        return false;
    }

    var AdSweeper = {
        _started: false,
        _mo: null,
        removed: 0,

        start: function () {
            if (this._started || !root.document || !root.document.body) return;
            this._started = true;
            var self = this;
            this.sweep();
            var schedule = Utils.debounce(function () { self.sweep(); }, 800);
            this._mo = new root.MutationObserver(function () { schedule(); });
            this._mo.observe(root.document.documentElement, { childList: true, subtree: true });
        },

        stop: function () {
            if (this._mo) { this._mo.disconnect(); this._mo = null; }
            this._started = false;
        },

        sweep: function () {
            var doc = root.document;
            if (!doc || !doc.body || !Store.isEnabled()) return;
            if (Store.isWhitelisted(Utils.host())) return;
            var vw = root.innerWidth || 0, vh = root.innerHeight || 0;
            if (!vw || !vh) return;
            var removed = 0, limit = CONFIG.AD.SWEEP_LIMIT;
            var pool = [];

            // 通道 ③ 悬浮/遮挡清扫：body 顶层子元素 + 黑名单 class/id 元素
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
                if (!el || !el.parentNode || el.getAttribute('data-bl') === 'ui') continue;
                if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') continue;
                var info = this._profile(el, vw, vh);
                if (!info) continue;
                if (decideFloat(info)) {
                    el.parentNode.removeChild(el);
                    removed++;
                }
            }

            // 通道 ④ 广告资源：script/iframe src 命中 URL 指纹
            Utils.qsa('script[src],iframe[src]', doc).forEach(function (el) {
                if (removed >= limit) return;
                if (CONFIG.AD.URL_RE.test(el.src || '')) {
                    el.parentNode && el.parentNode.removeChild(el);
                    removed++;
                }
            });

            // 通道 ⑤ 模板广告位：服务端渲染的 data-slots 占位容器
            Utils.qsa('div[data-slots]', doc).forEach(function (el) {
                if (removed >= limit) return;
                el.parentNode && el.parentNode.removeChild(el);
                removed++;
            });

            // 通道 ⑥ 静态图片广告：跨站绝对外链 + 内容仅为图片
            //（视频站内容卡与站内导航均为相对/同站链接；强力模式与标准模式均启用）
            var curHost = Utils.host();
            Utils.qsa('a[href]', doc).forEach(function (el) {
                if (removed >= limit) return;
                if (el.getAttribute('data-bl-swept')) return;
                var href = el.getAttribute('href') || '';
                if (!/^https?:\/\//i.test(href)) return;          // 相对链接 = 站内内容
                if (!el.querySelector('img')) return;
                if ((el.textContent || '').trim().length > 8) return; // 图+文字外链不碰
                if (el.querySelector('video')) return;            // 播放器保护
                var dest = '';
                try { dest = new root.URL(href).hostname; } catch (e) { return; }
                if (!curHost || dest === curHost) return;
                el.setAttribute('data-bl-swept', '1');
                try { el.style.display = 'none'; } catch (e2) { /* 忽略 */ }
                removed++;
            });

            // 通道 ⑦ 信息流赞助角标：文本仅为赞助 token 的小元素（"广告"/"推广"/Sponsored）
            Utils.qsa('span,em,i,div,p', doc).forEach(function (el) {
                if (removed >= limit) return;
                var t = (el.textContent || '').trim();
                if (!t || !CONFIG.AD.SPONSOR_RE.test(t)) return;
                var target = el.closest ? (el.closest('a') || el) : el;
                if (target.getAttribute('data-bl') === 'ui') return;
                if (target.querySelector && target.querySelector('video')) return;
                if (target.parentNode) {
                    target.parentNode.removeChild(target);
                    removed++;
                }
            });

            // 通道 ⑧（强力模式）：黑名单 a>img 内嵌推广卡
            if (Store.isStrong()) {
                Utils.qsa('a[target="_blank"]', doc).forEach(function (el) {
                    if (removed >= limit) return;
                    var cls = String(el.className || '') + ' ' + (el.id || '');
                    if (!CONFIG.AD.NAME_RE.test(cls)) return;
                    if (!el.querySelector('img')) return;
                    el.parentNode && el.parentNode.removeChild(el);
                    removed++;
                });
            }

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

    /* ======================================================================
     * L5 VIEW — Launcher · Panel · Toast（github-accelerate 视觉风格）
     * ====================================================================== */
    var CSS = [
        '.bl-scope{',
        '  --bl-bg:#0d1117; --bl-bg-2:#161b22; --bl-bg-3:#21262d;',
        '  --bl-bd:#30363d; --bl-bd-2:#21262d;',
        '  --bl-fg:#e6edf3; --bl-fg-2:#8b949e; --bl-fg-3:#6e7681;',
        '  --bl-accent:#2da44e; --bl-accent-2:#1a7f37; --bl-accent-fg:#ffffff;',
        '  --bl-good:#3fb950; --bl-bad:#f85149;',
        '  --bl-shadow:0 16px 44px rgba(0,0,0,.5);',
        '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
        '  color:var(--bl-fg); font-size:13px; line-height:1.5;',
        '}',
        '.bl-scope svg{width:1em;height:1em;fill:currentColor;flex:none;vertical-align:-.125em;}',
        /* 启动器：右侧中部圆形按钮 */
        '#bl-launcher{position:fixed;right:0;top:50%;transform:translateY(-50%);margin-right:10px;',
        '  z-index:2147483000;width:44px;height:44px;padding:0;display:flex;align-items:center;justify-content:center;',
        '  border:none;border-radius:50%;background:var(--bl-accent);color:#fff;cursor:pointer;',
        '  box-shadow:0 6px 20px rgba(0,0,0,.32);transition:background .18s,box-shadow .18s,transform .18s;}',
        '#bl-launcher:hover{background:var(--bl-accent-2);box-shadow:0 8px 26px rgba(0,0,0,.4);transform:translateY(-50%) scale(1.06);}',
        '#bl-launcher svg{width:24px;height:24px;}',
        /* 遮罩 */
        '#bl-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.5);',
        '  opacity:0;pointer-events:none;transition:opacity .2s;}',
        '#bl-overlay.bl-open{opacity:1;pointer-events:auto;}',
        /* 面板：居中，三 Tab */
        '#bl-panel{position:fixed;left:50%;top:50%;z-index:2147483002;width:460px;',
        '  max-width:calc(100vw - 32px);max-height:84vh;background:var(--bl-bg);border:1px solid var(--bl-bd);',
        '  border-radius:14px;box-shadow:var(--bl-shadow);display:flex;flex-direction:column;overflow:hidden;',
        '  opacity:0;transform:translate(-50%,-46%) scale(.97);pointer-events:none;',
        '  transition:opacity .22s,transform .22s cubic-bezier(.4,0,.2,1);}',
        '#bl-panel.bl-open{opacity:1;transform:translate(-50%,-50%) scale(1);pointer-events:auto;}',
        '.bl-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--bl-bd-2);flex:none;}',
        '.bl-head .bl-mark{width:24px;height:24px;color:var(--bl-accent);}',
        '.bl-head .bl-mark svg{width:24px;height:24px;}',
        '.bl-head h2{margin:0;font-size:15px;font-weight:600;color:var(--bl-fg);}',
        '.bl-head .bl-ver{font-size:11px;color:var(--bl-fg-2);border:1px solid var(--bl-bd);border-radius:999px;padding:1px 7px;}',
        '.bl-head .bl-spacer{flex:1;}',
        '.bl-icon-btn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;',
        '  border:none;border-radius:6px;background:transparent;color:var(--bl-fg-2);cursor:pointer;',
        '  font-size:16px;transition:background .15s,color .15s;}',
        '.bl-icon-btn:hover{background:var(--bl-bg-3);color:var(--bl-fg);}',
        '.bl-tabs{display:flex;border-bottom:1px solid var(--bl-bd-2);flex:none;background:var(--bl-bg-2);}',
        '.bl-tab{flex:1;padding:10px 0;border:none;background:transparent;cursor:pointer;',
        '  font-family:inherit;font-size:13px;color:var(--bl-fg-2);border-bottom:2px solid transparent;',
        '  transition:color .15s,background .15s;}',
        '.bl-tab:hover{color:var(--bl-fg);background:var(--bl-bg-3);}',
        '.bl-tab.bl-on{color:var(--bl-fg);font-weight:600;border-bottom-color:var(--bl-accent);}',
        '.bl-body{flex:1;overflow-y:auto;min-height:200px;}',
        '.bl-body::-webkit-scrollbar{width:8px;}',
        '.bl-body::-webkit-scrollbar-thumb{background:var(--bl-bd);border-radius:4px;}',
        '.bl-page{display:none;}',
        '.bl-page.bl-on{display:block;}',
        '.bl-sec{padding:12px 16px 4px;font-size:11px;color:var(--bl-fg-3);letter-spacing:.4px;}',
        '.bl-row{display:flex;align-items:center;gap:10px;padding:9px 16px;transition:background .12s;}',
        '.bl-row:hover{background:var(--bl-bg-2);}',
        '.bl-row .bl-grow{flex:1;min-width:0;}',
        '.bl-name{font-size:13px;color:var(--bl-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.bl-meta{margin-top:2px;font-size:11px;color:var(--bl-fg-2);}',
        '.bl-cb{position:relative;width:16px;height:16px;flex:none;cursor:pointer;}',
        '.bl-cb input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1;}',
        '.bl-cb span{display:block;width:16px;height:16px;border:1.5px solid var(--bl-bd);border-radius:4px;',
        '  background:var(--bl-bg);transition:background .15s,border-color .15s;}',
        '.bl-cb input:checked + span{background:var(--bl-accent);border-color:var(--bl-accent);}',
        '.bl-cb input:checked + span::after{content:\'\';display:block;width:4px;height:8px;margin:1px 0 0 4.5px;',
        '  border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);}',
        '.bl-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border:1px solid var(--bl-bd);',
        '  border-radius:6px;background:var(--bl-bg-3);color:var(--bl-fg);font-family:inherit;font-size:12px;',
        '  cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s;}',
        '.bl-btn:hover{background:var(--bl-bd);border-color:var(--bl-fg-3);}',
        '.bl-btn.bl-primary{background:var(--bl-accent);border-color:var(--bl-accent);color:var(--bl-accent-fg);}',
        '.bl-btn.bl-primary:hover{background:var(--bl-accent-2);}',
        '.bl-btn.bl-danger:hover{background:var(--bl-bad);border-color:var(--bl-bad);color:#fff;}',
        '.bl-dot{width:8px;height:8px;border-radius:50%;background:var(--bl-fg-3);flex:none;}',
        '.bl-dot.bl-good{background:var(--bl-good);}',
        '.bl-dot.bl-bad{background:var(--bl-bad);}',
        '.bl-statbox{display:flex;gap:10px;padding:12px 16px;}',
        '.bl-statcard{flex:1;background:var(--bl-bg-2);border:1px solid var(--bl-bd);border-radius:10px;padding:12px 14px;}',
        '.bl-statcard b{display:block;font-size:20px;font-weight:600;color:var(--bl-fg);}',
        '.bl-statcard span{font-size:11px;color:var(--bl-fg-2);}',
        '.bl-empty{padding:24px 16px;text-align:center;color:var(--bl-fg-3);font-size:12px;}',
        '.bl-foot{display:flex;align-items:center;justify-content:space-between;padding:9px 16px;',
        '  border-top:1px solid var(--bl-bd-2);font-size:11px;color:var(--bl-fg-3);flex:none;}',
        /* Toast */
        '#bl-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483003;',
        '  background:var(--bl-bg-3);border:1px solid var(--bl-bd);color:var(--bl-fg);padding:8px 16px;',
        '  border-radius:8px;font-size:13px;font-family:inherit;box-shadow:0 8px 24px rgba(0,0,0,.4);',
        '  opacity:0;transition:opacity .2s;pointer-events:none;}',
        '#bl-toast.bl-show{opacity:1;}'
    ].join('\n');

    var Icons = {
        shield: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0l6.5 2.5v4.7c0 4.2-2.8 7.3-6.5 8.8C4.3 14.5 1.5 11.4 1.5 7.2V2.5L8 0zm-1 9.6l4.6-4.6-1.1-1.1L7 7.4 5.5 5.9 4.4 7 7 9.6z"/></svg>',
        close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.7 2.6L8 6.9l4.3-4.3 1.1 1.1L9.1 8l4.3 4.3-1.1 1.1L8 9.1l-4.3 4.3-1.1-1.1L6.9 8 2.6 3.7l1.1-1.1z"/></svg>'
    };

    var Toast = {
        show: function (msg) {
            var doc = root.document;
            if (!doc || !doc.body) return;
            var old = doc.getElementById('bl-toast');
            if (old && old.parentNode) old.parentNode.removeChild(old);
            var t = doc.createElement('div');
            t.id = 'bl-toast';
            t.setAttribute('data-bl', 'ui');
            t.className = 'bl-scope';
            t.textContent = msg;
            doc.body.appendChild(t);
            setTimeout(function () { t.classList.add('bl-show'); }, 10);
            setTimeout(function () {
                t.classList.remove('bl-show');
                setTimeout(function () { t.parentNode && t.parentNode.removeChild(t); }, 250);
            }, 2000);
        }
    };

    var View = {
        _open: false,
        _tab: 'status',
        _mounted: false,

        mount: function () {
            var doc = root.document;
            if (this._mounted || !doc || !doc.body) return;
            this._mounted = true;

            if (typeof root.GM_addStyle === 'function') {
                root.GM_addStyle(CSS);
            } else {
                var st = doc.createElement('style');
                st.setAttribute('data-bl', 'ui');
                st.textContent = CSS;
                (doc.head || doc.documentElement).appendChild(st);
            }

            var self = this;
            if (Store.showLauncher()) {
                var btn = doc.createElement('button');
                btn.id = CONFIG.UI.LAUNCHER;
                btn.setAttribute('data-bl', 'ui');
                btn.className = 'bl-scope';
                btn.title = '广告净化器 · 打开面板';
                btn.innerHTML = Icons.shield;
                btn.addEventListener('click', function () { self.toggle(); });
                doc.body.appendChild(btn);
            }

            var overlay = doc.createElement('div');
            overlay.id = CONFIG.UI.OVERLAY;
            overlay.setAttribute('data-bl', 'ui');
            overlay.addEventListener('click', function () { self.toggle(); });
            doc.body.appendChild(overlay);

            var panel = doc.createElement('div');
            panel.id = CONFIG.UI.PANEL;
            panel.setAttribute('data-bl', 'ui');
            panel.className = 'bl-scope';
            doc.body.appendChild(panel);
            this._renderPanel(panel);
        },

        setLauncherVisible: function (visible) {
            var doc = root.document;
            if (!doc) return;
            var btn = doc.getElementById(CONFIG.UI.LAUNCHER);
            if (visible && !btn && this._mounted) {
                // 重建（设置项切换后）
                this._mounted = false;
                this.mount();
            } else if (!visible && btn && btn.parentNode) {
                btn.parentNode.removeChild(btn);
            }
        },

        toggle: function (force) {
            var doc = root.document;
            var panel = doc.getElementById(CONFIG.UI.PANEL);
            var overlay = doc.getElementById(CONFIG.UI.OVERLAY);
            if (!panel || !overlay) return;
            this._open = force !== undefined ? force : !this._open;
            panel.classList.toggle('bl-open', this._open);
            overlay.classList.toggle('bl-open', this._open);
            if (this._open) this._renderPanel(panel);
        },

        _renderPanel: function (panel) {
            var self = this;
            var host = Utils.host();
            var stats = Store.stats();
            var active = Store.isEnabled() && !Store.isWhitelisted(host);
            var stateText = !Store.isEnabled() ? '已暂停' :
                (Store.isWhitelisted(host) ? '本站白名单中' : '净化运行中');
            var stateDot = active ? 'bl-good' : 'bl-bad';

            var wl = Store.getWhitelist();
            var wlRows = wl.length ? wl.map(function (h) {
                return '<div class="bl-row">' +
                    '<div class="bl-grow"><div class="bl-name">' + h + '</div></div>' +
                    '<button class="bl-btn bl-danger" data-act="wl-del" data-host="' + h + '">移除</button>' +
                    '</div>';
            }).join('') : '<div class="bl-empty">白名单为空，所有站点均在净化范围</div>';

            var channels = [
                ['① 弹窗 / 弹底拦截', true],
                ['② 广告SDK · 贴片 · 矿机注入', true],
                ['③ 悬浮角标 · 全屏遮罩 · 地板条', true],
                ['④ 广告 iframe / script 资源', true],
                ['⑤ 模板广告位容器', true],
                ['⑥ 跨站图片外链横幅', true],
                ['⑦ 赞助角标信息流', true],
                ['⑧ 内嵌推广卡（强力模式）', Store.isStrong()]
            ].map(function (c) {
                return '<div class="bl-row">' +
                    '<span class="bl-dot ' + (c[1] ? 'bl-good' : '') + '"></span>' +
                    '<div class="bl-grow"><div class="bl-name">' + c[0] + '</div></div>' +
                    '</div>';
            }).join('');

            panel.innerHTML =
                '<div class="bl-head">' +
                '  <span class="bl-mark">' + Icons.shield + '</span>' +
                '  <h2>广告净化器</h2><span class="bl-ver">v' + CONFIG.VERSION + '</span>' +
                '  <span class="bl-spacer"></span>' +
                '  <button class="bl-icon-btn" data-act="close" title="关闭">' + Icons.close + '</button>' +
                '</div>' +
                '<div class="bl-tabs">' +
                '  <button class="bl-tab' + (this._tab === 'status' ? ' bl-on' : '') + '" data-tab="status">状态</button>' +
                '  <button class="bl-tab' + (this._tab === 'settings' ? ' bl-on' : '') + '" data-tab="settings">设置</button>' +
                '  <button class="bl-tab' + (this._tab === 'wl' ? ' bl-on' : '') + '" data-tab="wl">白名单</button>' +
                '</div>' +
                '<div class="bl-body">' +
                '  <div class="bl-page' + (this._tab === 'status' ? ' bl-on' : '') + '" data-page="status">' +
                '    <div class="bl-row"><span class="bl-dot ' + stateDot + '"></span>' +
                '      <div class="bl-grow"><div class="bl-name">' + stateText + '</div>' +
                '      <div class="bl-meta">' + (host || '当前站点') + '</div></div></div>' +
                '    <div class="bl-statbox">' +
                '      <div class="bl-statcard"><b>' + stats.blocked + '</b><span>累计拦截（弹窗/注入）</span></div>' +
                '      <div class="bl-statcard"><b>' + stats.swept + '</b><span>累计清扫（页面元素）</span></div>' +
                '    </div>' +
                '    <div class="bl-sec">过滤通道</div>' + channels +
                '  </div>' +
                '  <div class="bl-page' + (this._tab === 'settings' ? ' bl-on' : '') + '" data-page="settings">' +
                '    <div class="bl-row"><label class="bl-cb"><input type="checkbox" data-set="enabled"' +
                (Store.isEnabled() ? ' checked' : '') + '><span></span></label>' +
                '      <div class="bl-grow"><div class="bl-name">全局启用</div>' +
                '      <div class="bl-meta">关闭后所有站点停止净化</div></div></div>' +
                '    <div class="bl-row"><label class="bl-cb"><input type="checkbox" data-set="strong"' +
                (Store.isStrong() ? ' checked' : '') + '><span></span></label>' +
                '      <div class="bl-grow"><div class="bl-name">强力模式</div>' +
                '      <div class="bl-meta">追加内嵌推广卡清扫（通道⑧），误伤时关闭</div></div></div>' +
                '    <div class="bl-row"><label class="bl-cb"><input type="checkbox" data-set="launcher"' +
                (Store.showLauncher() ? ' checked' : '') + '><span></span></label>' +
                '      <div class="bl-grow"><div class="bl-name">显示悬浮球</div>' +
                '      <div class="bl-meta">隐藏后仍可从油猴菜单打开面板</div></div></div>' +
                '    <div class="bl-row"><span> </span><div class="bl-grow">' +
                '      <button class="bl-btn bl-primary" data-act="resweep">立即重扫</button>' +
                '      <button class="bl-btn bl-danger" data-act="reset">恢复默认设置</button>' +
                '    </div></div>' +
                '  </div>' +
                '  <div class="bl-page' + (this._tab === 'wl' ? ' bl-on' : '') + '" data-page="wl">' +
                '    <div class="bl-row"><div class="bl-grow"><div class="bl-name">' + (host || '当前站点') + '</div>' +
                '      <div class="bl-meta">' + (Store.isWhitelisted(host) ? '已在白名单，净化对本站停用' : '将本站加入白名单后停止净化') + '</div></div>' +
                (host ? '<button class="bl-btn" data-act="wl-toggle">' + (Store.isWhitelisted(host) ? '移出白名单' : '加入白名单') + '</button>' : '') +
                '    </div>' +
                '    <div class="bl-sec">已豁免站点（' + wl.length + '）</div>' + wlRows +
                '  </div>' +
                '</div>' +
                '<div class="bl-foot"><span>全站广告净化 · 八通道</span><span id="bl-foot-count"></span></div>';

            panel.addEventListener('click', function (ev) {
                var el = ev.target;
                var tab = el.getAttribute && el.getAttribute('data-tab');
                if (tab) {
                    self._tab = tab;
                    self._renderPanel(panel);
                    return;
                }
                var act = el.getAttribute && el.getAttribute('data-act');
                if (!act) return;
                if (act === 'close') { self.toggle(false); return; }
                if (act === 'resweep') {
                    AdSweeper.sweep();
                    Toast.show('已重新扫描');
                } else if (act === 'reset') {
                    Store.resetAll();
                    Bootstrap._tick();
                    Toast.show('已恢复默认设置');
                } else if (act === 'wl-toggle') {
                    if (Store.isWhitelisted(host)) {
                        Store.removeWhitelist(host);
                        Toast.show('已移出白名单，刷新后恢复净化');
                    } else {
                        Store.addWhitelist(host);
                        Toast.show('已加入白名单，本站停止净化');
                    }
                    Bootstrap._tick();
                } else if (act === 'wl-del') {
                    var h = el.getAttribute('data-host');
                    Store.removeWhitelist(h);
                    Toast.show('已移除 ' + h);
                    Bootstrap._tick();
                }
                self._renderPanel(panel);
            });
            panel.addEventListener('change', function (ev) {
                var key = ev.target.getAttribute && ev.target.getAttribute('data-set');
                if (!key) return;
                var v = ev.target.checked;
                if (key === 'enabled') Store.setEnabled(v);
                else if (key === 'strong') Store.setStrong(v);
                else if (key === 'launcher') { Store.setShowLauncher(v); View.setLauncherVisible(v); }
                Bootstrap._tick();
                Toast.show(v ? '已开启' : '已关闭');
                self._renderPanel(panel);
            });
        }
    };

    /* ======================================================================
     * L6 BOOTSTRAP — 装配 · Watcher · 油猴菜单
     * ====================================================================== */
    var Bootstrap = {
        _started: false,
        _lastUrl: '',

        start: function () {
            if (this._started || !root.document || !root.document.documentElement) return;
            this._started = true;
            var self = this;
            NetGuard.install();

            var run = function () { self._tick(); };
            root.addEventListener('DOMContentLoaded', run);
            root.addEventListener('load', run);
            root.addEventListener('popstate', run);
            root.addEventListener('hashchange', run);
            // document-start 下 body 未就绪：100ms 轮询，body 一出现立刻挂载
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

            var active = Store.isEnabled() && !Store.isWhitelisted(host);
            NetGuard.setActive(active);
            if (active) {
                AdSweeper.start();
            } else {
                AdSweeper.stop();
            }
        },

        registerMenu: function () {
            if (typeof root.GM_registerMenuCommand !== 'function') return;
            var host = Utils.host();
            root.GM_registerMenuCommand('打开设置面板', function () {
                View.mount();
                View.toggle(true);
            });
            root.GM_registerMenuCommand('本站白名单 开 / 关', function () {
                if (Store.isWhitelisted(host)) {
                    Store.removeWhitelist(host);
                    Toast.show('已移出白名单，刷新后恢复净化');
                } else {
                    Store.addWhitelist(host);
                    Toast.show('已加入白名单，本站停止净化');
                }
                Bootstrap._tick();
            });
            root.GM_registerMenuCommand('切换强力模式', function () {
                Store.setStrong(!Store.isStrong());
                Toast.show('强力模式：' + (Store.isStrong() ? '开' : '关'));
                Bootstrap._tick();
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
        NetGuard: NetGuard,
        AdSweeper: AdSweeper,
        decideFloat: decideFloat,
        Bootstrap: Bootstrap,
        Toast: Toast
    };
});
