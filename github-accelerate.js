// ==UserScript==
// @name         GitHub 加速助手
// @namespace    https://github.com/EFate
// @version      0.1.0
// @description  GitHub 镜像加速下载：多源节点发现、并发测速、场景化下载按钮注入、四级下载策略链（兼容 Gopeed 等下载接管工具）。
// @author       EFate
// @license      MIT
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%232da44e'/%3E%3Crect x='14.7' y='6.2' width='2.6' height='9.6' rx='1.3' fill='%23fff'/%3E%3Cpath d='M9.4 15.2h13.2l-6.6 6.8z' fill='%23fff'/%3E%3Crect x='9.2' y='22.4' width='13.6' height='2.5' rx='1.25' fill='%23fff' opacity='.85'/%3E%3Ccircle cx='24.5' cy='8' r='5.8' fill='%23000' opacity='.22'/%3E%3Cpath d='M25.7 4 22.4 8.9h2.1l-1.6 2.9 3-4.8h-1.9z' fill='%23fff'/%3E%3C/svg%3E
// @match        *://github.com/*
// @match        *://gist.github.com/*
// @match        *://*.github.com/*
// @connect      api.akams.cn
// @connect      github.com
// @connect      codeload.github.com
// @connect      raw.githubusercontent.com
// @connect      *
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_openInTab
// @grant        GM_addStyle
// @grant        GM_info
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * ============================================================================
 *  GitHub 加速助手 · 架构总览（单文件，自顶向下分层，禁止跨层反向依赖）
 * ============================================================================
 *
 *   L1  CONFIG      常量、存储键、默认设置、注入场景规则表（唯一事实来源）
 *   L2  FOUNDATION  Utils 格式化 · Store 持久化 · Icons 内联 SVG · Log
 *   L3  NETWORK     gmRequest · 节点多源降级 · 并发测速
 *   L4  STATE       NodeStore（节点/可见集合/时间戳，变更即广播）
 *   L5  CAPABILITY  Downloader 四级策略链 · Injector 规则表驱动
 *   L6  VIEW        Launcher(左中) · Panel(节点/注入/设置) · DlModal · Toast
 *   L7  BOOTSTRAP   装配与生命周期
 *
 */

