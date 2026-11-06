// ==UserScript==
// @name         Copilot 增强助手
// @namespace    js-hub/copilot-enhance
// @version      1.2.4
// @description  为 Microsoft Copilot 增加地区解锁与附件上传网络增强——3 个开关、2 组分类，菜单打开设置面板，零依赖
// @author       EFate
// @license      MIT
// @match        https://m365.cloud.microsoft/*
// @match        https://copilot.cloud.microsoft/*
// @match        https://copilot.microsoft.com/*
// @match        https://copilot.com/*
// @match        https://www.bing.com/chat*
// @match        https://bing.com/chat*
// @match        https://outlook.office.com/*
// @match        https://microsoft365.microsoftonline.cn/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/copilot-enhance/copilot-enhance.user.js
// @downloadURL  https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/copilot-enhance/copilot-enhance.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ======================================================================
    // L1 配置层 · 版本、存储前缀、功能开关目录、选项定义表（一切开关的唯一来源）
    // ======================================================================

    var VERSION = '1.2.4';
    var PREFIX = 'cp';               // 存储键前缀：cp.<开关名>
    var MARK_ATTR = 'data-cp-retry';
    var GROUPS = ['地区', '上传'];

    // 设置面板的唯一数据源：只保留 2026-11-06 在 copilot.com 实测可用的能力。
    var OPT_DEFS = {
        // —— 地区 ——
        regionUnlock:       { group: '地区', type: 'bool', label: '地区解锁（美国）', tip: '把页面配置中的地区、资格与地区可用标记改写为美国可用状态；服务端按 IP 拒绝时仍需配合可用网络区域', def: true },
        // —— 上传 ——
        uploadRetry:        { group: '上传', type: 'bool', label: '附件上传自动重试', tip: '上传接口断连 / 429 / 5xx 时自动退避重试，最多 3 次', def: true },
        uploadFailureWatch: { group: '上传', type: 'bool', label: '上传失败自动再试', tip: '页面出现「上传失败」提示时自动点其中的重试按钮，同一提示只点一次', def: true }
    };

    // ======================================================================
    // L2 数据结构层 · OPT 单一数据源（loadOpts 唯一入口，saveOpt 唯一出口，readOpt 唯一归一）
    // ======================================================================

    var OPT = {};
    var STATE = {
        uploads: { retried: 0, failed: 0, healing: 0 },
        regionPatches: 0
    };

    // 单值归一（唯一合法判据）：布尔项非布尔回落默认值，文本项非字符串回落默认值。
    function readOpt(name, v) {
        var d = OPT_DEFS[name];
        if (!d) return undefined;
        if (d.type === 'text') {
            if (typeof v !== 'string') return d.def;
            return v.replace(/\s+/g, ' ').trim();   // 文本项允许空串＝自动
        }
        return (typeof v === 'boolean') ? v : d.def;
    }

    function loadOpts() {
        for (var name in OPT_DEFS) {
            OPT[name] = readOpt(name, GM_getValue(PREFIX + '.' + name));
        }
        return OPT;
    }

    // 管理器存储异常时用默认值补齐，保证模型逻辑仍然能启动
    function ensureOpts() {
        for (var name in OPT_DEFS) {
            if (!(name in OPT)) OPT[name] = readOpt(name, undefined);
        }
        return OPT;
    }

    function saveOpt(name, value) {
        if (!(name in OPT_DEFS)) return undefined;
        var v = readOpt(name, value);     // 写前归一：坏值不落盘
        OPT[name] = v;
        GM_setValue(PREFIX + '.' + name, v);
        return v;
    }

    // ======================================================================
    // L3 识别 / 解析层 · 文本归一、宿主判定、模型档位与存储值识别
    // ======================================================================

    var norm = function (s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };

    // ======================================================================
    // L4 核心逻辑层 · 上传判定与重试策略（纯函数，UMD 导出）
    // ======================================================================

    // 地区解锁：只改资格/地区相关字段，不动账号、语言、主题等无关数据。
    var REGION_TRUE_KEYS = {
        isCopilotEnabledRegion: 1, isCodexEnabledRegion: 1, isCopilotEligible: 1,
        isUserConsumerCopilotEligible: 1, isOpalEligible: 1, HasCopilotAI: 1,
        HasCopilotBusinessChat: 1, userCopilotUserSetting: 1, IsLicensed: 1
    };
    var REGION_FALSE_KEYS = {
        isEURegion: 1, isOptedOutByAdmin: 1, isCopilotExtensibilityDisabled: 1,
        isCoworkCreditPacksRestrictedRegion: 1
    };
    var COUNTRY_KEYS = {
        userCountryCode: 1, countryCode: 1, clientCountryCode: 1, geoCountryCode: 1,
        signInCountryCode: 1, ipCountryCode: 1
    };

    // 把一个 JSON 对象里的地区相关字段改成美国可用状态；返回改动数。
    function patchRegionData(data) {
        var n = 0, seen = 0;
        var visited = (typeof WeakSet === 'function') ? new WeakSet() : null;
        function walk(obj, depth) {
            if (!obj || typeof obj !== 'object' || depth > 12 || seen++ > 12000) return;
            if (visited) { if (visited.has(obj)) return; visited.add(obj); }
            if (Array.isArray(obj)) {
                for (var i = 0; i < obj.length; i++) walk(obj[i], depth + 1);
                return;
            }
            for (var k in obj) {
                if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                var v = obj[k];
                if (REGION_TRUE_KEYS[k] && v !== true) { obj[k] = true; n++; continue; }
                if (REGION_FALSE_KEYS[k] && v !== false) { obj[k] = false; n++; continue; }
                if (COUNTRY_KEYS[k] && typeof v === 'string' && /^[a-z]{2}$/i.test(v) && v.toUpperCase() !== 'US') {
                    obj[k] = 'US'; n++; continue;
                }
                if ((k === 'm365CopilotAcquisitionState' || k === 'acquisitionState') && v !== 'acquired') {
                    obj[k] = 'acquired'; n++; continue;
                }
                if (k === 'cohort' && (!v || v === 'None')) { obj[k] = 'bcais'; n++; continue; }
                if (v && typeof v === 'object') walk(v, depth + 1);
            }
        }
        walk(data, 0);
        return n;
    }

    function patchRegionJsonText(text) {
        if (typeof text !== 'string' || text.indexOf('{') < 0) return 0;
        if (!/Region|Country|eligib|License/i.test(text)) return 0;
        try {
            var data = JSON.parse(text);
            return patchRegionData(data);
        } catch (e) { return 0; }
    }

    function patchRegionDom() {
        var n = 0;
        ['identity', 'userEntitlements', 'm365ChatFeatureSettings'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || !el.textContent) return;
            var old = el.textContent;
            var k = patchRegionJsonText(old);
            if (k > 0) {
                try {
                    var d = JSON.parse(old);
                    patchRegionData(d);
                    el.textContent = JSON.stringify(d);
                    n += k;
                } catch (e) { /* 非法 JSON 保持原样 */ }
            }
        });
        var scripts = document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]');
        for (var i = 0; i < scripts.length; i++) {
            var txt = scripts[i].textContent || '';
            var k2 = patchRegionJsonText(txt);
            if (k2 > 0) {
                try {
                    var d2 = JSON.parse(txt);
                    patchRegionData(d2);
                    scripts[i].textContent = JSON.stringify(d2);
                    n += k2;
                } catch (e) { }
            }
        }
        return n;
    }

    function patchRegionStorage() {
        var n = 0;
        var stores = [];
        try { if (window.localStorage) stores.push(window.localStorage); } catch (e) { }
        try { if (window.sessionStorage) stores.push(window.sessionStorage); } catch (e) { }
        stores.forEach(function (st) {
            var len = 0;
            try { len = st.length; } catch (e) { return; }
            for (var i = 0; i < len && i < 300; i++) {
                var key = st.key(i);
                if (!key) continue;
                var raw;
                try { raw = st.getItem(key); } catch (e) { continue; }
                if (!raw || raw.length > 200000) continue;
                var k2 = patchRegionJsonText(raw);
                if (k2 > 0) {
                    try {
                        var d = JSON.parse(raw);
                        patchRegionData(d);
                        st.setItem(key, JSON.stringify(d));
                        n += k2;
                    } catch (e) { }
                } else if (/country|region/i.test(key) && /^[a-z]{2}$/i.test(raw) && raw.toUpperCase() !== 'US') {
                    try { st.setItem(key, 'US'); n++; } catch (e) { }
                }
            }
        });
        return n;
    }

    function patchRegionRuntime() {
        var w = pageWin(), n = 0;
        ['__staticRouterHydrationData', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__COPILOT_STATE__'].forEach(function (k) {
            try { if (w && w[k]) n += patchRegionData(w[k]); } catch (e) { }
        });
        return n;
    }

    function applyRegionUnlock() {
        if (!OPT.regionUnlock) return 0;
        var n = 0;
        try { n += patchRegionDom(); } catch (e) { }
        try { n += patchRegionStorage(); } catch (e) { }
        try { n += patchRegionRuntime(); } catch (e) { }
        STATE.regionPatches += n;
        return n;
    }

    // 在页面读取 JSON 之前挂钩，覆盖水合数据与后续接口响应。
    function installRegionUnlock() {
        var w = pageWin();
        if (!w || !w.JSON || w.JSON.__cpRegionHooked) return applyRegionUnlock();
        try {
            var origParse = w.JSON.parse;
            w.JSON.parse = function (text, reviver) {
                var data = origParse.call(this, text, reviver);
                try {
                    if (OPT.regionUnlock) {
                        var k = patchRegionData(data);
                        STATE.regionPatches += k;
                    }
                } catch (e) { }
                return data;
            };
            w.JSON.__cpRegionHooked = true;
        } catch (e) { return applyRegionUnlock(); }
        return applyRegionUnlock();
    }

    // 上传接口判定：只要「上传/附件」语义的端点，避免误包对话请求。
    // 段名必须是独立的 upload/uploads，或 files|attachments + attach|upload 组合。
    function isUploadUrl(url) {
        var u = (url || '').toLowerCase();
        if (!u || u.indexOf('http') !== 0) return false;
        if (/(^|[\/\-_.])uploads?([\/\-_.?]|$)/.test(u)) return true;
        if (/\/(attachments?|files?)[\/\-_]?(attach|upload)/.test(u)) return true;
        if (/attachment/.test(u) && /file/.test(u)) return true;
        // OneDrive / SharePoint / Graph 常见上传会话
        if (/createuploadsession|uploadsession|uploadfile|fileupload/i.test(u)) return true;
        if (/(sharepoint|onedrive|graph\.microsoft\.com)/.test(u) && /\/content(?:[\/?]|$)/.test(u)) return true;
        return false;
    }

    // 该状态码是否值得重试：断连 / 超时 / 429 / 5xx 重试，4xx 业务错误不重试
    function isTransientStatus(status) {
        if (status === 0) return true;
        if (!status) return false;
        if (status === 408 || status === 429) return true;
        return status >= 500;
    }

    function backoffDelay(attempt) {
        var n = Math.max(1, attempt | 0);
        return Math.min(4000, 300 * Math.pow(2, n - 1));
    }

    // 从提示文字里找重试按钮：文案命中 + 不是模型行
    function pickRetryText(texts) {
        for (var i = 0; i < (texts || []).length; i++) {
            var t = texts[i];
            if (typeof t !== 'string') continue;
            var s = t.trim();
            if (!s || s.length > 24) continue;
            if (/重试|再试|重新上传|重新尝试|retry|try again/i.test(s)) return s;
        }
        return '';
    }

    // ======================================================================
    // L5 执行层 · 存储预写、驱动模型菜单、上传重试
    // ======================================================================

    function pageWin() {
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
        if (typeof window !== 'undefined' && window) return window;
        return typeof globalThis !== 'undefined' ? globalThis : null;
    }

    // 包一层 XHR.send：上传请求遇断连/超时/429/5xx 自动退避重试。
    // 关键：宿主自己的 load/error 监听器是先注册的，原生事件会先到它们手里——
    // 所以必须在 send 期间拦下原生事件，由我们决定何时把「最终结果」重放出去，
    // 否则重试的中间响应会被应用当成一次真实上传结果（可能直接报失败）。
    var MAX_RETRY = 3;

    function installUploadRetry() {
        var w = pageWin();
        var X = w && w.XMLHttpRequest;
        if (!X || !X.prototype || X.prototype.__cpWrapped) return false;

        var origSend = X.prototype.send;
        X.prototype.__cpWrapped = true;
        X.prototype.send = function (body) {
            var xhr = this;
            // 未 boot 时（测试直调、或脚本被晚注入）OPT 还没装载：此时按默认值处理
            var method = String(xhr.__cpMethod || 'POST').toUpperCase();
            var uploadMethod = method === 'POST' || method === 'PUT' || method === 'PATCH';
            if (OPT.uploadRetry === false || !uploadMethod || !isUploadUrl(xhr.__cpUrl)) {
                return origSend.apply(xhr, arguments);
            }

            var args = arguments;
            var attempt = 0;
            var settled = false;      // 已对调用方交付最终结果
            var delivered = false;    // 最终结果只重放一次
            var gated = false;        // 正在拦截原生事件
            var origMethod = xhr.__cpMethod || 'POST';
            var origUrl = xhr.__cpUrl;
            var origHeaders = (xhr.__cpHeaders || []).slice();
            var origWithCreds = !!xhr.__cpWithCreds;
            var gateTimer = null;

            // 原生事件在捕获阶段被截停，不冒泡到应用自己的监听器
            var blockers = {};
            function gate(on) {
                if (on === gated) return;
                gated = on;
                ['load', 'error', 'abort', 'timeout', 'progress', 'loadend', 'readystatechange'].forEach(function (t) {
                    if (on) {
                        if (!blockers[t]) {
                            blockers[t] = function (ev) {
                                if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                            };
                        }
                        xhr.addEventListener(t, blockers[t], true);
                    } else if (blockers[t]) {
                        xhr.removeEventListener(t, blockers[t], true);
                    }
                });
            }

            // 重放只给一次：先解除闸门，再派发一次最终结果；
            // 同时打上已重放的标记，避免后续任何路径重复通知调用方。
            function deliver(type) {
                if (delivered) return;
                delivered = true;
                gate(false);
                try { xhr.dispatchEvent(new w.Event(type)); } catch (e) { /* 派发失败不影响上传本身 */ }
            }

            function onSettle(type) {
                if (settled) return;
                settled = true;
                if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
                detachAll();
                deliver(type);
            }

            // 自己的监听也在捕获阶段：必须早于闸门注册，才能在拦截之前拿到结果
            function detachAll() {
                xhr.removeEventListener('load', onLoad, true);
                xhr.removeEventListener('error', onError, true);
                xhr.removeEventListener('timeout', onTimeout, true);
            }

            function retryOr(type) {
                if (settled) return;
                if (attempt >= MAX_RETRY) {
                    STATE.uploads.failed++;
                    return onSettle(type);
                }
                attempt++;
                STATE.uploads.retried++;
                var wait = backoffDelay(attempt);
                setTimeout(function () {
                    if (settled) return;
                    // 同一个 xhr 不能再 send 第二次（readyState 已非 OPENED，会抛 InvalidStateError），
                    // 必须重建连接再发：按原方法/地址/头重新 open 一遍。
                    try {
                        xhr.open(origMethod, origUrl, true);
                        applyHeaders(xhr, origHeaders);
                        if (origWithCreds) xhr.withCredentials = true;
                    } catch (e) {
                        STATE.uploads.failed++;
                        return onSettle('error');
                    }
                    arm();
                }, wait);
            }

            function onLoad() {
                if (settled) return;
                if (isTransientStatus(xhr.status) && attempt < MAX_RETRY) return retryOr('load');
                onSettle('load');
            }
            function onError() {
                if (settled) return;
                retryOr('error');
            }
            function onTimeout() {
                if (settled) return;
                retryOr('timeout');
            }

            function arm() {
                // 顺序至关重要：捕获阶段按注册顺序触发，
                // 必须先撤闸门 → 注册自己的监听 → 再上闸门，
                // 否则重试时自己的监听会排在闸门之后，被自己拦掉。
                gate(false);
                detachAll();
                xhr.addEventListener('load', onLoad, true);
                xhr.addEventListener('error', onError, true);
                xhr.addEventListener('timeout', onTimeout, true);
                gate(true);
                try {
                    origSend.apply(xhr, args);
                } catch (e) {
                    retryOr('error');
                }
            }

            arm();
        };
        return true;
    }

    // 记录请求 URL（open 是 send 之前唯一能看到地址的地方）
    function installUrlCapture() {
        var w = pageWin();
        var X = w && w.XMLHttpRequest;
        if (!X || !X.prototype || X.prototype.__cpUrlHooked) return false;
        var origOpen = X.prototype.open;
        var origSetHeader = X.prototype.setRequestHeader;
        X.prototype.__cpUrlHooked = true;
        X.prototype.open = function (method, url) {
            try {
                this.__cpMethod = String(method || 'POST');
                this.__cpUrl = String(url || '');
                this.__cpHeaders = [];
                this.__cpWithCreds = false;
            } catch (e) { /* 只读属性时跳过 */ }
            return origOpen.apply(this, arguments);
        };
        // 头也记下来：重试要重建连接，缺了 Content-Type 服务端会拒收
        if (typeof origSetHeader === 'function') {
            X.prototype.setRequestHeader = function (k, v) {
                try {
                    if (this.__cpHeaders) this.__cpHeaders.push([String(k), String(v)]);
                } catch (e) { /* 忽略 */ }
                return origSetHeader.apply(this, arguments);
            };
        }
        return true;
    }

    function applyHeaders(xhr, list) {
        for (var i = 0; i < (list || []).length; i++) {
            try { xhr.setRequestHeader(list[i][0], list[i][1]); } catch (e) { /* 头不可设置时跳过 */ }
        }
    }

    // 上传失败提示里的重试按钮：页面自己给了出口就替用户点一下（同一提示只点一次）
    var FAIL_RE = /上传失败|上传未完成|upload failed|failed to upload|couldn't upload|上传出错/;

    function healUploadFailure() {
        var hits = [];
        var all = document.querySelectorAll('div,span,p,li,section,[role="alert"],[role="status"]');
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (!isVisible(el)) continue;
            var t = norm(el.textContent);
            if (!t || t.length > 60) continue;          // 只看短提示块
            if (!FAIL_RE.test(t)) continue;
            if (el.querySelector('button,[role="button"]')) hits.push(el);
        }
        var n = 0;
        for (var j = 0; j < hits.length && j < 3; j++) {
            var box = hits[j];
            if (box.getAttribute(MARK_ATTR) === '1') continue;   // 同一提示只处理一次
            var btns = box.querySelectorAll('button,[role="button"]');
            for (var k = 0; k < btns.length; k++) {
                var bt = btns[k];
                if (!isVisible(bt)) continue;
                if (!/重试|再试|重新上传|retry|try again/i.test(norm(bt.textContent))) continue;
                box.setAttribute(MARK_ATTR, '1');
                bt.click();
                n++;
                break;
            }
        }
        if (n) STATE.uploads.healing += n;
        return n;
    }

    // ======================================================================
    // L6 UI 层 · 设置面板（ghb 视觉规范，cp- 前缀；懒挂载，菜单唯一入口）
    // ======================================================================

    var PANEL_CSS = [
        'html{--cp-accent:#2da44e;--cp-accent-2:#1a7f37;--cp-accent-fg:#ffffff;',
        '--cp-good:#2da44e;--cp-warn:#d29922;--cp-bad:#f85149;}',
        '.cp-scope{',
        '--cp-bg:#0d1117;--cp-bg-2:#161b22;--cp-bg-3:#21262d;',
        '--cp-bd:#30363d;--cp-bd-2:#21262d;',
        '--cp-fg:#e6edf3;--cp-fg-2:#8b949e;--cp-fg-3:#6e7681;',
        '--cp-shadow:0 16px 44px rgba(0,0,0,.5);',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
        'color:var(--cp-fg);font-size:13px;line-height:1.5;}',
        '@media (prefers-color-scheme: light){',
        '.cp-scope{--cp-bg:#ffffff;--cp-bg-2:#f6f8fa;--cp-bg-3:#eaeef2;',
        '--cp-bd:#d0d7de;--cp-bd-2:#d8dee4;',
        '--cp-fg:#1f2328;--cp-fg-2:#59636e;--cp-fg-3:#818b98;',
        '--cp-shadow:0 16px 44px rgba(31,35,40,.16);}}',
        '#cp-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s;}',
        '#cp-overlay.cp-open{opacity:1;pointer-events:auto;}',
        '#cp-panel{position:fixed;left:50%;top:50%;z-index:2147483002;width:460px;max-width:calc(100vw - 32px);max-height:84vh;',
        'background:var(--cp-bg);border:1px solid var(--cp-bd);border-radius:14px;box-shadow:var(--cp-shadow);',
        'display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translate(-50%,-46%) scale(.97);pointer-events:none;',
        'transition:opacity .22s,transform .22s cubic-bezier(.4,0,.2,1);}',
        '#cp-panel.cp-open{opacity:1;transform:translate(-50%,-50%) scale(1);pointer-events:auto;}',
        '.cp-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--cp-bd-2);flex:none;}',
        '.cp-head h2{margin:0;font-size:15px;font-weight:600;color:var(--cp-fg);}',
        '.cp-head .cp-ver{font-size:11px;color:var(--cp-fg-2);border:1px solid var(--cp-bd);border-radius:999px;padding:1px 7px;}',
        '.cp-tabs{display:flex;border-bottom:1px solid var(--cp-bd-2);flex:none;background:var(--cp-bg-2);}',
        '.cp-tab{flex:1;padding:10px 0;border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:13px;',
        'color:var(--cp-fg-2);border-bottom:2px solid transparent;transition:color .15s,background .15s;}',
        '.cp-tab:hover{color:var(--cp-fg);background:var(--cp-bg-3);}',
        '.cp-tab.cp-on{color:var(--cp-fg);font-weight:600;border-bottom-color:var(--cp-accent);}',
        '.cp-body{flex:1;overflow-y:auto;min-height:180px;}',
        '.cp-body::-webkit-scrollbar{width:8px;}',
        '.cp-body::-webkit-scrollbar-thumb{background:var(--cp-bd);border-radius:4px;}',
        '.cp-page{display:none;} .cp-page.cp-on{display:block;}',
        '.cp-setting{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;transition:background .12s;}',
        '.cp-setting:hover{background:var(--cp-bg-2);}',
        '.cp-st-t{font-size:13px;color:var(--cp-fg);}',
        '.cp-st-d{font-size:11.5px;color:var(--cp-fg-2);margin-top:2px;}',
        '.cp-switch{position:relative;width:40px;height:22px;flex:none;cursor:pointer;}',
        '.cp-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1;}',
        '.cp-switch i{display:block;width:40px;height:22px;border-radius:11px;background:var(--cp-bd);transition:background .22s;position:relative;}',
        '.cp-switch i::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;',
        'transition:transform .22s cubic-bezier(.4,0,.2,1);}',
        '.cp-switch input:checked + i{background:var(--cp-accent);}',
        '.cp-switch input:checked + i::after{transform:translateX(18px);}',
        '.cp-input{flex:none;width:210px;padding:6px 9px;border:1px solid var(--cp-bd);border-radius:6px;background:var(--cp-bg-2);',
        'color:var(--cp-fg);font-family:inherit;font-size:12px;}',
        '.cp-input:focus{outline:none;border-color:var(--cp-accent);}',
        '.cp-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border:1px solid var(--cp-bd);border-radius:6px;',
        'background:var(--cp-bg-3);color:var(--cp-fg);font-family:inherit;font-size:12px;cursor:pointer;white-space:nowrap;',
        'transition:background .15s,border-color .15s;}',
        '.cp-btn:hover{background:var(--cp-bd);border-color:var(--cp-fg-3);}',
        '.cp-btn.cp-primary{background:var(--cp-accent);border-color:var(--cp-accent);color:var(--cp-accent-fg);}',
        '.cp-btn.cp-primary:hover{background:var(--cp-accent-2);}',
        '.cp-icon-btn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:none;border-radius:6px;',
        'background:transparent;color:var(--cp-fg-2);cursor:pointer;font-size:14px;transition:background .15s,color .15s;}',
        '.cp-icon-btn:hover{background:var(--cp-bg-3);color:var(--cp-fg);}',
        '.cp-status{margin:0 16px 12px;padding:9px 11px;border:1px solid var(--cp-bd);border-radius:8px;background:var(--cp-bg-2);',
        'font-size:11.5px;color:var(--cp-fg-2);line-height:1.6;}',
        '.cp-status b{color:var(--cp-fg);font-weight:600;}',
        '.cp-foot{display:flex;gap:8px;justify-content:flex-end;padding:10px 16px;border-top:1px solid var(--cp-bd-2);flex:none;background:var(--cp-bg-2);}',
        '#cp-toasts{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483004;display:flex;',
        'flex-direction:column;gap:8px;align-items:center;pointer-events:none;}',
        '.cp-toast{display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 32px));padding:9px 14px;',
        'border-radius:8px;font-family:inherit;font-size:13px;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.35);',
        'opacity:0;transform:translateY(12px);transition:opacity .22s,transform .22s;}',
        '.cp-toast.cp-show{opacity:1;transform:none;}',
        '.cp-toast.cp-info{background:#1f6feb;} .cp-toast.cp-ok{background:var(--cp-good);}',
        '.cp-toast.cp-warn{background:#9e6a03;} .cp-toast.cp-err{background:#b62324;}'
    ].join('\n');

    var uiBuilt = false;

    var raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : function (fn) { setTimeout(fn, 16); };

    function toast(msg, kind) {
        if (!document || !document.body) return;
        var host = document.getElementById('cp-toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'cp-toasts';
            document.body.appendChild(host);
        }
        var el = document.createElement('div');
        el.className = 'cp-toast cp-' + (kind || 'info');
        el.textContent = msg;
        host.appendChild(el);
        raf(function () { el.classList.add('cp-show'); });
        setTimeout(function () {
            el.classList.remove('cp-show');
            setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
        }, 3200);
    }

    // 注入判定与自动选模型结论必须明示——用户不该对着一个没反应的按钮猜原因
    function statusText() {
        var t = OPT.regionUnlock ? '地区解锁已启用' : '地区解锁已关闭';
        t += '<br>上传增强已启用';
        if (!OPT.uploadRetry && !OPT.uploadFailureWatch) return t + '；上传两项均已关闭';
        t += '；地区改写 <b>' + STATE.regionPatches + '</b> 处';
        t += '<br>已重试 <b>' + STATE.uploads.retried + '</b> 次 / 自动再试 <b>' +
            STATE.uploads.healing + '</b> 次 / 最终失败 <b>' + STATE.uploads.failed + '</b> 次';
        return t;
    }

    function makeSettingRow(name) {
        var d = OPT_DEFS[name];
        var row = document.createElement('div');
        row.className = 'cp-setting';

        var left = document.createElement('div');
        var t = document.createElement('div');
        t.className = 'cp-st-t';
        t.textContent = d.label;
        var tip = document.createElement('div');
        tip.className = 'cp-st-d';
        tip.textContent = d.tip;
        left.appendChild(t);
        left.appendChild(tip);
        row.appendChild(left);

        if (d.type === 'text') {
            var inp = document.createElement('input');
            inp.className = 'cp-input';
            inp.type = 'text';
            inp.setAttribute('data-opt', name);
            inp.setAttribute('placeholder', '自动（留空）');
            inp.value = OPT[name];
            inp.setAttribute('aria-label', d.label);
            row.appendChild(inp);
            return row;
        }

        var lab = document.createElement('label');
        lab.className = 'cp-switch';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('data-opt', name);
        input.checked = OPT[name];
        var i = document.createElement('i');
        lab.appendChild(input);
        lab.appendChild(i);
        row.appendChild(lab);
        return row;
    }

    function buildUI() {
        if (uiBuilt) return;
        var style = document.createElement('style');
        style.id = 'cp-panel-style';
        style.textContent = PANEL_CSS;
        (document.head || document.documentElement).appendChild(style);

        var overlay = document.createElement('div');
        overlay.id = 'cp-overlay';
        var panel = document.createElement('div');
        panel.id = 'cp-panel';
        panel.className = 'cp-scope';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Copilot 增强助手设置');

        var head = document.createElement('div');
        head.className = 'cp-head';
        var h2 = document.createElement('h2');
        h2.textContent = 'Copilot 增强助手';
        var ver = document.createElement('span');
        ver.className = 'cp-ver';
        ver.textContent = 'v' + VERSION;
        var closeBtn = document.createElement('button');
        closeBtn.className = 'cp-icon-btn';
        closeBtn.id = 'cp-close';
        closeBtn.textContent = '✕';
        closeBtn.setAttribute('aria-label', '关闭');
        head.appendChild(h2);
        head.appendChild(ver);
        head.appendChild(closeBtn);

        var tabs = document.createElement('div');
        tabs.className = 'cp-tabs';
        var body = document.createElement('div');
        body.className = 'cp-body';

        var byGroup = {};
        for (var name in OPT_DEFS) {
            var g = OPT_DEFS[name].group;
            (byGroup[g] = byGroup[g] || []).push(name);
        }
        GROUPS.forEach(function (g, idx) {
            var tab = document.createElement('button');
            tab.className = 'cp-tab' + (idx === 0 ? ' cp-on' : '');
            tab.setAttribute('data-tab', g);
            tab.textContent = g;
            tabs.appendChild(tab);

            var page = document.createElement('div');
            page.className = 'cp-page' + (idx === 0 ? ' cp-on' : '');
            page.setAttribute('data-page', g);
            (byGroup[g] || []).forEach(function (n) { page.appendChild(makeSettingRow(n)); });

            if (g === '上传') {
                var st = document.createElement('div');
                st.className = 'cp-status';
                st.id = 'cp-status';
                st.innerHTML = statusText();
                page.appendChild(st);
            }
            body.appendChild(page);
        });


        panel.appendChild(head);
        panel.appendChild(tabs);
        panel.appendChild(body);
        document.body.appendChild(overlay);
        document.body.appendChild(panel);
        uiBuilt = true;
    }

    function refreshStatus() {
        var el = document && document.getElementById('cp-status');
        if (el) el.innerHTML = statusText();
    }

    function openPanel() {
        if (!document.body) return;
        buildUI();
        refreshStatus();
        document.getElementById('cp-overlay').classList.add('cp-open');
        document.getElementById('cp-panel').classList.add('cp-open');
    }

    function closePanel() {
        var o = document.getElementById('cp-overlay');
        var p = document.getElementById('cp-panel');
        if (o) o.classList.remove('cp-open');
        if (p) p.classList.remove('cp-open');
    }

    // 面板事件：委托一次；开关即时生效，文本框在 change 时落盘
    function bindPanelEvents() {
        document.addEventListener('click', function (ev) {
            if (!uiBuilt) return;
            var t = ev.target;
            if (!t || typeof t.closest !== 'function') return;
            if (t.id === 'cp-overlay') { closePanel(); return; }
            if (t.closest('#cp-close')) { closePanel(); return; }
            var tab = t.closest('.cp-tab');
            if (tab) {
                var g = tab.getAttribute('data-tab');
                var all = document.querySelectorAll('.cp-tab');
                for (var i = 0; i < all.length; i++) all[i].classList.remove('cp-on');
                tab.classList.add('cp-on');
                var pages = document.querySelectorAll('.cp-page');
                for (var j = 0; j < pages.length; j++) {
                    pages[j].classList.toggle('cp-on', pages[j].getAttribute('data-page') === g);
                }
            }
        }, false);

        document.addEventListener('change', function (ev) {
            var t = ev.target;
            if (!t || !t.getAttribute || !t.hasAttribute('data-opt')) return;
            var name = t.getAttribute('data-opt');
            if (!(name in OPT_DEFS)) return;
            var d = OPT_DEFS[name];
            var v = d.type === 'text' ? saveOpt(name, t.value) : saveOpt(name, t.checked);
            if (d.type === 'text') t.value = v;
            if (name === 'regionUnlock' && v === true) {
                tryInstall(installRegionUnlock);
                if (typeof toast === 'function') toast('地区解锁已启用', 'ok');
            }
            refreshStatus();
        }, false);

        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') closePanel();   // 面板规范：Esc 关闭（唯一允许的快捷键）
        }, false);
    }

    // ======================================================================
    // L7 Watcher 层 · 唯一监听者：等待帮手 + 路由钩子 + DOM 变更防抖复检
    // ======================================================================

    var _debTimer = null;

    function watch() {
        if (typeof MutationObserver === 'undefined') return;
        var mo = new MutationObserver(function () {
            if (_debTimer) clearTimeout(_debTimer);
            _debTimer = setTimeout(function () {
                _debTimer = null;
                if (OPT.regionUnlock) { try { applyRegionUnlock(); } catch (e) { } }
                if (OPT.uploadFailureWatch) healUploadFailure();
                if (uiBuilt) refreshStatus();
            }, 400);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ======================================================================
    // 启动序列 · loadOpts → 预写模型偏好 → (DOMContentLoaded) 面板事件/监听 → 自动选模型
    // ======================================================================

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('打开设置面板', openPanel);
    }

    // 上传增强安装失败只影响该项，不影响页面本身。
    function tryInstall(fn) {
        try { return fn(); } catch (e) { return false; }
    }

    function start() {
        tryInstall(bindPanelEvents);
        tryInstall(watch);
        tryInstall(installUrlCapture);
        tryInstall(installUploadRetry);
        tryInstall(applyRegionUnlock);
    }

    function boot() {
        try { loadOpts(); } catch (e) { /* 管理器读取异常时继续用默认值 */ }
        ensureOpts();
        // document-start 先挂钩 JSON.parse，尽量早于宿主读取资格数据
        tryInstall(installRegionUnlock);
        try { registerMenu(); } catch (e) { /* 菜单注册失败不影响上传增强 */ }
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
        VERSION: VERSION, PREFIX: PREFIX, GROUPS: GROUPS, OPT_DEFS: OPT_DEFS, STATE: STATE,
        readOpt: readOpt, saveOpt: saveOpt, loadOpts: loadOpts, ensureOpts: ensureOpts, norm: norm,
        patchRegionData: patchRegionData, patchRegionJsonText: patchRegionJsonText,
        bindPanelEvents: bindPanelEvents,
        applyRegionUnlock: applyRegionUnlock, installRegionUnlock: installRegionUnlock,
        isUploadUrl: isUploadUrl, isTransientStatus: isTransientStatus, backoffDelay: backoffDelay,
        pickRetryText: pickRetryText, installUploadRetry: installUploadRetry,
        healUploadFailure: healUploadFailure, statusText: statusText,
        openPanel: openPanel, closePanel: closePanel, buildUI: buildUI,
        __setOpt: function (name, value) { OPT[name] = value; },
        __getOpt: function (name) { return OPT[name]; }
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = API;
    } else {
        boot();
    }
})();
