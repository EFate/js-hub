// ==UserScript==
// @name         Copilot 增强助手
// @namespace    js-hub/copilot-enhance
// @version      1.2.2
// @description  按真实页面文字自动选择 Copilot 深度思考模型（后台预写优先），并为附件上传增加网络抖动重试与失败自愈——7 个开关、3 组分类，菜单打开设置面板，零依赖
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

    var VERSION = '1.2.2';
    var PREFIX = 'cp';               // 存储键前缀：cp.<开关名>
    var MARK_ATTR = 'data-cp-retry';
    var GROUPS = ['模型', '网络', '通用'];

    // 设置面板的唯一数据源：只保留 2026-11-06 在 copilot.com 实测可用的能力。
    var OPT_DEFS = {
        // —— 模型 ——
        backgroundModel:   { group: '模型', type: 'bool', label: '后台静默设定模型', tip: '学到宿主存储键后，在新页面读取前先写入深度思考偏好，不打开菜单、不点击', def: true },
        autoSelectModel:   { group: '模型', type: 'bool', label: '必要时自动点选',     tip: '后台预写尚未学到存储键时，打开模型菜单点一次；成功后记住宿主存储键', def: true },
        preferReasoning:   { group: '模型', type: 'bool', label: '优先深度思考',     tip: '优先选「深度思考 / Think deeper」，关闭则优先「快速响应」', def: true },
        modelTarget:       { group: '模型', type: 'text', label: '固定模型（可选）', tip: '只在想锁定某个模型时填写，如 GPT-5.6；留空则自动选最新可用模型', def: '' },
        // —— 网络 ——
        uploadRetry:       { group: '网络', type: 'bool', label: '附件上传自动重试', tip: '上传接口断连 / 429 / 5xx 时自动退避重试，最多 3 次', def: true },
        uploadFailureWatch: { group: '网络', type: 'bool', label: '上传失败自动再试', tip: '页面出现「上传失败」提示时自动点其中的重试按钮，同一提示只点一次', def: true },
        // —— 通用 ——
        toastOnSwitch:     { group: '通用', type: 'bool', label: '切换结果提示',     tip: '模型切换成功或失败时在页面底部提示一次', def: true }
    };

    // ======================================================================
    // L2 数据结构层 · OPT 单一数据源（loadOpts 唯一入口，saveOpt 唯一出口，readOpt 唯一归一）
    // ======================================================================

    var OPT = {};
    var STATE = {
        lastSwitch: '', switchRuns: 0,
        uploads: { retried: 0, failed: 0, healing: 0 },
        modelKeys: [],          // 已确认是模型偏好的存储键（自学习结果）
        preseeded: 0,           // 本次加载预写成功的键数
        learnedAt: 0
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

    // 宿主分型：决定「本页是否是 Copilot 对话页面」
    function hostKind(host) {
        var h = (host || '').toLowerCase();
        if (h.indexOf('bing.com') > -1) return 'bing';
        if (h.indexOf('outlook.office.com') > -1) return 'outlook';
        if (h.indexOf('microsoftonline.cn') > -1) return 'cn';
        if (h.indexOf('m365.cloud.microsoft') > -1 || h.indexOf('copilot.cloud.microsoft') > -1 ||
            h.indexOf('copilot.microsoft.com') > -1 || h === 'copilot.com' || h.indexOf('www.copilot.com') > -1) return 'copilot';
        return 'other';
    }

    // 只有对话页面才做自动选模型：邮件/日历等页面不存在模型切换器，硬跑只会空转
    function shouldAutoSelect(href) {
        var u;
        try { u = new URL(href); } catch (e) { return false; }
        var kind = hostKind(u.hostname);
        var p = (u.pathname || '').toLowerCase();
        if (kind === 'bing') return p.indexOf('/chat') === 0;
        if (kind === 'outlook') return p.indexOf('/chat') > -1 || p.indexOf('/copilot') > -1;
        if (kind === 'cn' || kind === 'copilot') return true;
        return false;
    }

    // ---- 模型档位识别（界面文字驱动，不依赖任何语言的写死标签）----

    var MODEL_ID_RE = /\b(?:(?:gpt|o[1-9])[-\s]?[\d][\w.\-]*|claude[-\s]?\w+(?:[-\s]?[\d][\w.\-]*)?)\b/i;

    // 真实 DOM 会把标题和说明拼成一个字符串：
    // 「深度思考思考更长的时间以获得更好的回答」。因此按前缀识别标题，
    // 但「决定要思考多长时间」不以「思考」开头，不会被误判。
    var AUTO_PREFIX_RE = /^(自动|auto)/i;
    var DEEP_PREFIX_RE = /^(深度思考|深度推理|推理|思考|think\s*deeper|deeper|reasoning)/i;
    var QUICK_PREFIX_RE = /^(快速响应|快速|即时|instant|quick|fast)/i;

    function isAlertText(s) { return /上传失败|失败|错误|重试|不足|额度|upload|failed|error|retry|too large|unsupported|[×✕✖]/.test(s); }

    // 菜单里是否是「模型档位」行：带模型标识（GPT-5.6 / Claude），或整行就是一个模式标签
    function isModelItem(text) {
        var t = (text || '');
        if (!t) return false;
        if (MODEL_ID_RE.test(t)) return true;
        var key = norm(t);
        return AUTO_PREFIX_RE.test(key) || DEEP_PREFIX_RE.test(key) || QUICK_PREFIX_RE.test(key);
    }

    // 从菜单行里取模型标识并归一：GPT-5.6 Sol 深度思考 → gpt-5.6
    function modelIdOf(text) {
        var m = (text || '').match(MODEL_ID_RE);
        if (!m) return '';
        return norm(m[0]).replace(/\s+/g, '-').replace(/-+/g, '-');
    }

    // 模式分：整行带模式词即算该模式（GPT-5.6 Sol 深度思考 → deep）
    function modeOf(text) {
        var t = norm(text);
        if (/深度思考|深度推理|think\s*deeper|deeper|reasoning/i.test(t)) return 'deep';
        if (/快速响应|即时|instant|quick|fast/i.test(t)) return 'quick';
        if (AUTO_PREFIX_RE.test(t)) return 'auto';
        return 'none';
    }

    // 目标文字解析：空串 = 自动（取最新模型 + 优先模式）
    function resolveTarget(opt) {
        return norm(opt && opt.modelTarget ? opt.modelTarget : '');
    }

    // 在可见菜单行里挑一个目标：
    // ① 显式关键字命中 ② 模式偏好 ③ 版本号最高的模型行
    function pickTargetItem(texts, opt) {
        var want = resolveTarget(opt);
        var preferDeep = !!(opt && opt.preferReasoning);
        var rows = [];
        for (var i = 0; i < (texts || []).length; i++) {
            var t = texts[i];
            if (typeof t !== 'string' || !t.trim()) continue;
            if (isAlertText(t) && !isModelItem(t)) continue;
            if (!isModelItem(t)) continue;
            rows.push({ idx: i, text: t, key: norm(t), id: modelIdOf(t), mode: modeOf(t) });
        }
        if (!rows.length) return -1;

        if (want) {
            var hits = [];
            var i2;
            for (i2 = 0; i2 < rows.length; i2++) if (rows[i2].key === want) hits.push(rows[i2]);
            if (!hits.length) {
                for (i2 = 0; i2 < rows.length; i2++) if (rows[i2].key.indexOf(want) === 0) hits.push(rows[i2]);
            }
            if (!hits.length) {
                for (i2 = 0; i2 < rows.length; i2++) if (rows[i2].key.indexOf(want) > -1) hits.push(rows[i2]);
            }
            if (!hits.length) return -1;   // 指定了关键字但菜单里没有：不猜
            // 同一模型有多个档位时（深度思考/快速响应），仍按模式偏好挑
            var wantMode = preferDeep ? 'deep' : 'quick';
            for (i2 = 0; i2 < hits.length; i2++) if (hits[i2].mode === wantMode) return hits[i2].idx;
            return hits[0].idx;
        }

        // 自动：先按模式过滤（只在与模型无关的行里筛），再按模型取最新
        var pool = rows.slice();
        var byMode = pool.filter(function (r) { return preferDeep ? r.mode === 'deep' : r.mode === 'quick'; });
        if (byMode.length) pool = byMode;

        var latest = null, latestRank = null;
        for (var k = 0; k < pool.length; k++) {
            var rank = modelRank(pool[k].id, pool[k].text);
            if (!latest || compareRank(rank, latestRank) > 0) { latest = pool[k]; latestRank = rank; }
        }
        return latest ? latest.idx : rows[0].idx;
    }

    // 版本号比较用：GPT-5.6 → [5,6]；非法返回 []
    function modelRank(id, text) {
        var s = (id || '') + ' ' + (text || '');
        return s.toLowerCase().split(/[^0-9]+/).filter(function (x) { return x !== ''; }).map(Number);
    }

    function compareRank(a, b) {
        if (!b || !b.length) return a && a.length ? 1 : 0;
        if (!a || !a.length) return -1;
        var n = Math.max(a.length, b.length);
        for (var i = 0; i < n; i++) {
            var x = a[i] === undefined ? 0 : a[i];
            var y = b[i] === undefined ? 0 : b[i];
            if (x !== y) return x - y;
        }
        return 0;
    }

    // 切换器是否已显示目标：固定目标按文字比对；自动模式按模式偏好比对。
    function switcherMatches(swText, opt) {
        var t = norm(swText);
        var want = resolveTarget(opt);
        if (want) return t.indexOf(want) > -1;
        if (!t) return false;
        var expected = (opt && opt.preferReasoning) ? 'deep' : 'quick';
        if (modeOf(t) === expected) return true;
        return modelIdOf(t) !== '';
    }

    // ---- 宿主存储键的识别与改写（后台静默设定模型的核心）----

    // 只认「值看起来像模型标识」的键：这能挡住主题、语言、开关之类的无关项
    function looksLikeModelValue(v) {
        if (typeof v !== 'string') return false;
        var s = v.trim();
        if (!s || s.length > 120) return false;
        if (MODEL_ID_RE.test(s)) return true;
        // 值可能是 JSON：{"model":"gpt-5.6","mode":"deep"}
        if (s.charAt(0) === '{' || s.charAt(0) === '[') {
            return /"(?:model|modelId|deployment|gptId|variant)"\s*:\s*"[^"]+"/i.test(s);
        }
        // 有些宿主只存档位枚举，不含模型名
        return /^(auto|deep|quick|reasoning|fast|instant|think|think_deeper)$/i.test(s);
    }

    // 从存储值里抽出「模型段」，生成替换后的值；抽不出返回 null
    function rewriteModelValue(raw, opt) {
        if (typeof raw !== 'string') return null;
        var target = resolveTarget(opt);
        var want = target || (opt && opt.preferReasoning ? 'deep' : 'quick');

        // a) 纯字符串：gpt-5.6 / gpt-5.6-sol-deep
        if (raw.trim() === raw && raw.charAt(0) !== '{' && raw.charAt(0) !== '[') {
            // 纯档位枚举：quick / deep / auto
            if (/^(auto|deep|quick|reasoning|fast|instant|think|think_deeper)$/i.test(raw)) {
                var mode = (opt && opt.preferReasoning) ? 'deep' : 'quick';
                return raw === mode ? null : mode;
            }
            if (!MODEL_ID_RE.test(raw)) return null;
            if (target) {
                // 指定了目标：已是目标就不动，避免每次刷新都重写同一个值
                return norm(raw).indexOf(target) > -1 ? null : target;
            }
            // 留空＝沿用现有模型，只把模式词换成偏好档
            var base = raw.replace(/[-_ ]?(deeper|deep|think|reasoning|quick|fast|instant)[-_ ]?$/i, '');
            if (base === raw) return null;                     // 本来就没有模式段：不动
            return base + (opt && opt.preferReasoning ? '_deep' : '_quick');
        }

        // b) JSON 字符串：只改模型/模式字段，其它字段原样保留
        var data;
        try { data = JSON.parse(raw); } catch (e) { return null; }
        if (!data || typeof data !== 'object') return null;
        var changed = false;
        var MODEL_FIELDS = ['model', 'modelId', 'deployment', 'gptId', 'variant'];
        var MODE_FIELDS = ['reasoning', 'mode', 'tone'];
        var i;
        for (i = 0; i < MODEL_FIELDS.length; i++) {
            var mf = MODEL_FIELDS[i];
            if (typeof data[mf] !== 'string') continue;
            // 留空＝沿用原模型；指定了目标才覆盖
            if (target && norm(data[mf]) !== target) { data[mf] = target; changed = true; }
        }
        for (i = 0; i < MODE_FIELDS.length; i++) {
            var df = MODE_FIELDS[i];
            if (typeof data[df] !== 'string') continue;
            var cur = data[df];
            var isDeep = /deep|think|reason/i.test(cur);
            if (want === 'deep' && !isDeep) { data[df] = 'deep'; changed = true; }
            else if (want === 'quick' && isDeep) { data[df] = 'quick'; changed = true; }
        }
        return changed ? JSON.stringify(data) : null;
    }

    // 考核一个已安装的存储键：只要「值看起来就是模型标识」即可认领。
    // 注意：这里不能用「能否改写」当判据——留空自动模式下普通值本就无需改写，
    // 那样会把所有合法的模型键都漏掉，预写永远不生效。
    function isModelKey(storage, key, opt) {
        var raw;
        try { raw = storage.getItem(key); } catch (e) { return false; }
        if (!looksLikeModelValue(raw)) return false;
        // 键名带明显的非模型语义时排除（避免误改「模型列表」这类集合）
        if (/list|options|available|catalog|history/i.test(key)) return false;
        void opt;
        return true;
    }

    // ======================================================================
    // L4 核心逻辑层 · 模型选择与上传决策（纯函数，UMD 导出）
    // ======================================================================

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
            if (isModelItem(s)) continue;
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

    // ---- 模型切换 ----

    var SEL_SWITCHER = '#gptModeSwitcher, button[aria-label="Model Selector"], [data-testid="model-selector"]';
    var SEL_ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="button"], button, [tabindex]:not([tabindex="-1"])';

    var SWITCHER_TIMEOUT_MS = 15000;
    var ITEM_TIMEOUT_MS = 5000;
    var CONFIRM_TIMEOUT_MS = 4000;
    var RUN_ATTEMPTS = 2;

    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function isVisible(el) {
        return !!(el && el.getClientRects && el.getClientRects().length > 0);
    }

    function findSwitcher(doc) {
        return (doc || document).querySelector(SEL_SWITCHER);
    }

    // 收集可见菜单行的文字（与元素一一对应，顺序即文档序）
    function visibleTexts(doc) {
        var els = [].slice.call((doc || document).querySelectorAll(SEL_ITEMS)).filter(isVisible);
        var out = [];
        for (var i = 0; i < els.length; i++) out.push({ el: els[i], text: norm(els[i].textContent) });
        return out;
    }

    function textListOf(rows) {
        var out = [];
        for (var i = 0; i < rows.length; i++) out.push(rows[i].text);
        return out;
    }

    var menuOpen = false;

    function isOpen(sw) {
        return !!sw && sw.getAttribute('aria-expanded') === 'true';
    }

    function closeMenu(sw) {
        if (!menuOpen && !isOpen(sw)) return Promise.resolve();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        menuOpen = false;
        return sleep(150);
    }

    // 返回 done / already / retry（可安全重试）/ clicked（不要重试）
    async function navigate(opt) {
        var sw = await waitFor(function () { return findSwitcher(document); }, SWITCHER_TIMEOUT_MS);
        if (!sw) return 'retry';
        if (switcherMatches(sw.textContent, opt)) return 'already';

        await closeMenu(sw);
        sw.click();

        // 逐轮重新扫描菜单：SPA 渲染慢，等它把目标行渲染出来再点
        var tried = {};
        for (var round = 0; round < 2; round++) {
            var rows = await waitFor(function () {
                var r = visibleTexts(document);
                return pickTargetItem(textListOf(r), opt) > -1 ? r : null;
            }, ITEM_TIMEOUT_MS);
            if (!rows) break;
            var idx = pickTargetItem(textListOf(rows), opt);
            if (idx < 0) break;
            var key = rows[idx].text;
            if (tried[key]) break;                 // 同一行点过没生效：不再重复点
            tried[key] = 1;
            menuOpen = true;
            rows[idx].el.click();
            var ok = await waitFor(function () {
                return switcherMatches(findSwitcher(document) ? findSwitcher(document).textContent : '', opt) ? true : null;
            }, CONFIRM_TIMEOUT_MS);
            if (ok) { menuOpen = false; return 'done'; }
        }

        // 没点中：按 Esc 收尾，绝不留菜单挂在页面上（旧版失败即放弃，菜单会一直浮着）
        await closeMenu(sw);
        return 'retry';
    }

    async function autoSelect(opt) {
        opt = opt || OPT;
        if (!opt.autoSelectModel) return 'off';
        if (!shouldAutoSelect(location.href)) return 'skip';
        STATE.switchRuns++;

        for (var attempt = 1; attempt <= RUN_ATTEMPTS; attempt++) {
            var r = 'retry';
            try { r = await navigate(opt); } catch (e) { r = 'retry'; }
            if (r !== 'retry') {
                STATE.lastSwitch = r;
                // 点选成功后宿主已把偏好落盘，钩子会记录键；再立刻预写一次把模式对齐
                if (r === 'done') {
                    preseedModels(opt);
                    if (opt.toastOnSwitch) toast('模型已切换，后续页面将静默生效', 'ok');
                } else if (opt.toastOnSwitch) {
                    toast('模型切换已提交，请确认切换器显示', 'warn');
                }
                return r;
            }
            if (attempt < RUN_ATTEMPTS) await sleep(500);
        }
        STATE.lastSwitch = 'failed';
        if (opt.toastOnSwitch) toast('模型自动切换未成功，可在面板点「重新选模型」', 'err');
        return 'failed';
    }

    // 后台静默设定：先预写存储，没写成且允许点选时再退化为一次 UI 点击
    async function applyModel(opt) {
        opt = opt || OPT;
        if (!shouldAutoSelect(location.href)) return 'skip';
        if (opt.backgroundModel) {
            var n = preseedModels(opt);
            if (n > 0) {
                // 预写成功但宿主可能已把旧值读进内存：切换器若仍不是目标，允许补一次点击
                await sleep(600);
                var sw = findSwitcher(document);
                if (sw && switcherMatches(sw.textContent, opt)) {
                    STATE.lastSwitch = 'preseed';
                    return 'preseed';
                }
                if (!opt.autoSelectModel) return 'preseed';
            }
        }
        if (!opt.autoSelectModel) return opt.backgroundModel ? 'preseed' : 'off';
        return autoSelect(opt);
    }

    // ---- 宿主存储预写（后台静默设定模型）----

    var KEY_CFG = PREFIX + '.modelKeys';     // 自学习到的存储键清单

    function loadModelKeys() {
        try {
            var raw = GM_getValue(KEY_CFG);
            if (typeof raw === 'string' && raw) {
                var arr = JSON.parse(raw);
                if (Array.isArray(arr)) STATE.modelKeys = arr.filter(function (k) { return typeof k === 'string'; });
            }
        } catch (e) { STATE.modelKeys = []; }
        return STATE.modelKeys;
    }

    function saveModelKeys() {
        try { GM_setValue(KEY_CFG, JSON.stringify(STATE.modelKeys)); } catch (e) { /* 存储不可写时忽略 */ }
    }

    function rememberKey(key) {
        if (!key || STATE.modelKeys.indexOf(key) > -1) return false;
        STATE.modelKeys.push(key);
        saveModelKeys();
        STATE.learnedAt = Date.now();
        return true;
    }

    // 在存储里找模型键：先看自学习清单，再兜底全量扫一遍（键不合法就跳过）
    function findModelKeys(storage, opt) {
        var found = [];
        var i;
        for (i = 0; i < STATE.modelKeys.length; i++) {
            if (isModelKey(storage, STATE.modelKeys[i], opt)) found.push(STATE.modelKeys[i]);
        }
        if (found.length) return found;

        var n = 0;
        try { n = storage.length; } catch (e) { return found; }
        for (i = 0; i < n; i++) {
            var k;
            try { k = storage.key(i); } catch (e) { continue; }
            if (!k || STATE.modelKeys.indexOf(k) > -1) continue;
            if (isModelKey(storage, k, opt)) found.push(k);
        }
        return found;
    }

    // 预写：只改「值确实需要改」的键，改成功才写回；返回改动键数
    function preseedModels(opt) {
        opt = opt || OPT;
        if (!opt.backgroundModel) return 0;
        var n = 0;
        var stores = [];
        try { if (window.localStorage) stores.push(window.localStorage); } catch (e) { /* 存储被禁用 */ }
        try { if (window.sessionStorage) stores.push(window.sessionStorage); } catch (e) { /* 存储被禁用 */ }

        for (var s = 0; s < stores.length; s++) {
            var st = stores[s];
            var keys = findModelKeys(st, opt);
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                var raw;
                try { raw = st.getItem(key); } catch (e) { continue; }
                var next = rewriteModelValue(raw, opt);
                if (next === null || next === raw) continue;
                try { st.setItem(key, next); n++; } catch (e) { /* 配额/隐私模式写入失败 */ }
                rememberKey(key);
            }
        }
        STATE.preseeded = n;
        return n;
    }

    // ---- 学习：钩住 Storage.setItem，把「值像模型」的键记下来 ----
    // 用户（或我们的点选）一旦改了模型，宿主必然要落盘；那一刻我们就知道是哪个键了。
    function installModelLearn() {
        var w = pageWin();
        if (!w || !w.Storage || !w.Storage.prototype || w.Storage.prototype.__cpLearn) return false;
        var proto = w.Storage.prototype;
        var origSet = proto.setItem;
        proto.__cpLearn = true;
        proto.setItem = function (key, value) {
            var r = origSet.apply(this, arguments);
            try {
                if (looksLikeModelValue(value)) rememberKey(String(key));
            } catch (e) { /* 学习失败不影响原调用 */ }
            return r;
        };
        return true;
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
        var t = '页面：copilot.com 对话页';
        if (!OPT.backgroundModel && !OPT.autoSelectModel) {
            t += '；模型设定已关闭';
        } else if (!shouldAutoSelect(location.href)) {
            t += '；本页不是对话页，不设模型';
        } else {
            var map = {
                preseed: '已静默写入', done: '已点选切换', already: '本已是目标档位',
                clicked: '已提交切换', failed: '切换未成功', off: '已关闭', skip: '本页跳过'
            };
            var mode = OPT.backgroundModel ? (OPT.autoSelectModel ? '静默优先，必要时点选' : '仅静默写入') : '仅点选';
            t += '；模型设定（' + mode + '）：' + (map[STATE.lastSwitch] || '尚未执行');
            if (STATE.modelKeys.length) t += '；已识别模型键 ' + STATE.modelKeys.length + ' 个';
            else t += '；尚未识别模型键（会退化为点选）';
        }
        if (OPT.uploadRetry || OPT.uploadFailureWatch) {
            t += '<br>上传增强：已重试 <b>' + STATE.uploads.retried + '</b> 次 / 自动再试 <b>' +
                STATE.uploads.healing + '</b> 次 / 最终失败 <b>' + STATE.uploads.failed + '</b> 次';
        }
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

            if (g === '通用') {
                var st = document.createElement('div');
                st.className = 'cp-status';
                st.id = 'cp-status';
                st.innerHTML = statusText();
                page.appendChild(st);
            }
            body.appendChild(page);
        });

        var foot = document.createElement('div');
        foot.className = 'cp-foot';
        var retry = document.createElement('button');
        retry.className = 'cp-btn cp-primary';
        retry.id = 'cp-retry-model';
        retry.textContent = '重新选模型';
        foot.appendChild(retry);

        panel.appendChild(head);
        panel.appendChild(tabs);
        panel.appendChild(body);
        panel.appendChild(foot);
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
            if (t.closest('#cp-retry-model')) {
                closePanel();
                autoSelect(OPT);
                return;
            }
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
            if ((name === 'backgroundModel' || name === 'autoSelectModel') && v === true) applyModel(OPT);
            refreshStatus();
        }, false);

        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') closePanel();   // 面板规范：Esc 关闭（唯一允许的快捷键）
        }, false);
    }

    // ======================================================================
    // L7 Watcher 层 · 唯一监听者：等待帮手 + 路由钩子 + DOM 变更防抖复检
    // ======================================================================

    // 等 DOM 满足条件即返回（MutationObserver 驱动，首帧同步检查一次，超时返回 null）
    function waitFor(find, timeout) {
        return new Promise(function (resolve) {
            var first = null;
            try { first = find(); } catch (e) { first = null; }
            if (first) return resolve(first);
            if (typeof MutationObserver === 'undefined') return resolve(null);

            var done = false;
            var obs = new MutationObserver(check);
            var timer = setTimeout(function () { finish(null); }, timeout);

            function finish(v) {
                if (done) return;
                done = true;
                obs.disconnect();
                clearTimeout(timer);
                resolve(v);
            }
            function check() {
                var v = null;
                try { v = find(); } catch (e) { v = null; }
                if (v) finish(v);
            }
            obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        });
    }

    var _routeTimer = null;
    var _routePath = null;

    // 路由钩子：SPA 每次改 __routePath 后重新对齐模型（宿主会重建切换器）
    function hookRoute() {
        var w = pageWin();
        try {
            _routePath = w.__routePath;
            Object.defineProperty(w, '__routePath', {
                configurable: true,
                enumerable: true,
                get: function () { return _routePath; },
                set: function (value) {
                    _routePath = value;
                    if (_routeTimer) clearTimeout(_routeTimer);
                    _routeTimer = setTimeout(function () {
                        _routeTimer = null;
                        startModel();      // 换路由后宿主会重建切换器：重新对齐一次
                    }, 400);
                }
            });
        } catch (e) { /* 宿主已定义不可配置属性时放弃钩子，靠 DOM 复检兜底 */ }
    }

    var _debTimer = null;

    function watch() {
        if (typeof MutationObserver === 'undefined') return;
        var mo = new MutationObserver(function () {
            if (_debTimer) clearTimeout(_debTimer);
            _debTimer = setTimeout(function () {
                _debTimer = null;
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

    function startModel() {
        if (!OPT.backgroundModel && !OPT.autoSelectModel) return;
        if (!shouldAutoSelect(location.href)) return;
        applyModel(OPT);
    }

    function start() {
        bindPanelEvents();
        hookRoute();
        watch();
        installUrlCapture();
        installUploadRetry();
        installModelLearn();       // 先装钩子：任何一次模型落盘都能被记录
        startModel();
    }

    function boot() {
        loadOpts();
        loadModelKeys();
        // 存储预写必须尽早：DOMContentLoaded 之前宿主还没读到偏好
        preseedModels(OPT);
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
        VERSION: VERSION, PREFIX: PREFIX, GROUPS: GROUPS, OPT_DEFS: OPT_DEFS, STATE: STATE,
        readOpt: readOpt, saveOpt: saveOpt, loadOpts: loadOpts,
        norm: norm, hostKind: hostKind, shouldAutoSelect: shouldAutoSelect,
        MODEL_ID_RE: MODEL_ID_RE, isModelItem: isModelItem, modelIdOf: modelIdOf, modeOf: modeOf,
        resolveTarget: resolveTarget, pickTargetItem: pickTargetItem, modelRank: modelRank,
        compareRank: compareRank, switcherMatches: switcherMatches,
        isUploadUrl: isUploadUrl, isTransientStatus: isTransientStatus, backoffDelay: backoffDelay,
        pickRetryText: pickRetryText, installUploadRetry: installUploadRetry,
        healUploadFailure: healUploadFailure,
        visibleTexts: visibleTexts, findSwitcher: findSwitcher,
        looksLikeModelValue: looksLikeModelValue, rewriteModelValue: rewriteModelValue,
        isModelKey: isModelKey, findModelKeys: findModelKeys, loadModelKeys: loadModelKeys,
        rememberKey: rememberKey, preseedModels: preseedModels, installModelLearn: installModelLearn,
        applyModel: applyModel,
        navigate: navigate, autoSelect: autoSelect, toast: toast, statusText: statusText,
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