(function () {
    'use strict';

    if (window.__ghBoostInjected) return;
    window.__ghBoostInjected = true;

    /* ======================================================================
     * L1 · CONFIG —— 常量、存储键、默认设置、注入场景规则表
     * ==================================================================== */

    const NS = 'ghBoost';
    const VERSION = 'v' + (GM_info.script.version || '1.0.0');
    const AUTHOR = 'EFate';
    const TAG = '[' + NS + ']';

    const K = {
        settings: NS + '_settings',
        nodes: NS + '_nodes',
        visible: NS + '_visible',
        updatedAt: NS + '_updated_at',
        fails: NS + '_fails'
    };

    const NODE_TTL = 60 * 60 * 1000;      // 节点缓存 1 小时
    const NODE_FAIL_LIMIT = 2;            // 连续失败 N 次后剔除候选
    const NODE_RETRY_MAX = 4;             // 自动下载最多轮换几个节点
    const PROBE_TIMEOUT = 4000;           // 单节点测速超时
    const PROBE_CONCURRENCY = 8;          // 并发测速路数
    const GM_ACK_TIMEOUT = 8000;          // GM_download 回执等待上限
    const ERROR_PAGE_MAX = 64 * 1024;     // 小于此体积的 text/html 视为镜像错误页
    const LATENCY_FAST = 300;             // 延迟分档（ms）
    const LATENCY_MID = 800;
    const LATENCY_SCALE = 1500;           // 进度条满格基准
    const INJECT_DEBOUNCE = 260;          // 注入防抖
    const INJECT_INTERVAL = 5000;         // 兜底轮询

    /**
     * 节点接口源：按序尝试，哪家活着用哪家，无单点。
     * 两家返回格式不同，各自配解析器（见 L3 的 parseAkams / parseMxg）：
     *   api.akams.cn/github   → {code:200, data:[{url, speed}]}           speed = 延迟 ms
     *   git.mxg.pub/…/list    → {data:[{name, url, status, latency}]}     status: success/failed
     */
    const NODES_APIS = [
        { url: 'https://api.akams.cn/github', parse: parseAkams },
        { url: 'https://git.mxg.pub/api/github/list', parse: parseMxg }
    ];

    // 网络全断时的最后保险：只做连通性测速，不依赖任何第三方接口
    const LAST_RESORT_NODES = [
        'https://gh-proxy.com/',
        'https://ghproxy.net/',
        'https://gh.llkk.cc/',
        'https://hub.ddayh.com/',
        'https://gh.con.sh/',
        'https://ghproxy.053000.xyz/'
    ];

    const METHODS = [
        { id: 'auto', label: '自动（推荐）', desc: '逐个镜像试可靠通道，失败自动换下一个；全部失败才盲发兜底' },
        { id: 'blob', label: 'Blob 中转', desc: '下载到内存再交给浏览器，Gopeed 可接管，有进度' },
        { id: 'gm', label: 'GM_download', desc: '脚本管理器通道，省内存但下载工具可能接不住' },
        { id: 'anchor', label: '直连链接', desc: '零内存，依赖镜像返回 Content-Disposition' },
        { id: 'tab', label: '新标签页', desc: '打开链接由浏览器自行处理' }
    ];

    // 注入场景规则表：新增/调整位置只改这里，注入器是通用执行器
    const SCENARIOS = [
        {
            key: 'release-zip',
            label: 'Release 压缩包',
            desc: 'Release 页面的 Source code (zip / tar.gz)',
            defaultOn: true,
            selector: 'a[href*="codeload.github.com"], a[href*="/archive/refs/"], a[href*="/zipball/"], a[href*="/tarball/"]',
            container: (a) => a.closest('li, .Box-row, tr') || a.parentElement,
            name: (a) => a.textContent.trim() || 'Source code'
        },
        {
            key: 'release-asset',
            label: 'Release 附件',
            desc: 'Release 页面上传的二进制附件',
            defaultOn: true,
            selector: 'a[href*="/releases/download/"], a[href*="/releases/expanded_assets/"]',
            container: (a) => a.closest('.Box-row, li, tr') || a.parentElement,
            name: (a) => a.textContent.trim()
        },
        {
            key: 'raw-file',
            label: 'Raw 原始文件',
            desc: '文件查看页的原始文件按钮',
            defaultOn: true,
            selector: '#raw-url, a[id="raw-url"], a[href*="/raw/"][href*="githubusercontent.com"], .js-blob-dropdown-content a[href*="raw"]',
            container: (a) => a.parentElement,
            name: (a) => a.textContent.trim() || 'Raw'
        },
        {
            key: 'clone-zip',
            label: 'Clone 弹框 ZIP',
            desc: '仓库页 Code 下拉框里的 Download ZIP',
            defaultOn: true,
            selector: 'details a[href*="codeload.github.com"], details a[href*="/archive/refs/"]',
            container: (a) => a.closest('li') || a.parentElement,
            name: () => 'Download ZIP'
        },
        {
            key: 'repo-archive',
            label: '仓库 Code 按钮',
            desc: '仓库主页 Code 下拉中的源码包',
            defaultOn: true,
            selector: 'a[data-ga-click*="download"], [data-view-component] a[href*="codeload.github.com"]',
            container: (a) => a.closest('li, .liststyle-none') || a.parentElement,
            name: () => 'Source code'
        },
        {
            key: 'lfs-file',
            label: 'LFS 大文件',
            desc: 'Git LFS 托管的大文件链接',
            defaultOn: true,
            selector: 'a[href*="/info/lfs/objects/"], table a[href*="lfs"]',
            container: (a) => a.closest('tr, li, .Box-row') || a.parentElement,
            name: (a) => a.textContent.trim()
        },
        {
            key: 'gist-raw',
            label: 'Gist 原始文件',
            desc: 'Gist 代码片段的 Raw 链接',
            defaultOn: true,
            hosts: ['gist.github.com'],
            selector: 'a[href*="/raw/"], .btn[href*="raw"]',
            container: (a) => a.parentElement,
            name: (a) => a.textContent.trim() || 'Raw'
        },
        {
            key: 'compare-diff',
            label: 'Patch / Diff',
            desc: 'Compare 与提交页面的 .patch / .diff',
            defaultOn: true,
            selector: 'a[href$=".patch"], a[href$=".diff"], a[href*=".patch?"], a[href*=".diff?"]',
            container: (a) => a.closest('li, .Box-row, .dropdown-item') || a.parentElement,
            name: (a) => a.textContent.trim() || 'Patch'
        },
        {
            key: 'generic',
            label: '通用兜底',
            desc: '其它带 download 属性的 GitHub 链接',
            defaultOn: true,
            selector: 'a[download][href*="github"]',
            container: (a) => a.closest('li, .Box-row, tr') || a.parentElement,
            name: (a) => a.textContent.trim()
        }
    ];

    const DEFAULT_INJECT = SCENARIOS.reduce((acc, s) => {
        acc[s.key] = s.defaultOn;
        return acc;
    }, {});

    const DEFAULT_SETTINGS = {
        method: 'auto',
        blobMaxMB: 300,
        refreshOnStart: true,
        showLauncher: true,
        askNode: true,                    // 下载时是否弹出节点选择弹窗
        launcherPos: null,
        lastTab: 'nodes',
        inject: Object.assign({}, DEFAULT_INJECT)
    };

    /** 设置的唯一读写口：load 负责与默认值合并，set 负责落盘 */
    const Settings = {
        data: Object.assign({}, DEFAULT_SETTINGS),

        load() {
            const saved = Store.read(K.settings, {}) || {};
            this.data = Object.assign({}, DEFAULT_SETTINGS, saved);
            this.data.inject = Object.assign({}, DEFAULT_INJECT, saved.inject || {});
            return this.data;
        },
        get() { return this.data; },
        set(patch) {
            Object.assign(this.data, patch);
            Store.write(K.settings, this.data);
        },
        setInject(key, on) {
            this.data.inject[key] = on;
            Store.write(K.settings, this.data);
        },
        reset() {
            this.data = Object.assign({}, DEFAULT_SETTINGS, { inject: Object.assign({}, DEFAULT_INJECT) });
            Store.write(K.settings, this.data);
        }
    };

    /* ======================================================================
     * L2 · FOUNDATION —— 日志、工具、持久化、图标
     * ==================================================================== */

    const Log = {
        info: (...a) => console.log(TAG, ...a),
        warn: (...a) => console.warn(TAG, ...a),
        error: (...a) => console.error(TAG, ...a)
    };

    const Utils = {
        esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        },
        shortDomain(url) {
            try {
                const h = new URL(url).hostname.replace(/^www\./, '');
                const p = h.split('.');
                return p.length > 2 ? p.slice(-2).join('.') : h;
            } catch {
                return String(url || '').slice(0, 24);
            }
        },
        filenameFromUrl(url) {
            try {
                const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
                const clean = name.replace(/[\\/:*?"<>|]/g, '_');
                if (clean) return clean;
            } catch { /* fallthrough */ }
            return 'download.bin';
        },
        bytes(n) {
            if (!n || n < 0) return '';
            const u = ['B', 'KB', 'MB', 'GB'];
            let i = 0;
            while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
            return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
        },
        level(ms) {
            if (ms < LATENCY_FAST) return 'fast';
            if (ms < LATENCY_MID) return 'mid';
            return 'slow';
        },
        pct(ms) {
            return Math.max(2, Math.min(100, (ms / LATENCY_SCALE) * 100));
        },
        clock(ts) {
            if (!ts) return '—';
            return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        },
        sleep(ms) {
            return new Promise((r) => setTimeout(r, ms));
        },
        /** 剪贴板：优先异步 API，失败回落到 execCommand */
        async copy(text) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch { /* fallthrough */ }
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                ta.remove();
                return ok;
            } catch {
                return false;
            }
        }
    };

    const Store = {
        read(key, fallback) {
            try {
                const v = GM_getValue(key);
                return (v === undefined || v === null) ? fallback : v;
            } catch {
                return fallback;
            }
        },
        write(key, val) {
            try { GM_setValue(key, val); } catch (e) { Log.warn('写入失败', key, e); }
        },
        remove(key) {
            try { if (typeof GM_deleteValue === 'function') GM_deleteValue(key); } catch { /* noop */ }
        }
    };

    // 全部内联 SVG：规避 GitHub CSP 的 img-src 限制，也不再依赖任何外域图片
    const Icons = {
        mark: '<svg viewBox="0 0 32 32" aria-hidden="true">' +
            '<rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="#2da44e"/>' +
            '<rect x="14.7" y="6.2" width="2.6" height="9.6" rx="1.3" fill="#fff"/>' +
            '<path d="M9.4 15.2h13.2l-6.6 6.8z" fill="#fff"/>' +
            '<rect x="9.2" y="22.4" width="13.6" height="2.5" rx="1.25" fill="#fff" opacity=".85"/>' +
            '<circle cx="24.5" cy="8" r="5.8" fill="#0d1117" opacity=".22"/>' +
            '<path d="M25.7 4 22.4 8.9h2.1l-1.6 2.9 3-4.8h-1.9z" fill="#fff"/></svg>',
        refresh: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
        close: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
        download: '<svg viewBox="0 0 24 24"><path d="M11 3h2v8h3l-4 4-4-4h3V3zM4 19h16v2H4z"/></svg>',
        copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/></svg>',
        bolt: '<svg viewBox="0 0 24 24"><path d="M14 2 5 13h5l-1 9 9-11h-5l1-9z"/></svg>',
        search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
        sliders: '<svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>',
        reset: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
        grip: '<svg viewBox="0 0 24 24"><path d="M9 4h2v2H9V4zm0 7h2v2H9v-2zm0 7h2v2H9v-2zm4-14h2v2h-2V4zm0 7h2v2h-2v-2zm0 7h2v2h-2v-2z"/></svg>',
        check: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
    };

    /* ======================================================================
     * L3 · NETWORK —— Promise 化的 GM_xmlhttpRequest + 多源节点 + 并发测速
     * ==================================================================== */

    function gmRequest(opt) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opt.method || 'GET',
                url: opt.url,
                headers: opt.headers || {},
                responseType: opt.responseType || 'text',
                timeout: opt.timeout || 30000,
                onprogress: opt.onProgress || undefined,
                onload(res) {
                    if (res.status >= 200 && res.status < 400) resolve(res);
                    else reject(new Error('HTTP ' + res.status));
                },
                onerror: () => reject(new Error('网络不可达')),
                ontimeout: () => reject(new Error('请求超时'))
            });
        });
    }

    /** 单节点测速：返回 { url, ok, ms } */
    function probeOne(url) {
        return new Promise((resolve) => {
            const start = Date.now();
            const target = url + (url.includes('?') ? '&' : '?') + '_=' + start + Math.random();
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                resolve({ url, ok, ms: Date.now() - start });
            };
            GM_xmlhttpRequest({
                method: 'GET',
                url: target,
                timeout: PROBE_TIMEOUT,
                onload: () => finish(true),
                onerror: () => finish(false),
                ontimeout: () => finish(false)
            });
        });
    }

    /** 并发测速：成功节点按延迟升序 */
    function probeMany(urls) {
        return new Promise((resolve) => {
            const out = [];
            const queue = urls.slice();
            let active = 0;
            let settled = false;

            const done = () => {
                if (settled) return;
                settled = true;
                resolve(out
                    .filter((r) => r.ok)
                    .sort((a, b) => a.ms - b.ms)
                    .map((r) => ({ url: r.url, latency: r.ms })));
            };

            const next = () => {
                while (active < PROBE_CONCURRENCY && queue.length) {
                    active++;
                    probeOne(queue.shift()).then((r) => {
                        out.push(r);
                        active--;
                        next();
                    });
                }
                if (active === 0 && queue.length === 0) done();
            };

            next();
            setTimeout(done, 30000); // 安全网：30 秒强制收口
        });
    }

    /** akams.cn：{code:200, data:[{url, speed}]}，speed = 延迟 ms（0/缺失视为无效） */
    function parseAkams(data) {
        if (!data || data.code !== 200 || !Array.isArray(data.data)) {
            throw new Error('akams 格式异常');
        }
        return data.data
            .map((n) => n && n.url ? { url: n.url, latency: Number(n.speed) || 0 } : null)
            .filter((n) => n && n.latency > 0 && n.latency < LATENCY_SCALE)
            .sort((a, b) => a.latency - b.latency);
    }

    /** mxg.pub：{data:[{name, url, status, latency}]}，只留 status=success 的（latency 为 ms） */
    function parseMxg(data) {
        if (!data || !Array.isArray(data.data)) {
            throw new Error('mxg.pub 格式异常');
        }
        return data.data
            .filter((n) => n && n.url && n.status === 'success'
                && n.latency > 0 && n.latency < LATENCY_SCALE)
            .map((n) => ({ url: n.url, latency: n.latency }))
            .sort((a, b) => a.latency - b.latency);
    }

    /** 接口源按序尝试：首个成功的源生效，两家格式不同各自解析 */
    async function nodesFromApi() {
        let lastErr = new Error('无可用节点接口');
        for (const api of NODES_APIS) {
            try {
                const res = await gmRequest({ url: api.url, timeout: 12000 });
                const data = typeof res.response === 'string' ? JSON.parse(res.response) : res.response;
                const list = api.parse(data);
                if (!list.length) throw new Error('接口返回空节点列表');
                return list;
            } catch (e) {
                lastErr = e;
                Log.warn('节点接口不可用 →', api.url, '(', e.message, ')');
            }
        }
        throw lastErr;
    }

    async function nodesFromProbe() {
        const list = await probeMany(LAST_RESORT_NODES);
        if (!list.length) throw new Error('内置节点全部不可达');
        return list;
    }

    /* ======================================================================
     * L4 · STATE —— NodeStore：唯一数据源，变更广播给视图层
     * ==================================================================== */

    const NodeStore = {
        nodes: [],
        visible: [],
        updatedAt: 0,
        fails: {},           // url → 连续失败次数（持久化，镜像失效的自我记忆）
        subs: [],

        subscribe(fn) { this.subs.push(fn); },
        emit() { this.subs.forEach((fn) => { try { fn(); } catch (e) { Log.warn('订阅回调异常', e); } }); },

        hydrate() {
            const cached = Store.read(K.nodes, []);
            if (Array.isArray(cached) && cached.length) {
                this.nodes = cached.filter((n) => n && n.url);
                this.updatedAt = Store.read(K.updatedAt, 0);
            }
            this.visible = Store.read(K.visible, []);
            this.fails = Store.read(K.fails, {}) || {};
            this.pruneVisible();
            if (!this.visible.length && this.nodes.length) this.resetVisible();
        },

        pruneVisible() {
            const valid = new Set(this.nodes.map((n) => n.url));
            this.visible = this.visible.filter((u) => valid.has(u));
        },

        resetVisible() {
            this.visible = this.nodes.slice(0, 10).map((n) => n.url);
            Store.write(K.visible, this.visible);
        },

        setNodes(list) {
            const prev = this.nodes;
            this.nodes = Array.isArray(list) ? list.filter((n) => n && n.url) : [];
            if (this.nodes.length) {
                this.updatedAt = Date.now();
                Store.write(K.nodes, this.nodes);
                Store.write(K.updatedAt, this.updatedAt);
                this.pruneVisible();
                if (!this.visible.length) this.resetVisible();
            } else {
                // 全部来源失败：保留旧节点，绝不把界面清空
                this.nodes = prev;
            }
            this.emit();
        },

        setVisible(list) {
            this.visible = list.slice();
            Store.write(K.visible, this.visible);
            this.emit();
        },

        /** 下载成功：清零该节点的失败计数 */
        markOk(url) {
            if (!(url in this.fails)) return;
            delete this.fails[url];
            Store.write(K.fails, this.fails);
        },

        /**
         * 下载失败：计数 +1。
         * 全军覆没时清空记忆——否则所有节点都会被永久剔除，再也回不到候选里。
         */
        markFail(url) {
            this.fails[url] = (this.fails[url] || 0) + 1;
            const anyAlive = this.nodes.some((n) => (this.fails[n.url] || 0) < NODE_FAIL_LIMIT);
            if (!anyAlive) this.fails = {};
            Store.write(K.fails, this.fails);
        },

        /**
         * 候选镜像：纯查询，无副作用。
         * 先剔除连续失败超限的，再按用户勾选过滤；都没勾选则退回延迟最低的 10 个。
         */
        candidates() {
            const alive = this.nodes.filter((n) => (this.fails[n.url] || 0) < NODE_FAIL_LIMIT);
            const pool = alive.length ? alive : this.nodes;
            const picked = pool.filter((n) => this.visible.includes(n.url));
            return picked.length ? picked : pool.slice(0, 10);
        },

        isStale() {
            return !this.nodes.length || (Date.now() - this.updatedAt > NODE_TTL);
        }
    };

    /** 节点加载：API → 内置连通测速 → 保留旧值 */
    async function loadNodes(reason) {
        try {
            NodeStore.setNodes(await nodesFromApi());
            Log.info(reason + '刷新：接口返回 ' + NodeStore.nodes.length + ' 个节点');
            return true;
        } catch (e) {
            Log.warn(reason + '刷新：接口失败 →', e.message);
        }
        try {
            NodeStore.setNodes(await nodesFromProbe());
            Log.info(reason + '刷新：内置测速得到 ' + NodeStore.nodes.length + ' 个节点');
            return true;
        } catch (e) {
            Log.warn(reason + '刷新：内置测速失败 →', e.message);
        }
        NodeStore.emit();
        return false;
    }

    /* ======================================================================
     * L5-a · CAPABILITY —— Downloader：策略链 + 镜像轮转
     *
     * 策略分两类，这是下载层能否自愈的关键：
     *   可回执 verified：blob / gm   —— 成功拿得到字节或回调，失败抛得出错
     *   盲  发 blind   ：anchor / tab —— 点了就走，永远拿不到结果
     * 镜像轮转只能在「可回执」策略上进行：盲发一旦参与单节点链路，
     * 任何坏镜像都会被伪装成成功，轮转分支将永远执行不到。
     * ==================================================================== */

    /** GitHub 原链 + 镜像前缀 → 镜像直链 */
    function mirrorUrl(githubUrl, nodeUrl) {
        if (!githubUrl || !nodeUrl) return '';
        return String(nodeUrl).replace(/\/+$/, '') + '/' + String(githubUrl).replace(/^\/+/, '');
    }

    /**
     * 通过原生 <a download> 触发浏览器下载。
     * 关键点：Gopeed 之类的扩展拦截的是浏览器原生下载事件，
     * 所以只要走这条通道，就一定会被接管到。
     */
    function clickAnchor(href, filename) {
        const a = document.createElement('a');
        a.href = href;
        if (filename) a.download = filename;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
    }

    function remoteSize(url) {
        return gmRequest({ url, method: 'HEAD', timeout: 8000 }).then((res) => {
            const m = /content-length:\s*(\d+)/i.exec(res.responseHeaders || '');
            return m ? parseInt(m[1], 10) : -1;
        }).catch(() => -1);
    }

    const Strategies = {
        /** ① 默认：Blob 中转 → 同源 objectURL → a[download]，有进度、有文件名 */
        async blob(url, filename, onProgress) {
            const limit = (Settings.get().blobMaxMB || 300) * 1024 * 1024;
            if (limit > 0) {
                const size = await remoteSize(url);
                if (size > limit) throw new Error('文件 ' + Utils.bytes(size) + ' 超过 Blob 上限，改用下一级策略');
            }
            const res = await gmRequest({
                url,
                responseType: 'blob',
                timeout: 600000,
                onProgress: (p) => {
                    if (p && p.lengthComputable) onProgress(p.loaded, p.total);
                }
            });
            let blob = res.response;
            if (!(blob instanceof Blob)) blob = new Blob([blob], { type: 'application/octet-stream' });
            if (!blob.size) throw new Error('镜像返回空内容');
            // 镜像挂掉时常返回 200 + HTML 错误页：识别出来判为失败，才能触发换节点
            if (blob.size <= ERROR_PAGE_MAX) {
                const head = (await blob.slice(0, 512).text()).trim().toLowerCase();
                if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
                    throw new Error('镜像返回错误页而非文件');
                }
            }
            const objectUrl = URL.createObjectURL(blob);
            clickAnchor(objectUrl, filename);
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
            return { ok: true, method: 'blob', size: blob.size, hint: '已交给浏览器下载' };
        },

        /** ② GM_download：挂满回执，超时按「存疑」处理，绝不谎报成功 */
        gm(url, filename, onProgress) {
            if (typeof GM_download !== 'function') throw new Error('GM_download 不可用');
            return new Promise((resolve, reject) => {
                let settled = false;
                let timer = null;
                const ok = (result) => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    resolve(result);
                };
                const fail = (message) => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    reject(new Error(message));
                };
                // 超时应判定为「存疑」而不是成功——这正是旧版谎报「开始下载」的地方
                timer = setTimeout(() => {
                    ok({ ok: true, method: 'gm', unsure: true, hint: '未收到浏览器回执' });
                }, GM_ACK_TIMEOUT);
                try {
                    GM_download({
                        url,
                        name: filename,
                        saveAs: false,
                        onprogress: (p) => { if (p && p.lengthComputable) onProgress(p.loaded, p.total); },
                        onload: () => ok({ ok: true, method: 'gm', hint: '下载完成' }),
                        onerror: (e) => fail('GM_download 失败：' + ((e && e.error) || '未知错误')),
                        ontimeout: () => fail('GM_download 超时')
                    });
                } catch (e) {
                    fail('GM_download 调用异常：' + ((e && e.message) || '未知'));
                }
            });
        },

        /** ③ 直连：零内存，成败取决于镜像是否返回 Content-Disposition */
        anchor(url, filename) {
            clickAnchor(url, filename);
            return Promise.resolve({ ok: true, method: 'anchor', hint: '已交给浏览器处理' });
        },

        /** ④ 最后可见出路 */
        tab(url) {
            if (typeof GM_openInTab === 'function') GM_openInTab(url, { active: false, insert: true });
            else window.open(url, '_blank', 'noopener');
            return Promise.resolve({ ok: true, method: 'tab', hint: '已在新标签页打开' });
        }
    };

    /** 可回执策略：轮转镜像时只跑这两级，失败才说明这个镜像真的不行 */
    const VERIFIED_CHAIN = ['blob', 'gm'];
    /** 盲发策略：拿不到任何结果，只能当作最后的一次性出路 */
    const BLIND_CHAIN = ['anchor', 'tab'];
    /** 单节点全量链路：用户已手动选定镜像时，给它每一级机会 */
    const FULL_CHAIN = VERIFIED_CHAIN.concat(BLIND_CHAIN);

    const Downloader = {
        /**
         * 在【单个镜像】上按 chain 依次尝试，任一级成功即返回。
         * @param chain 缺省时按设置推导；显式传入则由调用方决定（轮转用可回执链）
         * @returns {Promise<{ok:boolean, method?:string, hint?:string, unsure?:boolean, size?:number, error?:string, trace:string[]}>}
         */
        async run(url, filename, onProgress, chain) {
            const wanted = Settings.get().method || 'auto';
            const ids = Array.isArray(chain) && chain.length
                ? chain
                : (wanted === 'auto' ? FULL_CHAIN : [wanted]);
            const trace = [];
            const noop = () => {};

            for (const id of ids) {
                const fn = Strategies[id];
                if (!fn) continue;
                try {
                    const r = await fn(url, filename, onProgress || noop);
                    trace.push(id + ' ✓');
                    return Object.assign({}, r, { trace });
                } catch (e) {
                    trace.push(id + ' ✗ ' + e.message);
                    Log.warn('下载策略 ' + id + ' 失败 →', e.message);
                }
            }
            return { ok: false, error: '该镜像上所有可用方式均失败', trace };
        },

        /**
         * 自动模式：两阶段。
         *   阶段一 逐个候选镜像跑“可回执”链路，成功即停，失败记入健康度并换下一个；
         *   阶段二 所有镜像都拿不到可靠回执时，才用最快那个做一次“盲发”兜底。
         * @returns Promise<{ok, nodeUrl?, blind?, error?, trace:string[]}>
         */
        async runAuto(githubUrl, filename, hooks) {
            hooks = hooks || {};
            if (!NodeStore.nodes.length) await loadNodes('自动下载');
            const list = NodeStore.candidates().slice(0, NODE_RETRY_MAX);
            if (!list.length) return { ok: false, error: '没有可用镜像节点', trace: [] };
            const trace = [];

            for (let i = 0; i < list.length; i++) {
                const node = list[i];
                if (hooks.onNode) hooks.onNode(node, i + 1, list.length, false);
                const r = await this.run(mirrorUrl(githubUrl, node.url), filename, hooks.onProgress, VERIFIED_CHAIN);
                if (r.ok) {
                    NodeStore.markOk(node.url);
                    return Object.assign({ nodeUrl: node.url }, r, { trace: trace.concat(r.trace || []) });
                }
                NodeStore.markFail(node.url);
                trace.push(Utils.shortDomain(node.url) + ' ✗ ' + (r.error || '失败'));
            }

            const best = list[0];
            if (hooks.onNode) hooks.onNode(best, list.length, list.length, true);
            const last = await this.run(mirrorUrl(githubUrl, best.url), filename, hooks.onProgress, BLIND_CHAIN);
            if (last.ok) {
                return Object.assign({ nodeUrl: best.url, blind: true }, last, { trace: trace.concat(last.trace || []) });
            }
            return {
                ok: false,
                error: '已尝试 ' + list.length + ' 个镜像，均未拿到有效回执',
                trace: trace.concat(last.trace || [])
            };
        }
    };

    /* ======================================================================
     * L5-b · CAPABILITY —— Injector：规则表驱动，无硬编码 if/else 分支
     * ==================================================================== */

    const Injector = {
        timer: null,

        activeScenarios() {
            const cfg = Settings.get().inject;
            const host = location.hostname;
            return SCENARIOS.filter((s) => {
                if (!cfg[s.key]) return false;
                if (s.hosts && !s.hosts.includes(host)) return false;
                return true;
            });
        },

        build(githubUrl, filename) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ghb-dl-btn';
            btn.title = '镜像加速下载';
            btn.dataset.ghbUrl = githubUrl;
            btn.setAttribute('aria-label', '镜像加速下载');
            btn.innerHTML = Icons.download + '<span>镜像下载</span>';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                View.download(githubUrl, filename || Utils.filenameFromUrl(githubUrl));
            });
            return btn;
        },

        attach(container, link, scenario) {
            if (!container || !link || !link.href) return;
            if (container.querySelector(':scope > .ghb-dl-btn')) return;
            const href = link.href;
            if (!/github\.com|githubusercontent\.com|codeload\.github\.com/.test(href)) return;
            const name = scenario.name(link) || Utils.filenameFromUrl(href);
            container.appendChild(this.build(href, name));
        },

        run() {
            this.activeScenarios().forEach((s) => {
                let links;
                try {
                    links = document.querySelectorAll(s.selector);
                } catch {
                    return;
                }
                links.forEach((link) => {
                    this.attach(s.container(link), link, s);
                });
            });
        },

        schedule(delay) {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.run(), delay || 0);
        },

        start() {
            this.schedule(400);

            // GitHub 是 SPA：监听路由变化与相关 DOM 增量
            let lastHref = location.href;
            const mo = new MutationObserver((records) => {
                if (location.href !== lastHref) {
                    lastHref = location.href;
                    this.schedule(700);
                    return;
                }
                const relevant = records.some((m) => {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        const html = (node.outerHTML || '').toLowerCase();
                        if (html.includes('download') || html.includes('release') ||
                            html.includes('archive') || html.includes('raw') ||
                            html.includes('codeload')) return true;
                    }
                    return false;
                });
                if (relevant) this.schedule(INJECT_DEBOUNCE);
            });
            mo.observe(document.body, { childList: true, subtree: true });
            setInterval(() => this.schedule(), INJECT_INTERVAL);
        }
    };

    /* ======================================================================
     * L6 · VIEW —— 样式表 / 启动器 / 面板 / 下载弹窗 / Toast
     * ==================================================================== */

    const CSS = `
/* 主题色挂在 html 上：注入到页面里的按钮与 toast 不在 .ghb-scope 内，
   同样需要读到这些变量；明暗切换直接跟随 GitHub 的 data-color-mode */
html{
  --ghb-accent:#2da44e; --ghb-accent-2:#1a7f37; --ghb-accent-fg:#ffffff;
  --ghb-good:#2da44e; --ghb-warn:#d29922; --ghb-bad:#f85149;
}
html[data-color-mode="light"]{
  --ghb-accent:#1a7f37; --ghb-accent-2:#116329;
}
.ghb-scope{
  --ghb-bg:#0d1117; --ghb-bg-2:#161b22; --ghb-bg-3:#21262d;
  --ghb-bd:#30363d; --ghb-bd-2:#21262d;
  --ghb-fg:#e6edf3; --ghb-fg-2:#8b949e; --ghb-fg-3:#6e7681;
  --ghb-shadow:0 16px 44px rgba(0,0,0,.5);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  color:var(--ghb-fg); font-size:13px; line-height:1.5;
}
.ghb-scope.ghb-light{
  --ghb-bg:#ffffff; --ghb-bg-2:#f6f8fa; --ghb-bg-3:#eaeef2;
  --ghb-bd:#d0d7de; --ghb-bd-2:#d8dee4;
  --ghb-fg:#1f2328; --ghb-fg-2:#59636e; --ghb-fg-3:#818b98;
  --ghb-shadow:0 16px 44px rgba(31,35,40,.16);
}
.ghb-scope svg{width:1em;height:1em;fill:currentColor;flex:none;vertical-align:-.125em;}

/* ---------- 启动器：左侧中部，可拖拽，不占右下角 ---------- */
#ghb-launcher{
  position:fixed; left:0; top:50%; transform:translateY(-50%);
  z-index:2147483000; display:flex; align-items:center; gap:6px;
  padding:8px 12px 8px 9px; border:none; border-radius:0 12px 12px 0;
  background:var(--ghb-accent); color:#fff; cursor:pointer;
  box-shadow:0 6px 20px rgba(0,0,0,.32);
  transition:background .18s, box-shadow .18s, filter .18s;
  font-family:inherit; font-size:13px; font-weight:500; line-height:1;
}
#ghb-launcher:hover{background:var(--ghb-accent-2); box-shadow:0 8px 26px rgba(0,0,0,.4);}
#ghb-launcher.ghb-dragging{cursor:grabbing; filter:brightness(1.08); user-select:none;}
#ghb-launcher .ghb-lau-mark{width:22px;height:22px;display:block;}
#ghb-launcher .ghb-lau-mark svg{width:22px;height:22px;}
#ghb-launcher .ghb-lau-grip{width:12px;height:22px;opacity:.55;}
#ghb-launcher .ghb-lau-grip svg{width:12px;height:22px;}

/* ---------- 遮罩 ---------- */
#ghb-overlay{
  position:fixed; inset:0; z-index:2147483001;
  background:rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .2s;
}
#ghb-overlay.ghb-open{opacity:1; pointer-events:auto;}

/* ---------- 面板：居中，三 Tab ---------- */
#ghb-panel{
  position:fixed; left:50%; top:50%; z-index:2147483002;
  width:460px; max-width:calc(100vw - 32px); max-height:84vh;
  background:var(--ghb-bg); border:1px solid var(--ghb-bd);
  border-radius:14px; box-shadow:var(--ghb-shadow);
  display:flex; flex-direction:column; overflow:hidden;
  opacity:0; transform:translate(-50%,-46%) scale(.97); pointer-events:none;
  transition:opacity .22s, transform .22s cubic-bezier(.4,0,.2,1);
}
#ghb-panel.ghb-open{opacity:1; transform:translate(-50%,-50%) scale(1); pointer-events:auto;}

.ghb-head{display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid var(--ghb-bd-2); flex:none;}
.ghb-head .ghb-mark{width:24px;height:24px;}
.ghb-head .ghb-mark svg{width:24px;height:24px;}
.ghb-head h2{margin:0; font-size:15px; font-weight:600; color:var(--ghb-fg);}
.ghb-head .ghb-ver{font-size:11px; color:var(--ghb-fg-2); border:1px solid var(--ghb-bd); border-radius:999px; padding:1px 7px;}
.ghb-head .ghb-spacer{flex:1;}
.ghb-icon-btn{
  width:28px; height:28px; display:flex; align-items:center; justify-content:center;
  border:none; border-radius:6px; background:transparent; color:var(--ghb-fg-2);
  cursor:pointer; font-size:16px; transition:background .15s, color .15s;
}
.ghb-icon-btn:hover{background:var(--ghb-bg-3); color:var(--ghb-fg);}

.ghb-tabs{display:flex; border-bottom:1px solid var(--ghb-bd-2); flex:none; background:var(--ghb-bg-2);}
.ghb-tab{
  flex:1; padding:10px 0; border:none; background:transparent; cursor:pointer;
  font-family:inherit; font-size:13px; color:var(--ghb-fg-2);
  border-bottom:2px solid transparent; transition:color .15s, background .15s;
}
.ghb-tab:hover{color:var(--ghb-fg); background:var(--ghb-bg-3);}
.ghb-tab.ghb-on{color:var(--ghb-fg); font-weight:600; border-bottom-color:var(--ghb-accent);}

.ghb-body{flex:1; overflow-y:auto; min-height:180px;}
.ghb-body::-webkit-scrollbar{width:8px;}
.ghb-body::-webkit-scrollbar-thumb{background:var(--ghb-bd); border-radius:4px;}
.ghb-page{display:none;}
.ghb-page.ghb-on{display:block;}

.ghb-status{
  display:flex; align-items:center; gap:8px; padding:10px 16px;
  font-size:12px; color:var(--ghb-fg-2); border-bottom:1px solid var(--ghb-bd-2);
  background:var(--ghb-bg-2);
}
.ghb-dot{width:8px;height:8px;border-radius:50%;background:var(--ghb-fg-3);flex:none;}
.ghb-dot.ghb-online{background:var(--ghb-good);}
.ghb-dot.ghb-offline{background:var(--ghb-bad);}
.ghb-status .ghb-tail{margin-left:auto; color:var(--ghb-fg-3);}

.ghb-toolbar{display:flex; flex-wrap:wrap; gap:6px; padding:10px 16px; border-bottom:1px solid var(--ghb-bd-2);}
.ghb-btn{
  display:inline-flex; align-items:center; gap:5px; padding:5px 10px;
  border:1px solid var(--ghb-bd); border-radius:6px; background:var(--ghb-bg-3);
  color:var(--ghb-fg); font-family:inherit; font-size:12px; cursor:pointer;
  white-space:nowrap; transition:background .15s, border-color .15s, opacity .15s;
}
.ghb-btn:hover{background:var(--ghb-bd); border-color:var(--ghb-fg-3);}
.ghb-btn[disabled]{opacity:.5; pointer-events:none;}
.ghb-btn.ghb-primary{background:var(--ghb-accent); border-color:var(--ghb-accent); color:var(--ghb-accent-fg);}
.ghb-btn.ghb-primary:hover{background:var(--ghb-accent-2);}
.ghb-btn.ghb-danger:hover{background:var(--ghb-bad); border-color:var(--ghb-bad); color:#fff;}
.ghb-btn svg{font-size:14px;}
.ghb-spin{animation:ghb-spin 1s linear infinite;}
@keyframes ghb-spin{to{transform:rotate(360deg);}}

.ghb-field{display:flex; align-items:center; gap:8px; padding:6px 16px 10px;}
.ghb-input{
  flex:1; min-width:0; padding:6px 9px; border:1px solid var(--ghb-bd);
  border-radius:6px; background:var(--ghb-bg-2); color:var(--ghb-fg);
  font-family:inherit; font-size:13px;
}
.ghb-input:focus{outline:none; border-color:var(--ghb-accent);}

.ghb-list{padding:4px 0;}
.ghb-row{display:flex; align-items:center; gap:10px; padding:8px 16px; transition:background .12s;}
.ghb-row:hover{background:var(--ghb-bg-2);}
.ghb-cb{position:relative; width:16px; height:16px; flex:none; cursor:pointer;}
.ghb-cb input{position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; z-index:1;}
.ghb-cb span{
  display:block; width:16px; height:16px; border:1.5px solid var(--ghb-bd);
  border-radius:4px; background:var(--ghb-bg); transition:background .15s, border-color .15s;
}
.ghb-cb input:checked + span{background:var(--ghb-accent); border-color:var(--ghb-accent);}
.ghb-cb input:checked + span::after{
  content:''; display:block; width:4px; height:8px; margin:1px 0 0 4.5px;
  border:solid #fff; border-width:0 2px 2px 0; transform:rotate(45deg);
}
.ghb-main{flex:1; min-width:0;}
.ghb-name{font-size:13px; color:var(--ghb-fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.ghb-meta{display:flex; align-items:center; gap:6px; margin-top:3px; font-size:11px; color:var(--ghb-fg-2);}
.ghb-bar{height:3px; width:64px; border-radius:2px; background:var(--ghb-bg-3); overflow:hidden; flex:none;}
.ghb-bar i{display:block; height:100%; border-radius:2px;}
.ghb-tag{font-size:11px; padding:1px 6px; border-radius:999px; border:1px solid var(--ghb-bd); color:var(--ghb-fg-2);}
/* 文字色与进度条填充色分开，避免 .ghb-tag 被染成同色背景 */
.ghb-t-fast{color:var(--ghb-good);}
.ghb-t-mid{color:var(--ghb-warn);}
.ghb-t-slow{color:var(--ghb-bad);}
.ghb-f-fast{background:var(--ghb-good);}
.ghb-f-mid{background:var(--ghb-warn);}
.ghb-f-slow{background:var(--ghb-bad);}

.ghb-empty{padding:32px 16px; text-align:center; color:var(--ghb-fg-2); font-size:13px;}
.ghb-empty small{display:block; margin-top:6px; color:var(--ghb-fg-3);}
.ghb-hint{padding:10px 16px; font-size:12px; color:var(--ghb-fg-2); border-bottom:1px solid var(--ghb-bd-2); background:var(--ghb-bg-2);}

.ghb-setting{display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--ghb-bd-2);}
.ghb-setting:last-child{border-bottom:none;}
.ghb-setting .ghb-label{flex:1; min-width:0;}
.ghb-setting .ghb-lt{display:block; font-size:13px; font-weight:500; color:var(--ghb-fg);}
.ghb-setting .ghb-ld{display:block; font-size:11px; color:var(--ghb-fg-2); margin-top:2px;}
.ghb-switch{position:relative; width:40px; height:22px; flex:none; cursor:pointer;}
.ghb-switch input{position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; z-index:1;}
.ghb-switch i{
  display:block; width:40px; height:22px; border-radius:11px;
  background:var(--ghb-bd); transition:background .22s; position:relative;
}
.ghb-switch i::after{
  content:''; position:absolute; top:3px; left:3px; width:16px; height:16px;
  border-radius:50%; background:#fff; transition:transform .22s cubic-bezier(.4,0,.2,1);
}
.ghb-switch input:checked + i{background:var(--ghb-accent);}
.ghb-switch input:checked + i::after{transform:translateX(18px);}
.ghb-select, .ghb-num{
  padding:5px 8px; border:1px solid var(--ghb-bd); border-radius:6px;
  background:var(--ghb-bg-2); color:var(--ghb-fg); font-family:inherit; font-size:12px;
}
.ghb-num{width:72px; text-align:right;}

.ghb-select:focus, .ghb-num:focus{outline:none; border-color:var(--ghb-accent);}
.ghb-inline{display:flex; align-items:center; gap:6px; flex:none;}

.ghb-about{padding:14px 16px; font-size:12px; color:var(--ghb-fg-2); border-top:1px solid var(--ghb-bd-2);}
.ghb-about b{color:var(--ghb-fg); font-weight:600;}

.ghb-foot{
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:8px 16px; border-top:1px solid var(--ghb-bd-2);
  background:var(--ghb-bg-2); font-size:11px; color:var(--ghb-fg-3); flex:none;
}

/* ---------- 下载弹窗 ---------- */
#ghb-dl{
  position:fixed; inset:0; z-index:2147483003; display:flex;
  align-items:center; justify-content:center;
  opacity:0; pointer-events:none; transition:opacity .2s;
}
#ghb-dl.ghb-open{opacity:1; pointer-events:auto;}
#ghb-dl .ghb-dl-bg{position:absolute; inset:0; background:rgba(0,0,0,.6);}
#ghb-dl .ghb-card{
  position:relative; width:440px; max-width:calc(100vw - 32px); max-height:80vh;
  background:var(--ghb-bg); border:1px solid var(--ghb-bd); border-radius:14px;
  box-shadow:var(--ghb-shadow); display:flex; flex-direction:column; overflow:hidden;
  transform:translateY(10px) scale(.98); transition:transform .22s cubic-bezier(.4,0,.2,1);
}
#ghb-dl.ghb-open .ghb-card{transform:none;}
.ghb-file{padding:10px 16px; background:var(--ghb-bg-2); border-bottom:1px solid var(--ghb-bd-2); flex:none;}
.ghb-file .ghb-f1{font-size:11px; color:var(--ghb-fg-2);}
.ghb-file .ghb-f2{font-size:13px; font-weight:600; color:var(--ghb-fg); word-break:break-all; margin-top:2px;}
.ghb-file .ghb-f3{display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap;}
.ghb-seg{display:flex; gap:4px; padding:10px 16px; border-bottom:1px solid var(--ghb-bd-2); flex:none; flex-wrap:wrap;}
.ghb-seg button{
  padding:4px 9px; border:1px solid var(--ghb-bd); border-radius:999px;
  background:transparent; color:var(--ghb-fg-2); font-family:inherit; font-size:12px; cursor:pointer;
}
.ghb-seg button:hover{border-color:var(--ghb-fg-3); color:var(--ghb-fg);}
.ghb-seg button.ghb-on{background:var(--ghb-accent); border-color:var(--ghb-accent); color:var(--ghb-accent-fg);}
.ghb-prog{padding:0 16px; flex:none;}
.ghb-prog.ghb-hide{display:none;}
.ghb-prog .ghb-p1{display:flex; justify-content:space-between; font-size:11px; color:var(--ghb-fg-2); padding-top:10px;}
.ghb-prog .ghb-p2{height:5px; border-radius:3px; background:var(--ghb-bg-3); overflow:hidden; margin:5px 0 10px;}
.ghb-prog .ghb-p2 i{display:block; height:100%; width:0; background:var(--ghb-accent); transition:width .2s;}
.ghb-nodes{flex:1; overflow-y:auto; padding:4px 0; min-height:120px;}
.ghb-nodes::-webkit-scrollbar{width:8px;}
.ghb-nodes::-webkit-scrollbar-thumb{background:var(--ghb-bd); border-radius:4px;}
.ghb-nrow{display:flex; align-items:center; gap:8px; padding:8px 16px;}
.ghb-nrow:hover{background:var(--ghb-bg-2);}
.ghb-nrow .ghb-nd{flex:1; min-width:0; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}

/* ---------- 页面注入的下载按钮 ---------- */
.ghb-dl-btn{
  display:inline-flex; align-items:center; gap:4px; margin-left:6px;
  padding:2px 8px; border:1px solid var(--ghb-accent); border-radius:5px;
  background:transparent; color:var(--ghb-accent); font-family:inherit;
  font-size:12px; font-weight:500; line-height:1.5; cursor:pointer;
  vertical-align:middle; white-space:nowrap; flex:none; transition:background .15s, color .15s;
}
.ghb-dl-btn:hover{background:var(--ghb-accent); color:var(--ghb-accent-fg);}
.ghb-dl-btn svg{width:12px; height:12px; fill:currentColor;}

/* ---------- Toast ---------- */
#ghb-toasts{position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:2147483004; display:flex; flex-direction:column; gap:8px; align-items:center; pointer-events:none;}
.ghb-toast{
  display:flex; align-items:center; gap:8px; max-width:min(560px, calc(100vw - 32px));
  padding:9px 14px; border-radius:8px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  font-size:13px; color:#fff; box-shadow:0 6px 20px rgba(0,0,0,.35);
  opacity:0; transform:translateY(12px); transition:opacity .22s, transform .22s;
}
.ghb-toast.ghb-show{opacity:1; transform:none;}
.ghb-toast.ghb-info{background:#1f6feb;}
.ghb-toast.ghb-ok{background:var(--ghb-good);}
.ghb-toast.ghb-warn{background:#9e6a03;}
.ghb-toast.ghb-err{background:#b62324;}
.ghb-toast.ghb-prog{flex-direction:column; align-items:stretch; gap:6px; min-width:280px;}
.ghb-toast.ghb-prog .ghb-ptext{white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.ghb-toast.ghb-prog .ghb-pbar{display:block; height:3px; border-radius:2px; background:rgba(255,255,255,.85); width:3%; transition:width .25s;}
`;

    const View = {
        el: {},

        /* ---------- 主题跟随 GitHub 明暗模式 ---------- */
        theme() {
            const mode = document.documentElement.getAttribute('data-color-mode');
            if (mode === 'light' || mode === 'dark') return mode;
            return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        },
        applyTheme() {
            const light = this.theme() === 'light';
            [this.el.launcher, this.el.panel, this.el.dl].forEach((n) => {
                if (n) n.classList.toggle('ghb-light', light);
            });
        },

        mount() {
            GM_addStyle(CSS);

            const launcher = document.createElement('button');
            launcher.id = 'ghb-launcher';
            launcher.className = 'ghb-scope';
            launcher.type = 'button';
            launcher.title = 'GitHub 加速助手（点击打开面板，按住可拖拽）';
            launcher.innerHTML =
                '<span class="ghb-lau-grip">' + Icons.grip + '</span>' +
                '<span class="ghb-lau-mark">' + Icons.mark + '</span>' +
                '<span class="ghb-lau-text">加速</span>';
            document.body.appendChild(launcher);

            const overlay = document.createElement('div');
            overlay.id = 'ghb-overlay';
            document.body.appendChild(overlay);

            const panel = document.createElement('div');
            panel.id = 'ghb-panel';
            panel.className = 'ghb-scope';
            document.body.appendChild(panel);

            const dl = document.createElement('div');
            dl.id = 'ghb-dl';
            dl.className = 'ghb-scope';
            dl.innerHTML =
                '<div class="ghb-dl-bg"></div>' +
                '<div class="ghb-card">' +
                '  <div class="ghb-head">' +
                '    <span class="ghb-mark">' + Icons.mark + '</span>' +
                '    <h2>镜像加速下载</h2>' +
                '    <span class="ghb-spacer"></span>' +
                '    <button class="ghb-icon-btn" id="ghb-dl-refresh" title="刷新节点">' + Icons.refresh + '</button>' +
                '    <button class="ghb-icon-btn" id="ghb-dl-close" title="关闭">' + Icons.close + '</button>' +
                '  </div>' +
                '  <div class="ghb-file">' +
                '    <div class="ghb-f1">下载文件</div>' +
                '    <div class="ghb-f2" id="ghb-dl-name">-</div>' +
                '    <div class="ghb-f3">' +
                '      <button class="ghb-btn ghb-primary" id="ghb-dl-fast">' + Icons.bolt + '最快节点下载</button>' +
                '      <button class="ghb-btn" id="ghb-dl-copy">' + Icons.copy + '复制链接</button>' +
                '    </div>' +
                '  </div>' +
                '  <div class="ghb-seg" id="ghb-dl-methods"></div>' +
                '  <div class="ghb-prog ghb-hide" id="ghb-dl-prog">' +
                '    <div class="ghb-p1"><span id="ghb-dl-ptext">准备中…</span><span id="ghb-dl-psize"></span></div>' +
                '    <div class="ghb-p2"><i id="ghb-dl-pbar"></i></div>' +
                '  </div>' +
                '  <div class="ghb-nodes" id="ghb-dl-nodes"></div>' +
                '  <div class="ghb-foot"><span>' + VERSION + '</span><span>作者 ' + AUTHOR + '</span></div>' +
                '</div>';
            document.body.appendChild(dl);

            const toasts = document.createElement('div');
            toasts.id = 'ghb-toasts';
            document.body.appendChild(toasts);

            Object.assign(this.el, { launcher, overlay, panel, dl, toasts });
            this.applyTheme();

            const mo = new MutationObserver(() => this.applyTheme());
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode', 'data-dark-theme', 'data-light-theme'] });

            this.Panel.mount(panel);
            this.DlModal.mount(dl);
            this.bindLauncher(launcher, overlay);
        },

        bindLauncher(launcher, overlay) {
            let dragged = false;
            launcher.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                const r = launcher.getBoundingClientRect();
                const sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top;
                let moved = false;
                launcher.classList.add('ghb-dragging');

                const onMove = (ev) => {
                    const dx = ev.clientX - sx, dy = ev.clientY - sy;
                    if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
                    moved = true;
                    launcher.style.transform = 'none';
                    launcher.style.left = Math.max(0, Math.min(window.innerWidth - r.width, ox + dx)) + 'px';
                    launcher.style.top = Math.max(0, Math.min(window.innerHeight - r.height, oy + dy)) + 'px';
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    launcher.classList.remove('ghb-dragging');
                    if (moved) {
                        dragged = true;
                        Settings.set({ launcherPos: { left: launcher.style.left, top: launcher.style.top } });
                        setTimeout(() => { dragged = false; }, 0);
                    }
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
                e.preventDefault();
            });

            launcher.addEventListener('click', () => {
                if (dragged) return;
                this.Panel.toggle();
            });
            overlay.addEventListener('click', () => this.Panel.toggle());
        },

        restoreLauncherPos() {
            const pos = Settings.get().launcherPos;
            const l = this.el.launcher;
            if (pos && pos.left && pos.top) {
                l.style.transform = 'none';
                l.style.left = pos.left;
                l.style.top = pos.top;
            }
            this.applyLauncherVisible();
        },

        /** 启动器显示状态的唯一写入口：设置项、DOM、面板勾选框三者同步 */
        setLauncherVisible(on) {
            Settings.set({ showLauncher: !!on });
            this.applyLauncherVisible();
        },

        applyLauncherVisible() {
            const on = !!Settings.get().showLauncher;
            if (this.el.launcher) this.el.launcher.style.display = on ? 'flex' : 'none';
            const cb = document.getElementById('ghb-s-launcher');
            if (cb) cb.checked = on;
        },

        /** 下载方式的唯一写入口：设置项、设置页下拉框、下载弹窗按钮三处同步 */
        setMethod(id) {
            Settings.set({ method: id });
            const sel = document.getElementById('ghb-s-method');
            if (sel) sel.value = id;
            const desc = document.getElementById('ghb-s-method-desc');
            if (desc) desc.textContent = this.Panel.methodDesc(id);
            if (this.DlModal.root) {
                this.DlModal.renderMethods();
                this.DlModal.renderNodes(); // 同步刷新弹窗右上角的节点计数
            }
        },

        /** 统一下载入口：弹窗手选 或 全自动最快节点，由设置 askNode 决定 */
        download(githubUrl, filename) {
            const name = filename || Utils.filenameFromUrl(githubUrl);
            if (!githubUrl) { this.Toast.err('链接无效'); return; }
            if (Settings.get().askNode) this.DlModal.open(githubUrl, name);
            else this.autoDownload(githubUrl, name);
        },

        /** 全自动：轮换镜像直到成功，进度用常驻 Toast 反馈，不打扰页面 */
        async autoDownload(githubUrl, filename) {
            if (this._autoBusy) { this.Toast.warn('已有下载任务在进行中'); return; }
            this._autoBusy = true;
            const prog = this.Toast.progress('正在选择最快镜像…');
            const r = await Downloader.runAuto(githubUrl, filename, {
                onNode: (node, i, n) =>
                    prog.update(0, '(' + i + '/' + n + ') 连接 ' + Utils.shortDomain(node.url) + '…'),
                onProgress: (l, t) => prog.update(t ? (l / t) * 100 : 0,
                    '下载中 ' + (t ? Math.round((l / t) * 100) + '%' : '…') + ' · ' + filename)
            });
            this._autoBusy = false;
            if (r.ok && r.unsure) {
                prog.warn('已提交下载但未收到回执，若无反应可开启「节点选择弹窗」重试');
            } else if (r.ok) {
                prog.ok('已交给浏览器下载 · ' + filename + '（' + Utils.shortDomain(r.nodeUrl) + '）');
            } else {
                prog.err(r.error + '｜可在设置开启节点弹窗手动重试');
            }
        },

        /* ---------- Toast ---------- */
        Toast: {
            host() {
                let h = document.getElementById('ghb-toasts');
                if (!h) {
                    h = document.createElement('div');
                    h.id = 'ghb-toasts';
                    document.body.appendChild(h);
                }
                return h;
            },

            show(msg, kind, ms) {
                // 懒创建：初始化完成前的提示不会被静默丢弃
                const host = this.host();
                const t = document.createElement('div');
                t.className = 'ghb-toast ghb-' + (kind || 'info');
                t.textContent = msg;
                host.appendChild(t);
                requestAnimationFrame(() => t.classList.add('ghb-show'));
                setTimeout(() => {
                    t.classList.remove('ghb-show');
                    setTimeout(() => t.remove(), 260);
                }, ms || (kind === 'err' ? 4200 : 2400));
            },

            /** 常驻进度条提示：全自动下载时替代弹窗的反馈载体 */
            progress(text) {
                const t = document.createElement('div');
                t.className = 'ghb-toast ghb-info ghb-prog';
                t.innerHTML = '<span class="ghb-ptext"></span><i class="ghb-pbar"></i>';
                t.querySelector('.ghb-ptext').textContent = text;
                this.host().appendChild(t);
                requestAnimationFrame(() => t.classList.add('ghb-show'));
                let gone = false;
                const close = () => {
                    if (gone) return;
                    gone = true;
                    t.classList.remove('ghb-show');
                    setTimeout(() => t.remove(), 260);
                };
                return {
                    update(pct, msg) {
                        if (gone) return;
                        t.querySelector('.ghb-ptext').textContent = msg || text;
                        t.querySelector('.ghb-pbar').style.width =
                            Math.max(3, Math.min(100, pct || 0)) + '%';
                    },
                    ok(msg) { close(); View.Toast.ok(msg); },
                    warn(msg) { close(); View.Toast.warn(msg); },
                    err(msg) { close(); View.Toast.err(msg); }
                };
            },

            ok: (m) => View.Toast.show(m, 'ok'),
            warn: (m) => View.Toast.show(m, 'warn'),
            err: (m) => View.Toast.show(m, 'err'),
            info: (m) => View.Toast.show(m, 'info')
        },

        /* ---------- 管理面板 ---------- */
        Panel: {
            open: false,
            tab: 'nodes',
            root: null,

            mount(root) {
                this.root = root;
                root.innerHTML =
                    '<div class="ghb-head">' +
                    '  <span class="ghb-mark">' + Icons.mark + '</span>' +
                    '  <h2>GitHub 加速助手</h2>' +
                    '  <span class="ghb-ver">' + VERSION + '</span>' +
                    '  <span class="ghb-spacer"></span>' +
                    '  <button class="ghb-icon-btn" id="ghb-panel-close" title="关闭">' + Icons.close + '</button>' +
                    '</div>' +
                    '<div class="ghb-tabs">' +
                    '  <button class="ghb-tab" data-tab="nodes">节点</button>' +
                    '  <button class="ghb-tab" data-tab="inject">注入</button>' +
                    '  <button class="ghb-tab" data-tab="settings">设置</button>' +
                    '</div>' +
                    '<div class="ghb-body">' +
                    '  <div class="ghb-page" id="ghb-page-nodes"></div>' +
                    '  <div class="ghb-page" id="ghb-page-inject"></div>' +
                    '  <div class="ghb-page" id="ghb-page-settings"></div>' +
                    '</div>' +
                    '<div class="ghb-foot"><span>作者 ' + AUTHOR + '</span><span id="ghb-panel-count"></span></div>';

                root.querySelector('#ghb-panel-close').addEventListener('click', () => this.toggle());
                root.querySelectorAll('.ghb-tab').forEach((btn) => {
                    btn.addEventListener('click', () => this.switch(btn.dataset.tab));
                });
                this.renderNodesPage();
                this.renderInjectPage();
                this.renderSettingsPage();
                this.switch(Settings.get().lastTab || 'nodes');
            },

            toggle() {
                this.open = !this.open;
                View.el.panel.classList.toggle('ghb-open', this.open);
                View.el.overlay.classList.toggle('ghb-open', this.open);
                if (this.open) this.refresh();
            },

            switch(tab) {
                this.tab = tab;
                Settings.set({ lastTab: tab });
                this.root.querySelectorAll('.ghb-tab').forEach((b) => b.classList.toggle('ghb-on', b.dataset.tab === tab));
                this.root.querySelectorAll('.ghb-page').forEach((p) => p.classList.toggle('ghb-on', p.id === 'ghb-page-' + tab));
            },

            refresh() {
                this.renderNodesPage();
                this.renderInjectPage();
                this.renderSettingsPage();
            },

            renderNodesPage() {
                const page = this.root.querySelector('#ghb-page-nodes');
                const nodes = NodeStore.nodes;
                const online = nodes.length > 0;
                const lats = nodes.map((n) => n.latency || 0);
                const summary = online
                    ? nodes.length + ' 个节点 · 最快 ' + Math.min.apply(null, lats) +
                      'ms · 平均 ' + Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) + 'ms'
                    : '暂无可用节点';

                page.innerHTML =
                    '<div class="ghb-status">' +
                    '  <span class="ghb-dot ' + (online ? 'ghb-online' : 'ghb-offline') + '"></span>' +
                    '  <span>' + Utils.esc(summary) + '</span>' +
                    '  <span class="ghb-tail">更新 ' + Utils.clock(NodeStore.updatedAt) + '</span>' +
                    '</div>' +
                    '<div class="ghb-toolbar">' +
                    '  <button class="ghb-btn" id="ghb-n-refresh">' + Icons.refresh + '刷新节点</button>' +
                    '  <button class="ghb-btn" id="ghb-n-probe">' + Icons.bolt + '全部测速</button>' +
                    '  <button class="ghb-btn" id="ghb-n-all">全选</button>' +
                    '  <button class="ghb-btn" id="ghb-n-none">全不选</button>' +
                    '  <button class="ghb-btn" id="ghb-n-top">Top10</button>' +
                    '</div>' +
                    '<div class="ghb-field"><input class="ghb-input" id="ghb-n-filter" placeholder="筛选域名…" value="' +
                        Utils.esc(this.filter || '') + '"></div>' +
                    '<div class="ghb-list" id="ghb-n-list"></div>';

                page.querySelector('#ghb-n-refresh').addEventListener('click', (e) => this.onRefresh(e.currentTarget));
                page.querySelector('#ghb-n-probe').addEventListener('click', (e) => this.onProbe(e.currentTarget));
                page.querySelector('#ghb-n-all').addEventListener('click', () => {
                    NodeStore.setVisible(NodeStore.nodes.map((n) => n.url));
                    View.Toast.info('已全选 ' + NodeStore.nodes.length + ' 个节点');
                });
                page.querySelector('#ghb-n-none').addEventListener('click', () => {
                    NodeStore.setVisible([]);
                    View.Toast.info('已取消全部勾选');
                });
                page.querySelector('#ghb-n-top').addEventListener('click', () => {
                    NodeStore.setVisible(NodeStore.nodes.slice(0, 10).map((n) => n.url));
                    View.Toast.info('已恢复延迟最低的 10 个节点');
                });
                const filter = page.querySelector('#ghb-n-filter');
                filter.addEventListener('input', () => { this.filter = filter.value; this.renderList(); });
                this.renderList();
            },

            renderList() {
                const list = this.root.querySelector('#ghb-n-list');
                if (!list) return;
                const kw = (this.filter || '').trim().toLowerCase();
                const nodes = NodeStore.nodes.filter((n) => !kw || n.url.toLowerCase().includes(kw));

                if (!nodes.length) {
                    list.innerHTML = '<div class="ghb-empty">没有匹配的节点' +
                        (NodeStore.nodes.length ? '' : '<br>正在后台自动获取…') +
                        '<small>也可点击「刷新节点」手动重试</small></div>';
                    return;
                }

                list.innerHTML = nodes.map((n) => {
                    const ms = n.latency || 0;
                    const lv = Utils.level(ms);
                    const on = NodeStore.visible.includes(n.url);
                    return '<div class="ghb-row">' +
                        '<label class="ghb-cb"><input type="checkbox" class="ghb-n-cb" data-url="' + Utils.esc(n.url) + '"' +
                            (on ? ' checked' : '') + '><span></span></label>' +
                        '<div class="ghb-main">' +
                        '  <div class="ghb-name" title="' + Utils.esc(n.url) + '">' + Utils.esc(Utils.shortDomain(n.url)) + '</div>' +
                        '  <div class="ghb-meta ghb-t-' + lv + '"><span class="ghb-bar"><i class="ghb-f-' + lv +
                        '" style="width:' + Utils.pct(ms) + '%"></i></span><span>' + ms + 'ms</span></div>' +
                        '</div>' +
                        '<button class="ghb-btn ghb-n-test" data-url="' + Utils.esc(n.url) + '">测速</button>' +
                        '</div>';
                }).join('');

                list.querySelectorAll('.ghb-n-cb').forEach((cb) => {
                    cb.addEventListener('change', () => {
                        const next = new Set(NodeStore.visible);
                        cb.checked ? next.add(cb.dataset.url) : next.delete(cb.dataset.url);
                        NodeStore.setVisible(Array.from(next));
                    });
                });
                list.querySelectorAll('.ghb-n-test').forEach((b) => {
                    b.addEventListener('click', () => this.onTest(b));
                });

                const count = this.root.querySelector('#ghb-panel-count');
                if (count) count.textContent = '已启用 ' + NodeStore.visible.length + ' / ' + NodeStore.nodes.length;
            },

            async onRefresh(btn) {
                btn.disabled = true;
                btn.querySelector('svg').classList.add('ghb-spin');
                const ok = await loadNodes('手动');
                btn.disabled = false;
                btn.querySelector('svg').classList.remove('ghb-spin');
                ok ? View.Toast.ok('已刷新，共 ' + NodeStore.nodes.length + ' 个节点')
                   : View.Toast.err('刷新失败，请检查网络或稍后重试');
            },

            async onProbe(btn) {
                if (!NodeStore.nodes.length) { View.Toast.warn('暂无节点可测速'); return; }
                btn.disabled = true;
                btn.querySelector('svg').classList.add('ghb-spin');
                const list = await probeMany(NodeStore.nodes.map((n) => n.url));
                btn.disabled = false;
                btn.querySelector('svg').classList.remove('ghb-spin');
                if (!list.length) { View.Toast.err('全部节点均不可达'); return; }
                NodeStore.setNodes(list);
                View.Toast.ok('测速完成，' + list.length + ' 个节点可用');
            },

            onTest(btn) {
                const url = btn.dataset.url;
                const old = btn.textContent;
                btn.disabled = true;
                btn.textContent = '…';
                probeOne(url).then((r) => {
                    btn.textContent = r.ok ? r.ms + 'ms' : '不可达';
                    btn.style.color = r.ok ? 'var(--ghb-good)' : 'var(--ghb-bad)';
                    const node = NodeStore.nodes.find((n) => n.url === url);
                    if (node && r.ok) {
                        node.latency = r.ms;
                        NodeStore.setNodes(NodeStore.nodes.slice().sort((a, b) => a.latency - b.latency));
                    }
                    setTimeout(() => {
                        btn.textContent = old;
                        btn.style.color = '';
                        btn.disabled = false;
                    }, 2600);
                });
            },

            renderInjectPage() {
                const page = this.root.querySelector('#ghb-page-inject');
                const cfg = Settings.get().inject;
                page.innerHTML =
                    '<div class="ghb-hint">控制各位置「镜像下载」按钮的显示。改动立即生效，已渲染的按钮需刷新页面才移除。</div>' +
                    SCENARIOS.map((s) =>
                        '<div class="ghb-setting">' +
                        '  <label class="ghb-label" for="ghb-inj-' + s.key + '">' +
                        '    <span class="ghb-lt">' + Utils.esc(s.label) + '</span>' +
                        '    <span class="ghb-ld">' + Utils.esc(s.desc) + '</span>' +
                        '  </label>' +
                        '  <span class="ghb-switch">' +
                        '    <input type="checkbox" id="ghb-inj-' + s.key + '" data-key="' + s.key + '"' +
                                (cfg[s.key] ? ' checked' : '') + '><i></i>' +
                        '  </span>' +
                        '</div>').join('');

                page.querySelectorAll('.ghb-switch input').forEach((cb) => {
                    cb.addEventListener('change', () => {
                        Settings.setInject(cb.dataset.key, cb.checked);
                        const s = SCENARIOS.find((x) => x.key === cb.dataset.key);
                        View.Toast.info((cb.checked ? '已开启「' : '已关闭「') + (s ? s.label : cb.dataset.key) + '」');
                        Injector.schedule(150);
                    });
                });
            },

            renderSettingsPage() {
                const page = this.root.querySelector('#ghb-page-settings');
                const s = Settings.get();

                page.innerHTML =
                    '<div class="ghb-setting">' +
                    '  <label class="ghb-label" for="ghb-s-method">' +
                    '    <span class="ghb-lt">下载方式</span>' +
                    '    <span class="ghb-ld">' + Utils.esc(this.methodDesc(s.method)) + '</span>' +
                    '  </label>' +
                    '  <select class="ghb-select" id="ghb-s-method">' +
                        METHODS.map((m) => '<option value="' + m.id + '"' + (s.method === m.id ? ' selected' : '') + '>' +
                            Utils.esc(m.label) + '</option>').join('') +
                    '  </select>' +
                    '</div>' +
                    '<div class="ghb-setting">' +
                    '  <label class="ghb-label" for="ghb-s-blob">' +
                    '    <span class="ghb-lt">Blob 体积上限</span>' +
                    '    <span class="ghb-ld">超过该体积跳过 Blob 中转，改用下一级策略；0 表示不限制</span>' +
                    '  </label>' +
                    '  <span class="ghb-inline"><input class="ghb-num" id="ghb-s-blob" type="number" min="0" step="50" value="' +
                        (s.blobMaxMB || 0) + '"><span style="font-size:12px;color:var(--ghb-fg-2)">MB</span></span>' +
                    '</div>' +
                    '<div class="ghb-setting">' +
                    '  <label class="ghb-label" for="ghb-s-autorefresh">' +
                    '    <span class="ghb-lt">启动时刷新节点</span>' +
                    '    <span class="ghb-ld">打开页面时若缓存过期则自动拉取最新节点</span>' +
                    '  </label>' +
                    '  <span class="ghb-switch"><input type="checkbox" id="ghb-s-autorefresh"' +
                        (s.refreshOnStart ? ' checked' : '') + '><i></i></span>' +
                    '</div>' +
                    '<div class="ghb-setting">' +
                    '  <label class="ghb-label" for="ghb-s-launcher">' +
                    '    <span class="ghb-lt">显示侧边启动器</span>' +
                    '    <span class="ghb-ld">关闭后可用油猴菜单「打开加速面板」呼出</span>' +
                    '  </label>' +
                    '  <span class="ghb-switch"><input type="checkbox" id="ghb-s-launcher"' +
                        (s.showLauncher ? ' checked' : '') + '><i></i></span>' +
                    '</div>' +
                    '<div class="ghb-setting">' +
                    '  <label class="ghb-label" for="ghb-s-asknode">' +
                    '    <span class="ghb-lt">下载时弹出节点选择</span>' +
                    '    <span class="ghb-ld">开启：每次下载先弹窗手选镜像；关闭：全自动选最快镜像，失败自动换下一个</span>' +
                    '  </label>' +
                    '  <span class="ghb-switch"><input type="checkbox" id="ghb-s-asknode"' +
                        (s.askNode ? ' checked' : '') + '><i></i></span>' +
                    '</div>' +
                    '<div class="ghb-setting">' +
                    '  <span class="ghb-label"><span class="ghb-lt">恢复默认设置</span>' +
                    '  <span class="ghb-ld">清空节点缓存与全部偏好</span></span>' +
                    '  <button class="ghb-btn ghb-danger" id="ghb-s-reset">' + Icons.reset + '重置</button>' +
                    '</div>' +
                    '<div class="ghb-about">' +
                    '  <b>' + VERSION + '</b> · 作者 ' + AUTHOR + '<br>' +
                    '  下载被 Gopeed / IDM 等工具接管时，推荐「自动」或「Blob 中转」，两者都走浏览器原生下载通道。<br>' +
                    '  若仍无反应，点「复制链接」粘贴进下载工具即可。' +
                    '</div>';

                const sel = page.querySelector('#ghb-s-method');
                sel.addEventListener('change', () => {
                    View.setMethod(sel.value);
                    View.Toast.info('下载方式已切换为「' + sel.options[sel.selectedIndex].text + '」');
                });
                page.querySelector('#ghb-s-blob').addEventListener('change', (e) => {
                    const v = Math.max(0, parseInt(e.target.value, 10) || 0);
                    Settings.set({ blobMaxMB: v });
                    View.Toast.info('Blob 上限已设为 ' + (v ? v + ' MB' : '不限制'));
                });
                page.querySelector('#ghb-s-autorefresh').addEventListener('change', (e) => {
                    Settings.set({ refreshOnStart: e.target.checked });
                });
                page.querySelector('#ghb-s-asknode').addEventListener('change', (e) => {
                    Settings.set({ askNode: e.target.checked });
                    View.Toast.info(e.target.checked
                        ? '下载时将弹出节点选择弹窗'
                        : '已切换为全自动：自动选最快镜像，失败自动换下一个');
                });
    
                page.querySelector('#ghb-s-launcher').addEventListener('change', (e) => {
                    View.setLauncherVisible(e.target.checked);
                    View.Toast.info('侧边启动器已' + (e.target.checked ? '显示' : '隐藏'));
                });
                page.querySelector('#ghb-s-reset').addEventListener('click', () => {
                    Settings.reset();
                    Store.remove(K.nodes);
                    Store.remove(K.visible);
                    Store.remove(K.updatedAt);
                    Store.remove(K.fails);
                    NodeStore.nodes = [];
                    NodeStore.visible = [];
                    NodeStore.updatedAt = 0;
                    NodeStore.fails = {};
                    NodeStore.emit();
                    View.restoreLauncherPos();
                    this.refresh();
                    View.Toast.ok('已恢复默认设置');
                });
            },

            methodDesc(id) {
                const m = METHODS.find((x) => x.id === id);
                return m ? m.desc : '';
            }
        },

        /* ---------- 下载弹窗 ---------- */
        DlModal: {
            url: '',
            name: '',
            busy: false,
            root: null,

            mount(root) {
                this.root = root;
                root.querySelector('.ghb-dl-bg').addEventListener('click', () => this.close());
                root.querySelector('#ghb-dl-close').addEventListener('click', () => this.close());
                root.querySelector('#ghb-dl-refresh').addEventListener('click', (e) => this.onRefresh(e.currentTarget));
                root.querySelector('#ghb-dl-copy').addEventListener('click', () => this.onCopy());
                root.querySelector('#ghb-dl-fast').addEventListener('click', () => this.onFastest());
                root.querySelector('#ghb-dl-nodes').addEventListener('click', (e) => {
                    const b = e.target.closest('.ghb-dl-go');
                    if (b) this.onDownload(b.dataset.node);
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && root.classList.contains('ghb-open')) this.close();
                });
                this.renderMethods();
            },

            renderMethods() {
                const cur = Settings.get().method;
                const host = this.root.querySelector('#ghb-dl-methods');
                host.innerHTML = '<span style="font-size:12px;color:var(--ghb-fg-2);align-self:center;margin-right:2px;">方式</span>' +
                    METHODS.map((m) => '<button data-method="' + m.id + '"' + (m.id === cur ? ' class="ghb-on"' : '') +
                        ' title="' + Utils.esc(m.desc) + '">' + Utils.esc(m.label) + '</button>').join('') +
                    '<span style="flex:1"></span><span id="ghb-dl-count" style="font-size:12px;color:var(--ghb-fg-2);align-self:center"></span>';
                host.querySelectorAll('button[data-method]').forEach((b) => {
                    b.addEventListener('click', () => {
                        Settings.set({ method: b.dataset.method });
                        this.renderMethods();
                        this.renderNodes(); // 同步刷新右上角节点计数
                        View.Toast.info('下载方式：' + b.textContent);
                    });
                });
            },

            open(githubUrl, filename) {
                this.url = githubUrl || '';
                this.name = filename || Utils.filenameFromUrl(githubUrl);
                this.root.querySelector('#ghb-dl-name').textContent = this.name;
                this.renderMethods();
                this.hideProgress();
                this.renderNodes();
                this.root.classList.add('ghb-open');

                if (!NodeStore.nodes.length) loadNodes('弹窗').then(() => this.renderNodes());
            },

            close() {
                if (this.busy) return;
                this.root.classList.remove('ghb-open');
            },

            nodes() { return NodeStore.candidates(); },

            renderNodes() {
                const host = this.root.querySelector('#ghb-dl-nodes');
                const list = this.nodes();
                const count = this.root.querySelector('#ghb-dl-count');
                if (count) count.textContent = list.length + ' 个节点';

                if (!list.length) {
                    host.innerHTML = '<div class="ghb-empty">暂无可用节点<br>正在后台自动获取…' +
                        '<small>可点击右上角刷新按钮重试</small></div>';
                    return;
                }
                host.innerHTML = list.map((n) => {
                    const ms = n.latency || 0;
                    return '<div class="ghb-nrow">' +
                        '<span class="ghb-nd" title="' + Utils.esc(n.url) + '">' + Utils.esc(Utils.shortDomain(n.url)) + '</span>' +
                        '<span class="ghb-tag ghb-t-' + Utils.level(ms) + '">' + ms + 'ms</span>' +
                        '<button class="ghb-btn ghb-dl-go" data-node="' + Utils.esc(n.url) + '">' +
                            Icons.download + '下载</button>' +
                        '</div>';
                }).join('');
            },

            async onRefresh(btn) {
                btn.querySelector('svg').classList.add('ghb-spin');
                btn.disabled = true;
                await loadNodes('弹窗');
                btn.disabled = false;
                btn.querySelector('svg').classList.remove('ghb-spin');
                this.renderNodes();
                View.Toast.info('节点已刷新');
            },

            async onCopy() {
                const list = this.nodes();
                if (!list.length) { View.Toast.warn('暂无节点，无法生成镜像链接'); return; }
                const url = mirrorUrl(this.url, list[0].url);
                const ok = await Utils.copy(url);
                View.Toast.show(ok ? '已复制最快节点链接，可粘贴进下载工具' : '复制失败，请手动复制', ok ? 'ok' : 'err');
            },

            onFastest() {
                const list = this.nodes();
                if (!list.length) { View.Toast.warn('暂无可用节点'); return; }
                this.onDownload(list[0].url);
            },

            showProgress() {
                const p = this.root.querySelector('#ghb-dl-prog');
                p.classList.remove('ghb-hide');
                this.root.querySelector('#ghb-dl-pbar').style.width = '0%';
                this.root.querySelector('#ghb-dl-ptext').textContent = '准备中…';
                this.root.querySelector('#ghb-dl-psize').textContent = '';
            },

            hideProgress() {
                this.root.querySelector('#ghb-dl-prog').classList.add('ghb-hide');
            },

            onProgress(loaded, total) {
                const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
                this.root.querySelector('#ghb-dl-pbar').style.width = pct.toFixed(1) + '%';
                this.root.querySelector('#ghb-dl-ptext').textContent =
                    total ? '下载中 ' + pct.toFixed(0) + '%' : '下载中…';
                this.root.querySelector('#ghb-dl-psize').textContent =
                    Utils.bytes(loaded) + (total ? ' / ' + Utils.bytes(total) : '');
            },

            async onDownload(nodeUrl) {
                if (this.busy) return;
                const target = mirrorUrl(this.url, nodeUrl);
                if (!target) { View.Toast.err('链接拼装失败'); return; }

                this.busy = true;
                this.showProgress();
                this.root.querySelector('#ghb-dl-ptext').textContent = '正在连接 ' + Utils.shortDomain(nodeUrl) + '…';

                const result = await Downloader.run(target, this.name, (l, t) => this.onProgress(l, t));

                this.busy = false;
                this.hideProgress();

                if (!result.ok) {
                    NodeStore.markFail(nodeUrl);
                    View.Toast.err('下载失败：' + result.error + '｜可点「复制链接」手动下载，或在设置开启全自动模式自动换节点');
                    Log.error('下载链路全失败', result.trace);
                    return;
                }
                NodeStore.markOk(nodeUrl);
                if (result.unsure) {
                    View.Toast.warn('已提交下载，但未收到回执：' + result.hint + '。若无反应请改用「Blob 中转」');
                } else {
                    View.Toast.ok('已交给浏览器下载 · ' + this.name +
                        (result.size ? '（' + Utils.bytes(result.size) + '）' : '') +
                        '｜Gopeed 等工具会自动接管');
                }
                this.root.classList.remove('ghb-open');
            }
        }
    };

    /* ======================================================================
     * L7 · BOOTSTRAP
     * ==================================================================== */

    function registerMenu() {
        const items = [
            ['打开加速面板', () => { if (!View.Panel.open) View.Panel.toggle(); }],
            ['刷新镜像节点', () => loadNodes('菜单').then((ok) =>
                ok ? View.Toast.ok('已刷新 ' + NodeStore.nodes.length + ' 个节点') : View.Toast.err('刷新失败'))],
            ['切换侧边启动器', () => {
                const on = !Settings.get().showLauncher;
                View.setLauncherVisible(on);
                View.Toast.info('侧边启动器已' + (on ? '显示' : '隐藏'));
            }],
            ['重置全部设置', () => {
                Settings.reset();
                Store.remove(K.nodes);
                Store.remove(K.visible);
                Store.remove(K.updatedAt);
                Store.remove(K.fails);
                NodeStore.fails = {};
                View.Toast.ok('已重置，刷新页面后生效');
            }]
        ];
        if (typeof GM_registerMenuCommand === 'function') {
            items.forEach(([label, fn]) => GM_registerMenuCommand(label, fn));
        }
    }

    function bootstrap() {
        Settings.load();
        NodeStore.hydrate();

        View.mount();
        View.restoreLauncherPos();

        // 状态变更 → 面板/弹窗自动重绘，无需手工调用刷新
        NodeStore.subscribe(() => {
            View.Panel.renderList();
            View.DlModal.renderNodes();
        });

        registerMenu();
        Injector.start();

        if (NodeStore.isStale() && Settings.get().refreshOnStart) {
            loadNodes('启动');
        } else if (NodeStore.nodes.length) {
            loadNodes('后台'); // 缓存可用，静默更新
        }

        setInterval(() => loadNodes('定时'), NODE_TTL);
    }

    try {
        bootstrap();
    } catch (err) {
        Log.error('初始化失败', err);
    }
})();
