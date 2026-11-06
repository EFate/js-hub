// ==UserScript==
// @name         Copilot 增强助手
// @namespace    js-hub/copilot-enhance
// @version      1.0.0
// @description  解除 Microsoft 365 Copilot 的地区与模型限制，并在页面加载后自动把模型切换到指定档位（默认 GPT Think deeper）——8 个开关、3 组分类，菜单打开设置面板，零依赖
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

    var VERSION = '1.0.0';
    var PREFIX = 'cp';               // 存储键前缀：cp.<开关名>
    var GROUPS = ['解锁', '模型', '通用'];

    // Copilot 的函数级功能开关目录（键名与宿主内部标志一一对应）。
    // 值即原厂默认值：少量 false 项意味着「关掉」正是我们想要的状态。
    var FLAG_TABLE = {
        isEURegion: false,
        enablePrivateChat: true,
        enablePrivateChatAdminCheck: true,
        enablePrivateChatDisableButton: true,
        enablePrivateChatInputTheme: true,
        enablePrivateChatOnAgents: true,
        enablePrivateChatTitleFix: true,
        enablePrivateChatTitleFixSsr: true,
        enablePrivateChatResetFix: true,
        enableClaudeModelWeb: true,
        enableClaudeModelWork: true,
        enableClaudeReasoningWeb: true,
        enableClaudeReasoningWork: true,
        enableServiceDrivenGPTMenuWeb: true,
        enableServiceDrivenGPTMenuWork: true,
        disableServiceDrivenGPTMenuForEU: false,
        enableServiceDrivenGPTMenuStarter: true,
        enableServiceDrivenGPTMenuPremium: true,
        enableGPT52Premium: true,
        enableGPT53Premium: true,
        enableGPT54Premium: true,
        enableGPT52Starter: true,
        enableGPT53Starter: true,
        enableGPT54Starter: true,
        enableGPT52ChatWork: true,
        enableGPT53ChatWork: true,
        enableGPT54ChatWork: true,
        enableGPT52ReasoningWork: true,
        enableGPT53ReasoningWork: true,
        enableGPT54ReasoningWork: true,
        enableGPT52QuickWork: true,
        enableGPT53QuickWork: true,
        enableGPT54QuickWork: true,
        enableGPT52AutoWork: true,
        enableGPT53AutoWork: true,
        enableGPT54AutoWork: true,
        enableGPT52InstantWork: true,
        enableGPT52ThinkingWork: true,
        enableGPT52ChatWeb: true,
        enableGPT53ChatWeb: true,
        enableGPT54ChatWeb: true,
        enableGPT52ReasoningWeb: true,
        enableGPT53ReasoningWeb: true,
        enableGPT54ReasoningWeb: true,
        enableGPT52QuickWeb: true,
        enableGPT53QuickWeb: true,
        enableGPT54QuickWeb: true,
        enableGPT52AutoWeb: true,
        enableGPT53AutoWeb: true,
        enableGPT54AutoWeb: true,
        enableGPT52InstantWeb: true,
        enableGPT52ThinkingWeb: true,
        enableGPT54ModelMenuDropdown: true,
        enableGptJjModelPlanningMessage: true,
        enableGPTInWebTabForFreeUsers: true,
        enableGPTBuilderInWebTabForFreeUsers: true,
        enableGPTInOWABasedonParam: true,
        disableGPTModeMenuStickiness: false,
        enableGptModelMenuTeachingMoment: true,
        enableGPTModeAndModelMenuDropdown: true,
        enableGPTModeAndModelMenu: false,
        enableGPTModeMenu: true,
        enableGPT: true,
        enableStealthMagicTone: false,
        enableGlobalChat: true,
        enableChatMessageMotion: true,
        enableSydneyReconnect: true,
        enableMemoryV2PremiumROW: true,
        enableMemoryV2PremiumEU: true,
        enableMemoryV2StarterROW: true,
        enableMemoryV2StarterEU: true,
        enableBizChatHomeRefresh: true,
        enableHideCoworkAgentsFromNav: false,
        enableCoworkPremiumCheck: false,
        enableCoworkGovCheck: false,
        enableCoworkEduCheck: false,
        enableCoworkFrontierTenantBypass: false,
        enableCoworkConsumptiveServicesDiscoverableCheck: false,
        enableCopilotAgentCenterRemoveCoworkAgents: false,
        enableResetModelSelectorOnNewChat: false,
        enableRefactoredNewChatButton: true,
        enabledSharedAnchorNewChatButton: true,
        enableNewChatButtonLogging: true,
        enableUpdateConvIdForNewChat: true,
        enableUpdateCorrelationIdForCreateNewChat: true,
        enableSydneyResetConversationOnNewChat: true
    };

    // 子开关管辖的键族：Claude 模型族 / GPT-5.2-5.4 档位族
    var CLAUDE_KEY_RE = /Claude/;
    var TIER_KEY_RE = /GPT5[234]/;

    var UX_FEATURES = ['CodeInterpreter', 'Designer', 'GPTV', 'Threads', 'WebGroundingControls', 'Pages', 'FileUpload'];

    var APPS_TARGETS = [
        'isAgentsEnabled', 'isConversationsEnabled', 'isFrontierEnabled', 'isOpalEnabled',
        'isNotebooksEnabled', 'isAppsInlineFlyoutEnabled', 'isAppsFooterFlyoutEnabled',
        'isCoworkEligible', 'isChatEligible', 'isLibraryEligible', 'isProjectsEligible', 'isLearnEligible'
    ];

    var NAV_TABS = [
        { id: 'chat', label: 'Chat', path: '/chat', icon: 'ChatsDarkIcon', isDefault: true, shouldBeLocalized: true },
        { id: 'cowork', label: 'Cowork', path: '/cowork', icon: 'CoworkFilled', isDefault: true, shouldBeLocalized: true }
    ];

    var OPT_DEFS = {
        // —— 解锁 ——
        unlockFeatures:   { group: '解锁', type: 'bool', label: '解锁功能与资格',   tip: '把功能开关表、Copilot 资格与许可全部置为已开通，并补齐内置应用入口', def: true },
        premiumModelTiers: { group: '解锁', type: 'bool', label: '开放 GPT 全档位', tip: '放开 GPT-5.2 / 5.3 / 5.4 在 Premium、Starter、Chat、Reasoning 等各入口的可见性', def: true },
        enableClaudeModels: { group: '解锁', type: 'bool', label: '开放 Claude 模型', tip: '放开 Claude 模型与 Claude 推理档位在网页版与企业版的可见性', def: true },
        forceUSRegion:    { group: '解锁', type: 'bool', label: '地区识别为美国',   tip: '把身份地区改为 US 并声明位于可用区域，解除区域限制', def: true },
        extraNavTabs:     { group: '解锁', type: 'bool', label: '补全导航入口',     tip: '导航栏缺失 Chat 与 Cowork 时自动补上（企业租户不改）', def: true },
        // —— 模型 ——
        autoSelectModel:  { group: '模型', type: 'bool', label: '自动选择模型',     tip: '页面载入后把模型切换器指向下方目标档位，已是目标档位则不动', def: true },
        deeperThinking:   { group: '模型', type: 'bool', label: '优先 Think deeper', tip: '在目标族里优先选中带「Think deeper」的深层推理子项', def: true },
        modelTarget:      { group: '模型', type: 'text', label: '目标档位关键字',   tip: '模型菜单里的完整子项文字；留空则使用默认值', def: 'gpt-5.6 sol think deeper' },
        // —— 通用 ——
        toastOnSwitch:    { group: '通用', type: 'bool', label: '切换结果提示',     tip: '模型切换成功或失败时在页面底部提示一次', def: true }
    };

    // ======================================================================
    // L2 数据结构层 · OPT 单一数据源（loadOpts 唯一入口，saveOpt 唯一出口，readOpt 唯一归一）
    // ======================================================================

    var OPT = {};
    var STATE = { patched: null, lastSwitch: '', switchRuns: 0 };

    // 单值归一（唯一合法判据）：布尔项非布尔回落默认值，文本项非字符串回落默认值。
    function readOpt(name, v) {
        var d = OPT_DEFS[name];
        if (!d) return undefined;
        if (d.type === 'text') {
            if (typeof v !== 'string') return d.def;
            var t = v.replace(/\s+/g, ' ').trim();
            return t || d.def;
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
    // L3 识别 / 解析层 · 文本归一、JSON 读取、宿主判定、模型档位推算
    // ======================================================================

    var norm = function (s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };

    function readJson(text) {
        if (typeof text !== 'string') return null;
        var t = text.trim();
        if (!t) return null;
        try {
            var d = JSON.parse(t);
            return (d && typeof d === 'object' && !Array.isArray(d)) ? d : null;
        } catch (e) {
            return null;
        }
    }

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

    // 目标档位 → 切换器上显示的确认文字：去掉尾部「 deeper」即为外层标签
    function confirmLabelFor(target) {
        var t = norm(target);
        if (!t) return '';
        return t.replace(/\s+deeper$/, '');
    }

    // 目标档位 → 外层标签（dashed 版与按空格切分的首段版各一份）
    function targetLabels(target) {
        var normed = norm(target);
        var confirm = normed.replace(/\s+deeper$/, '');
        var m = normed.match(/^[a-z0-9]+/);
        return { normed: normed, confirm: confirm, parent: m ? m[0] : normed };
    }

    // 目标档位：开启深层推理取完整子项，否则只取外层标签
    function resolveTarget(opt) {
        var base = confirmLabelFor(opt.modelTarget);
        return opt.deeperThinking ? norm(opt.modelTarget) : base;
    }

    // ======================================================================
    // L4 核心逻辑层 · 纯函数（UMD 导出，测试直接 require 真实代码）
    // ======================================================================

    // 按选项挑出要写入宿主的功能开关。
    // 子开关关闭时「不写入」而非「写 false」——不主动收回用户本就拥有的能力。
    function buildFlags(opt) {
        var out = {};
        if (opt.unlockFeatures) {
            for (var k in FLAG_TABLE) {
                if (CLAUDE_KEY_RE.test(k) && !opt.enableClaudeModels) continue;
                if (TIER_KEY_RE.test(k) && !opt.premiumModelTiers) continue;
                out[k] = FLAG_TABLE[k];
            }
        }
        if (opt.forceUSRegion) out.isEURegion = false;
        return out;
    }

    // 就地合并功能开关，返回实际改动数（相同值不计）
    function mergeFlags(target, flags) {
        if (!target || typeof target !== 'object' || !flags) return 0;
        var n = 0;
        for (var k in flags) {
            if (target[k] !== flags[k]) { target[k] = flags[k]; n++; }
        }
        return n;
    }

    // 资格对象：解锁项与地区项分开管，互不牵连
    function patchEligibility(e, opt, isMsa) {
        if (!e || typeof e !== 'object') return 0;
        var n = 0;
        function set(k, v) { if (e[k] !== v) { e[k] = v; n++; } }

        if (opt.unlockFeatures) {
            set('isCopilotEligible', true);
            set('m365CopilotAcquisitionState', 'acquired');
            set('acquisitionState', 'acquired');
            set('isOptedOutByAdmin', false);
            // 消费级账号缺省 cohort 会导致部分入口按企业租户分支走，仅在缺失时补默认值
            if (!isMsa && (!e.cohort || e.cohort === 'None')) set('cohort', 'bcais');
            if (!e.featureSet || typeof e.featureSet !== 'object') { e.featureSet = {}; n++; }
            var ux = e.featureSet.uxFeatures;
            if (!Array.isArray(ux)) { e.featureSet.uxFeatures = ux = []; n++; }
            for (var i = 0; i < UX_FEATURES.length; i++) {
                if (ux.indexOf(UX_FEATURES[i]) < 0) { ux.push(UX_FEATURES[i]); n++; }
            }
        }
        if (opt.forceUSRegion) {
            set('isEURegion', false);
            set('isCopilotEnabledRegion', true);
            set('isCodexEnabledRegion', true);
        }
        return n;
    }

    // 许可对象：消费级资格、业务对话与授权状态一并置为已开通
    function patchEntitlements(data, opt, isMsa) {
        if (!data || typeof data !== 'object') return 0;
        var n = 0;
        function set(k, v) { if (data[k] !== v) { data[k] = v; n++; } }

        if (opt.unlockFeatures) {
            set('isUserConsumerCopilotEligible', true);
            set('isOpalEligible', true);
            set('HasCopilotAI', true);
            set('HasCopilotBusinessChat', true);
            set('userCopilotUserSetting', true);
            set('IsLicensed', true);
            if (!data.userCopilotEligibilityV3 || typeof data.userCopilotEligibilityV3 !== 'object') {
                data.userCopilotEligibilityV3 = {};
                n++;
            }
            n += patchEligibility(data.userCopilotEligibilityV3, opt, isMsa);

            var app = data.copilotAppDefinition;
            if (!app || typeof app !== 'object') { app = data.copilotAppDefinition = {}; n++; }
            if (!app.titleDefinition || typeof app.titleDefinition !== 'object') { app.titleDefinition = {}; n++; }
            if (!app.titleDefinition.eligibility || typeof app.titleDefinition.eligibility !== 'object') {
                app.titleDefinition.eligibility = {};
                n++;
            }
            n += patchEligibility(app.titleDefinition.eligibility, opt, isMsa);
        } else if (opt.forceUSRegion) {
            // 即便不解锁功能，地区标记也要落到已存在的资格对象里
            if (data.userCopilotEligibilityV3 && typeof data.userCopilotEligibilityV3 === 'object') {
                n += patchEligibility(data.userCopilotEligibilityV3, opt, isMsa);
            }
            var a2 = data.copilotAppDefinition;
            if (a2 && a2.titleDefinition && a2.titleDefinition.eligibility) {
                n += patchEligibility(a2.titleDefinition.eligibility, opt, isMsa);
            }
        }
        return n;
    }

    // 导航补全：缺 Chat / Cowork 时补上（企业租户不改导航）
    function ensureNavTabs(navTabs, isMsa) {
        if (!Array.isArray(navTabs) || isMsa) return 0;
        var n = 0;
        for (var i = 0; i < NAV_TABS.length; i++) {
            var want = NAV_TABS[i];
            var has = false;
            for (var j = 0; j < navTabs.length; j++) {
                if (navTabs[j] && navTabs[j].id === want.id) { has = true; break; }
            }
            if (!has) { navTabs.push(cloneTab(want)); n++; }
        }
        return n;
    }

    function cloneTab(t) {
        var o = {};
        for (var k in t) o[k] = t[k];
        return o;
    }

    // 路由水合数据：资格 → 应用入口 → 功能开关 → 导航，逐块容错
    function patchStore(store, opt) {
        if (!store || typeof store !== 'object') return 0;
        var isMsa = !!(store.appsConfig && store.appsConfig.isMsaUser);
        var n = 0;
        n += patchEligibility(store.eligibility, opt, isMsa);
        if (store.eligibility && opt.unlockFeatures && store.eligibility.isOpalEligible !== true) {
            store.eligibility.isOpalEligible = true;
            n++;
        }
        if (store.appsConfig && opt.unlockFeatures) {
            for (var i = 0; i < APPS_TARGETS.length; i++) {
                var k = APPS_TARGETS[i];
                if (store.appsConfig[k] !== true) { store.appsConfig[k] = true; n++; }
            }
        }
        if (store.featureFlags) n += mergeFlags(store.featureFlags, buildFlags(opt));
        if (opt.extraNavTabs) n += ensureNavTabs(store.navTabs, isMsa);
        return n;
    }

    // 身份对象：地区改写（仅当开启地区解锁）
    function patchIdentity(data, opt) {
        if (!data || typeof data !== 'object' || !opt.forceUSRegion) return 0;
        if (data.userCountryCode === 'US') return 0;
        data.userCountryCode = 'US';
        return 1;
    }

    // ======================================================================
    // L5 执行层 · 就地改写宿主 JSON 标签与运行时数据、驱动模型切换
    // ======================================================================

    function pageWin() {
        return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    }

    // 上次写回各标签的文本：宿主未重渲染时跳过解析，避免高频重扫反复 JSON.parse 大对象
    var LAST_TEXT = {};

    // 读 → 改 → 写回；无元素 / 非法 JSON / 无改动 一律不动
    function patchJsonTag(doc, id, mutate) {
        var el = doc.getElementById(id);
        if (!el) { delete LAST_TEXT[id]; return 0; }
        var text = el.textContent;
        if (LAST_TEXT[id] === text) return 0;
        var data = readJson(text);
        if (!data) { LAST_TEXT[id] = text; return 0; }
        var n = 0;
        try { n = mutate(data) | 0; } catch (e) { return 0; }
        if (n > 0) {
            LAST_TEXT[id] = JSON.stringify(data);
            el.textContent = LAST_TEXT[id];
        } else {
            LAST_TEXT[id] = text;
        }
        return n;
    }

    function hydrationStore() {
        var w = pageWin();
        var d = w.__staticRouterHydrationData;
        return (d && d.loaderData && d.loaderData.root && d.loaderData.root.store) || null;
    }

    // 一次完整补丁：标签层 + 水合层，逐块容错，返回改动计数
    function patchConfig(opt) {
        opt = opt || OPT;
        var doc = document;
        var rep = { flags: 0, ent: 0, id: 0, store: 0 };

        rep.flags += patchJsonTag(doc, 'm365ChatFeatureSettings', function (d) {
            return mergeFlags(d, buildFlags(opt));
        });
        rep.ent += patchJsonTag(doc, 'userEntitlements', function (d) {
            return patchEntitlements(d, opt, false);
        });
        rep.id += patchJsonTag(doc, 'identity', function (d) {
            return patchIdentity(d, opt);
        });

        var store = hydrationStore();
        if (store) {
            try { rep.store += patchStore(store, opt); } catch (e) { /* 水合结构随版本变化，失败不影响标签层 */ }
        }

        var total = rep.flags + rep.ent + rep.id + rep.store;
        STATE.patched = { total: total, detail: rep, at: Date.now() };
        return total;
    }

    // ---- 模型切换 ----

    var SEL_SWITCHER = '#gptModeSwitcher, button[aria-label="Model Selector"]';
    var SEL_ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], button';

    var SWITCHER_TIMEOUT_MS = 15000;
    var ITEM_TIMEOUT_MS = 6000;
    var CONFIRM_TIMEOUT_MS = 4000;
    var RUN_ATTEMPTS = 3;

    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function isVisible(el) {
        return !!(el && el.getClientRects && el.getClientRects().length > 0);
    }

    function findSwitcher(doc) {
        return (doc || document).querySelector(SEL_SWITCHER);
    }

    // 精确匹配优先，避免 "gpt" 命中 "gpt-5.6 sol think deeper"
    function findItem(label, doc) {
        var items = [].slice.call((doc || document).querySelectorAll(SEL_ITEMS)).filter(isVisible);
        var want = norm(label);
        if (!want) return null;
        var i;
        for (i = 0; i < items.length; i++) {
            if (norm(items[i].textContent) === want) return items[i];
        }
        for (i = 0; i < items.length; i++) {
            if (norm(items[i].textContent).indexOf(want) === 0) return items[i];
        }
        return null;
    }

    function switcherSays(sw, label) {
        return !!sw && norm(sw.textContent).indexOf(norm(label)) > -1;
    }

    function isOpen(sw) {
        return !!sw && sw.getAttribute('aria-expanded') === 'true';
    }

    function closeMenu(sw) {
        if (!isOpen(sw)) return Promise.resolve();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return sleep(150);
    }

    // 返回 done / already / retry（可安全重试）/ clicked（不要重试）
    async function navigate(opt) {
        var t = targetLabels(resolveTarget(opt));
        if (!t.normed || !t.confirm) return 'retry';

        // 宿主菜单有的版本把「gpt-5.6 sol」写成「gpt 5.6 sol」，两种写法都试
        var candidates = [t.normed];
        var spaced = t.normed.replace(/-/g, ' ');
        if (spaced !== t.normed) candidates.push(spaced);
        var lookup = function () {
            for (var i = 0; i < candidates.length; i++) {
                var hit = findItem(candidates[i]);
                if (hit) return hit;
            }
            return null;
        };

        var sw = await waitFor(function () { return findSwitcher(document); }, SWITCHER_TIMEOUT_MS);
        if (!sw) return 'retry';
        if (switcherSays(sw, t.confirm)) return 'already';

        await closeMenu(sw);
        sw.click();

        // 目标已在顶层菜单里就不展开父项，少点一次少一次失败机会
        if (!lookup()) {
            var parent = await waitFor(function () { return findItem(t.parent); }, 2000);
            if (!parent) {
                await closeMenu(sw);
                await sleep(300);
                sw.click();
                parent = await waitFor(function () { return findItem(t.parent); }, ITEM_TIMEOUT_MS);
            }
            if (!parent) return 'retry';
            parent.click();
        }

        var item = await waitFor(lookup, ITEM_TIMEOUT_MS);
        if (!item) return 'retry';
        item.click();

        var ok = await waitFor(function () {
            return switcherSays(findSwitcher(document), t.confirm) ? true : null;
        }, CONFIRM_TIMEOUT_MS);
        return ok ? 'done' : 'clicked';
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
                if (opt.toastOnSwitch && r !== 'already') {
                    toast(r === 'done' ? '已切换到 ' + resolveTarget(opt) : '模型切换已提交，请确认切换器显示', r === 'done' ? 'ok' : 'warn');
                }
                return r;
            }
            if (attempt < RUN_ATTEMPTS) await sleep(500);
        }
        STATE.lastSwitch = 'failed';
        if (opt.toastOnSwitch) toast('模型自动切换未成功，可稍后重试', 'err');
        return 'failed';
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
        if (!document.body) return;
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

    function statusText() {
        var t = '';
        if (STATE.patched) {
            var d = STATE.patched.detail;
            t = '本页补丁累计改动 <b>' + STATE.patched.total + '</b> 处（开关表 ' + d.flags +
                ' / 许可 ' + d.ent + ' / 地区 ' + d.id + ' / 水合 ' + d.store + '）';
        } else {
            t = '本页尚未执行补丁';
        }
        if (!OPT.autoSelectModel) return t + '；自动选模型已关闭';
        if (!shouldAutoSelect(location.href)) return t + '；本页不是对话页，不自动选模型';
        var last = STATE.lastSwitch;
        var map = { done: '已切换', already: '本已是目标档位', clicked: '已提交切换', failed: '切换未成功', off: '已关闭', skip: '本页跳过' };
        return t + '；自动选模型：' + (map[last] || '尚未执行');
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
        var reapply = document.createElement('button');
        reapply.className = 'cp-btn';
        reapply.id = 'cp-reapply';
        reapply.textContent = '重新应用';
        var retry = document.createElement('button');
        retry.className = 'cp-btn cp-primary';
        retry.id = 'cp-retry-model';
        retry.textContent = '重新选择模型';
        foot.appendChild(reapply);
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
        var el = document.getElementById('cp-status');
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
            if (t.closest('#cp-reapply')) {
                var n = patchConfig(OPT);
                refreshStatus();
                toast(n > 0 ? '已重新应用补丁（' + n + ' 处改动）' : '补丁已是最新状态', n > 0 ? 'ok' : 'info');
                return;
            }
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
            patchConfig(OPT);
            if (name === 'autoSelectModel' && v === true) autoSelect(OPT);
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

    // 路由钩子：SPA 每次改 __routePath 都复检补丁（宿主按路由重读水合数据）
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
                        patchConfig(OPT);
                    }, 120);
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
                patchConfig(OPT);   // 宿主按路由重挂标签时补上；文本未变则被 LAST_TEXT 短路
                if (uiBuilt) refreshStatus();
            }, 400);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ======================================================================
    // 启动序列 · loadOpts → 早期补丁 → (DOMContentLoaded) 面板事件/监听 → 自动选模型
    // ======================================================================

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('打开设置面板', openPanel);
    }

    function startModel() {
        if (!OPT.autoSelectModel) return;
        if (!shouldAutoSelect(location.href)) return;
        autoSelect(OPT);
    }

    function start() {
        bindPanelEvents();
        patchConfig(OPT);
        hookRoute();
        watch();
        startModel();
    }

    function boot() {
        loadOpts();
        patchConfig(OPT);          // document-start：标签可能尚未解析，无元素即安静跳过
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
        VERSION: VERSION, PREFIX: PREFIX, GROUPS: GROUPS, OPT_DEFS: OPT_DEFS,
        FLAG_TABLE: FLAG_TABLE, UX_FEATURES: UX_FEATURES, NAV_TABS: NAV_TABS, STATE: STATE,
        readOpt: readOpt, saveOpt: saveOpt, loadOpts: loadOpts,
        norm: norm, readJson: readJson, hostKind: hostKind, shouldAutoSelect: shouldAutoSelect,
        confirmLabelFor: confirmLabelFor, targetLabels: targetLabels, resolveTarget: resolveTarget,
        buildFlags: buildFlags, mergeFlags: mergeFlags, patchEligibility: patchEligibility,
        patchEntitlements: patchEntitlements, patchStore: patchStore, patchIdentity: patchIdentity,
        ensureNavTabs: ensureNavTabs, patchJsonTag: patchJsonTag, patchConfig: patchConfig,
        findSwitcher: findSwitcher, findItem: findItem, switcherSays: switcherSays,
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
