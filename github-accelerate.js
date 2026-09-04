// ==UserScript==
// @name         GitHub 加速 & 增强助手
// @namespace    https://github.com/EFate
// @version      1.4.5
// @description  GitHub 镜像加速下载 + Release 增强显示：多源节点发现（双聚合接口 + 内置公益镜像池兜底）、并发测速、直链交付（只管发射，兼容 Gopeed）；并对 Release 文件分组排序、显示下载量、精确时间、折叠日志。
// @author       EFate
// @license      MIT
// @updateURL    https://gh-proxy.com/https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/github-accelerate.js
// @downloadURL  https://gh-proxy.com/https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/github-accelerate.js
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
// @grant        GM_addStyle
// @grant        GM_info
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * ============================================================================
 *  GitHub 加速助手 · 架构总览（单文件，自顶向下分层，禁止跨层反向依赖）
 * ============================================================================
 *
 *   L1  CONFIG      常量、存储键、默认设置、注入场景规则表、内置镜像池（唯一事实来源）
 *   L2  FOUNDATION  Utils 格式化 · Store 持久化 · Icons 内联 SVG · Log · Arch/Route 纯函数
 *   L3  NETWORK     gmRequest · 节点多源降级 · 并发测速
 *   L4  STATE       Settings(四组偏好) + NodeStore（变更即广播）
 *   L5  CAPABILITY  Downloader 直链交付 · Injector 规则表驱动 · Enhancer 增强显示 · Tools 页面工具
 *   L6  VIEW        Launcher(右中) · Panel(节点/注入/增强/工具/设置) · DlModal · Toast
 *   L7  BOOTSTRAP   装配 · Watcher(SPA 统一重扫，单 MutationObserver 服务全模块) · 菜单
 *
 *   依赖自上而下单向；SPA 重扫统一由 L7 Watcher 驱动 Injector/Enhancer/Tools，
 *   各能力模块只暴露幂等的 run/scan，不再自建监听器。
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
        fails: NS + '_fails',
        lastOk: NS + '_last_ok'
    };

    const NODE_TTL = 60 * 60 * 1000;      // 节点缓存 1 小时
    const NODE_FAIL_LIMIT = 2;            // 连续失败 N 次后剔除候选
    const NODE_RETRY_MAX = 4;             // 自动下载最多轮换几个节点
    const PROBE_TIMEOUT = 4000;           // 单节点测速超时
    const PROBE_CONCURRENCY = 8;          // 并发测速路数
    const HEAD_TIMEOUT = 8000;            // 直链 HEAD 预检超时(冷启动 / 全败兜底)
    const HEAD_TIMEOUT_FAST = 2500;       // 有候选但无 fresh 时的短预检
    const PRECHECK_TTL = 5 * 60 * 1000;   // 5 分钟:命中此窗口的预检成功节点视为 fresh,直接 fire
    const LATENCY_FAST = 300;             // 延迟分档（ms）
    const LATENCY_MID = 800;
    const LATENCY_SCALE = 1500;           // 进度条满格基准
    const LATENCY_UNKNOWN = 99999;        // 内置节点未测速标记（排序沉底，显示「未测速」）
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

    /**
     * 内置镜像池：双聚合接口全挂时的最后保险（本地连通性测速筛选，不依赖任何第三方接口）。
     * 均为长期维护的公益加速源，校验日期 2026-09，失效节点请自行增删。
     * 收录规则：仅收「前缀 + 完整 GitHub URL」兼容格式，可直接参与 mirrorUrl 直链拼装；
     * 路径拼接式 / 专用源（gitclone、jsdelivr 等）与该规则不兼容，未收入。
     */
    const BUILTIN_MIRRORS = [
        // 原 v1.2 兜底六节点
        'https://gh-proxy.com/',
        'https://ghproxy.net/',
        'https://gh.llkk.cc/',
        'https://hub.ddayh.com/',
        'https://gh.con.sh/',
        'https://ghproxy.053000.xyz/',
        // 公益源 · 美国 Cloudflare CDN
        'https://gh.h233.eu.org/',
        'https://gh.ddlc.top/',
        'https://ghproxy.it/',
        'https://github.boki.moe/',
        'https://gh.jasonzeng.dev/',
        'https://gh.monlor.com/',
        'https://github.geekery.cn/',
        'https://github.ednovas.xyz/',
        'https://ghfile.geekertao.top/',
        'https://ghp.keleyaa.com/',
        'https://gh.chjina.com/',
        'https://ghpxy.hwinzniej.top/',
        'https://cdn.crashmc.com/',
        'https://git.yylx.win/',
        'https://gitproxy.mrhjx.cn/',
        'https://ghproxy.cxkpro.top/',
        'https://gh.xxooo.cf/',
        'https://gh.idayer.com/',
        'https://gh.zwy.one/',
        'https://ghproxy.monkeyray.net/',
        // 公益源 · 多区域 / 其他 CDN
        'https://hk.gh-proxy.org/',
        'https://cdn.gh-proxy.org/',
        'https://edgeone.gh-proxy.org/',
        'https://ghfast.top/',
        'https://wget.la/',
        // 查询串拼接式（mirrorUrl 对 ?/& 结尾免斜杠直拼）
        'https://down.npee.cn/?'
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

    const ENHANCE_DEFAULT = {
        groupSort: true,          // 文件按平台分组、按当前系统/架构排序、推荐安装包
        downloadCount: true,      // 显示各 Release 文件下载量（GitHub API）
        replaceTime: false,       // 相对时间 → 精确时间
        collapsibleNotes: true    // 更新日志可折叠
    };

    const TOOLS_DEFAULT = {
        deepwiki: true            // 仓库页顶部注入 DeepWiki 跳转按钮
    };

    const DEFAULT_SETTINGS = {
        refreshOnStart: true,
        showLauncher: true,
        autoDownload: false,              // 全自动下载：开=自动选最快镜像直发（无感）；关=每次下载弹窗手选
        showPageButtons: true,     // GitHub 页面内注入镜像加速按钮的主开关
        launcherPos: null,
        lastTab: 'nodes',
        inject: Object.assign({}, DEFAULT_INJECT),
        enhance: Object.assign({}, ENHANCE_DEFAULT),
        tools: Object.assign({}, TOOLS_DEFAULT)
    };


    /* ======================================================================
     * L2 · FOUNDATION —— 日志、工具、存储原语、图标
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
        check: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
    };
    /* ======================================================================
     * L2-b · FOUNDATION —— 增强显示工具（纯函数，无 DOM 依赖）
     *   纯函数解析逻辑，判定顺序严格保留「先 64 位后 32 位」。
     *   只做「文件名 → 平台/架构/分组」与「当前环境 → OS/架构」的纯计算，
     *   不触碰 DOM；DOM 编排全部在 L5-c 的 Enhancer 中。
     * ==================================================================== */

    const Arch = {
        OS_OPTIONS: [
            { value: 'windows', label: 'Windows' },
            { value: 'mac', label: 'macOS' },
            { value: 'linux', label: 'Linux' },
            { value: 'android', label: 'Android' },
            { value: 'ios', label: 'iOS' }
        ],
        ARCH_OPTIONS: [
            { value: 'x86_64', label: 'x64' },
            { value: 'arm64', label: 'arm64' },
            { value: 'x86', label: 'x86' },
            { value: 'arm32', label: 'arm32' }
        ],

        getCurrentOS() {
            const ua = navigator.userAgent.toLowerCase();
            if (ua.includes('win')) return 'windows';
            if (ua.includes('mac')) return 'mac';
            if (ua.includes('android')) return 'android';
            if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
            if (ua.includes('linux')) return 'linux';
            return 'unknown';
        },

        getCurrentArch() {
            // 优先 User-Agent Client Hints
            if (navigator.userAgentData && navigator.userAgentData.arch) {
                const a = String(navigator.userAgentData.arch).toLowerCase();
                if (a.includes('arm64') || a.includes('aarch64')) return 'arm64';
                if (a === 'arm' || a.includes('arm32') || a.includes('armv7')) return 'arm32';
                if (a.includes('x86_64') || a === 'amd64' || a === 'x64') return 'x86_64';
                if (a.includes('x86') || a.includes('i386') || a.includes('i686')) return 'x86';
            }
            const p = String(navigator.platform || '').toLowerCase();
            const ua = navigator.userAgent.toLowerCase();
            if (p.includes('aarch64') || p.includes('arm64') || ua.includes('aarch64') || ua.includes('arm64')) return 'arm64';
            if (p.includes('win64') || p.includes('x64') || p.includes('x86_64') || ua.includes('win64') || ua.includes('x86_64') || ua.includes('wow64')) return 'x86_64';
            if (p.includes('arm') || ua.includes('armv7') || ua.includes('armhf')) return 'arm32';
            if (p.includes('i386') || p.includes('i686') || ua.includes('i386') || ua.includes('i686')) return 'x86';
            const os = this.getCurrentOS();
            if (os === 'mac') return 'arm64';   // Apple Silicon 已成主流
            return 'x86_64';
        },

        // 从文件名解析架构；判定顺序关键：先 64 位后 32 位（arm64 含 arm、x86_64 含 x86）
        parseFileArch(name) {
            const n = String(name).toLowerCase();
            if (n.includes('aarch64') || n.includes('arm64') || n.includes('armv8')) return 'arm64';
            if (n.includes('x86_64') || n.includes('x64') || n.includes('amd64')) return 'x86_64';
            if (n.includes('riscv64') || n.includes('riscv')) return 'riscv64';
            if (n.includes('armv7') || n.includes('armeabi-v7a') || n.includes('armhf') || n.includes('armv6') || n.includes('armel') || n.includes('armeabi') || /\barm\b/.test(n)) return 'arm32';
            if (n.includes('i386') || n.includes('i686') || n.includes('ia32') || n.includes('x86') || n.includes('32-bit') || n.includes('32bit')) return 'x86';
            if (n.includes('mips64') || n.includes('mipsel') || n.includes('mips')) return 'mips';
            if (n.includes('ppc64') || n.includes('ppc')) return 'ppc';
            if (n.includes('universal')) return 'universal';
            return null;
        },

        parseFileGroup(name) {
            const n = String(name).toLowerCase();
            if (n.endsWith('.sig') || n.endsWith('.sha256') || n.endsWith('.pem') || n.endsWith('.blockmap')) {
                return { id: 'meta', showTag: false };
            }
            if (n.includes('source') || (n.endsWith('.tar.gz') && !n.endsWith('.app.tar.gz') && !n.includes('linux') && !n.includes('mac') && !n.includes('win'))) {
                return { id: 'source', showTag: false };
            }
            if (n.endsWith('.exe') || n.endsWith('.msi') || n.includes('-win') || n.includes('_win')) {
                return { id: 'windows', name: 'Win', showTag: true };
            }
            if (n.endsWith('.dmg') || n.endsWith('.pkg') || n.endsWith('.app.tar.gz') || n.includes('-mac') || n.includes('_mac') || n.includes('darwin')) {
                return { id: 'mac', name: 'Mac', showTag: true };
            }
            if (n.endsWith('.apk') || n.endsWith('.aab')) {
                return { id: 'android', name: 'Android', showTag: true };
            }
            if (n.endsWith('.ipa')) {
                return { id: 'ios', name: 'iOS', showTag: true };
            }
            if (n.endsWith('.deb')) return { id: 'linux-deb', name: 'Debian', showTag: true };
            if (n.endsWith('.rpm')) return { id: 'linux-rpm', name: 'RedHat', showTag: true };
            if (n.endsWith('.appimage')) return { id: 'linux-appimage', name: 'AppImage', showTag: true };
            if (n.endsWith('.flatpak')) return { id: 'linux-flatpak', name: 'Flatpak', showTag: true };
            if (n.endsWith('.pacman') || n.endsWith('.pkg.tar.zst')) return { id: 'linux-arch', name: 'Arch', showTag: true };
            if (n.includes('-linux') || n.includes('_linux') || n.endsWith('.tar.xz')) return { id: 'linux-other', name: 'Linux', showTag: true };
            return { id: 'other', showTag: false };
        },

        // 分组 id → 样式类（linux-* 细分缺失时回退 linux-other，移动端合并）
        GROUP_CLASS: {
            windows: 'gh-group-win', mac: 'gh-group-mac',
            'linux-deb': 'gh-group-linux-deb', 'linux-rpm': 'gh-group-linux-rpm',
            'linux-arch': 'gh-group-linux-arch', 'linux-appimage': 'gh-group-linux-appimage',
            'linux-flatpak': 'gh-group-linux-flatpak'
        },
        getGroupClass(id) {
            return this.GROUP_CLASS[id]
                || (id.startsWith('linux') ? 'gh-group-linux-other'
                    : (id === 'android' || id === 'ios') ? 'gh-group-mobile' : 'gh-group-other');
        },
        getTagClass(id) {
            const g = this.getGroupClass(id);
            return g === 'gh-group-other' ? '' : g.replace('gh-group', 'gh-tag');
        },

        // 非当前 OS 时的组间排序基准分（当前 OS 组 = 10000 + 包管理器加分）
        GROUP_BASE: {
            windows: 9000, mac: 8000, 'linux-deb': 7000, 'linux-rpm': 6000,
            'linux-appimage': 5200, 'linux-flatpak': 5000, 'linux-arch': 4500,
            'linux-other': 4000, android: 3500, ios: 3000, other: 2000,
            meta: -1000, source: -2000
        },

        // 非所选架构时的兜底偏好分（所选架构 +500，通用 +60）
        ARCH_SCORE: { universal: 60, x86_64: 50, arm64: 20, x86: 10, arm32: 5 },

        calculateMatchScore(fileName, currentOS, groupId, currentArch) {
            let groupScore;
            const name = String(fileName).toLowerCase();
            const isCurrentOS = (groupId === currentOS) || groupId.startsWith(currentOS + '-');

            if (isCurrentOS) {
                groupScore = 10000;
                if (groupId === 'linux-deb') groupScore += 300;
                else if (groupId === 'linux-rpm') groupScore += 200;
                else if (groupId === 'linux-appimage' || groupId === 'linux-flatpak') groupScore += 100;
            } else {
                groupScore = this.GROUP_BASE[groupId] != null ? this.GROUP_BASE[groupId] : 0;
            }

            // 架构匹配：用户所选架构权重最高，远超兜底默认偏好
            let innerScore = 0;
            const fileArch = this.parseFileArch(fileName);
            if (fileArch === currentArch) innerScore += 500;
            else innerScore += this.ARCH_SCORE[fileArch] || 0;

            if (name.endsWith('.exe') || name.endsWith('.dmg') || name.endsWith('.appimage') || name.endsWith('.flatpak') || name.endsWith('.apk')) innerScore += 10;
            if (name.endsWith('.zip') || name.endsWith('.7z')) innerScore += 5;

            return groupScore + innerScore;
        },

        isAuxiliaryFile(name) {
            const n = String(name).toLowerCase();
            if (/\.sha\d*sum$/.test(n)) return true;
            if (/\.md5sum$/.test(n)) return true;
            if (/\.checksums?$/.test(n)) return true;
            if (/\.sums$/.test(n)) return true;
            if (/\.(bsdiff|delta|patch)$/.test(n)) return true;
            return false;
        },

        getFileNameFromLink(link) {
            const href = link.getAttribute('href');
            if (href) {
                const seg = decodeURIComponent(href.split('/').pop().split('?')[0]);
                if (seg) return seg;
            }
            const span = link.querySelector('.Truncate-text');
            return span ? span.textContent.trim() : link.textContent.trim();
        },

        getRepoInfo() {
            const parts = location.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
            return null;
        },

        formatCount(num) {
            if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
            if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
            return String(num);
        }
    };

    /* ======================================================================
     * L2-c · FOUNDATION —— Route：GitHub 路径解析纯函数（无 DOM 依赖）
     *   只做「pathname → owner/repo」与「repo → DeepWiki URL」的纯计算。
     *   白名单式解析：settings / orgs 等非仓库页一律返回 null，绝不误注入。
     * ==================================================================== */
    const Route = {
        // 一级路径为这些值时必非仓库页（GitHub 官方功能区）
        SKIP: new Set([
            'settings', 'orgs', 'topics', 'marketplace', 'explore', 'notifications',
            'features', 'security', 'pricing', 'sponsors', 'collections', 'trending',
            'events', 'dashboard', 'about', 'enterprise', 'login', 'logout', 'join',
            'site', 'search', 'pulls', 'issues', 'watching', 'new', 'codespaces',
            'account', 'users', 'showcases', 'customer-stories', 'readme', 'tools',
            'git', 'apps', 'install', 'mine'
        ]),

        /** pathname → {owner, repo} | null（非仓库页返回 null） */
        parseRepo(pathname) {
            const seg = String(pathname || '').split('/').filter(Boolean);
            if (seg.length < 2) return null;
            const owner = seg[0];
            const repo = seg[1].replace(/\.git$/i, '');
            if (this.SKIP.has(owner.toLowerCase()) || this.SKIP.has(repo.toLowerCase())) return null;
            if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
            return { owner, repo };
        },

        /** repo → DeepWiki 地址（只取 owner/repo，丢弃更深的页面路径） */
        deepWikiUrl(repo) {
            return 'https://deepwiki.com/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo);
        }
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
        const list = await probeMany(BUILTIN_MIRRORS);
        if (!list.length) throw new Error('内置节点全部不可达');
        return list;
    }

    /* ======================================================================
     * L4 · STATE —— 用户偏好(Settings) + 镜像节点(NodeStore)：唯一数据源，变更广播给视图层
     * ==================================================================== */

    /**
     * L4-a · STATE · Settings：用户偏好（持久化于 GM 存储），唯一读写口。
     *   load 与默认值合并，set 落盘；与下方 L4-b NodeStore 同属 STATE 层。
     */
    /** 设置的唯一读写口：load 负责与默认值合并，set 负责落盘 */
    const Settings = {
        data: Object.assign({}, DEFAULT_SETTINGS),

        load() {
            const saved = Store.read(K.settings, {}) || {};
            this.data = Object.assign({}, DEFAULT_SETTINGS, saved);
            this.data.inject = Object.assign({}, DEFAULT_INJECT, saved.inject || {});
            this.data.enhance = Object.assign({}, ENHANCE_DEFAULT, saved.enhance || {});
            this.data.tools = Object.assign({}, TOOLS_DEFAULT, saved.tools || {});
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
            this.data = Object.assign({}, DEFAULT_SETTINGS, {
                inject: Object.assign({}, DEFAULT_INJECT),
                enhance: Object.assign({}, ENHANCE_DEFAULT),
                tools: Object.assign({}, TOOLS_DEFAULT)
            });
            Store.write(K.settings, this.data);
        }
    };

    const NodeStore = {
        nodes: [],
        visible: [],
        updatedAt: 0,
        fails: {},           // url → 连续失败次数（持久化，镜像失效的自我记忆）
        lastOk: {},          // url → 上次预检成功时间戳（持久化，新鲜度缓存）
        subs: [],

        subscribe(fn) { this.subs.push(fn); },
        emit() { this.subs.forEach((fn) => { try { fn(); } catch (e) { Log.warn('订阅回调异常', e); } }); },

        hydrate() {
            const cached = Store.read(K.nodes, []);
            if (Array.isArray(cached) && cached.length) {
                // 缓存同样并入内置镜像池：即使刷新接口全挂，内置源也在面板可见可测
                this.nodes = this.mergeBuiltin(cached.filter((n) => n && n.url));
                this.updatedAt = Store.read(K.updatedAt, 0);
            }
            this.visible = Store.read(K.visible, []);
            this.fails = Store.read(K.fails, {}) || {};
            this.lastOk = Store.read(K.lastOk, {}) || {};
            this.pruneLastOk();
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
            this.nodes = this.dedupe(list);
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

        /**
         * 节点去重：两家接口会返回相同的代理地址，且可能带/不带尾斜杠。
         * 以「去尾斜杠的 URL」为身份，重复时保留延迟更低的一条。
         */
        dedupe(list) {
            const best = new Map();   // 归一化 URL → {url, latency}
            for (const n of (Array.isArray(list) ? list : [])) {
                if (!n || !n.url) continue;
                const raw = String(n.url);
                const key = raw.replace(/\/+$/, '');
                const latency = Number(n.latency) || 0;
                const old = best.get(key);
                if (!old || latency < old.latency) best.set(key, { url: raw, latency, builtin: !!n.builtin });
            }
            return Array.from(best.values()).sort((a, b) => a.latency - b.latency);
        },

        /**
         * 合并内置镜像池：无论聚合接口是否可用，内置源始终纳入节点面板
         * 统一管理（显示、勾选、测速）。已在线列表中的节点优先（有实测延迟）；
         * 内置源此前测出的延迟跨刷新保留（存于 this.nodes，不因重置为未测速）。
         */
        mergeBuiltin(list) {
            const known = new Set((Array.isArray(list) ? list : [])
                .map((n) => String(n.url).replace(/\/+$/, '')));
            const prevLat = new Map((this.nodes || [])
                .filter((n) => n.builtin && n.latency < LATENCY_UNKNOWN)
                .map((n) => [n.url, n.latency]));
            const extra = BUILTIN_MIRRORS
                .map((u) => u.replace(/\/+$/, ''))
                .filter((u) => !known.has(u))
                .map((u) => ({
                    url: u,
                    latency: prevLat.has(u) ? prevLat.get(u) : LATENCY_UNKNOWN,
                    builtin: true
                }));
            return (Array.isArray(list) ? list : []).concat(extra);
        },

        /** 测速结果落库：测通的更新延迟，未测通的保留在池中沉底（不删除，保持统一管理） */
        applyProbe(list) {
            const okUrls = new Set((list || []).map((n) => n.url));
            const rest = (this.nodes || [])
                .filter((n) => !okUrls.has(n.url))
                .map((n) => ({ url: n.url, latency: LATENCY_UNKNOWN, builtin: !!n.builtin }));
            this.setNodes(this.mergeBuiltin((list || []).concat(rest)));
        },

        setVisible(list) {
            this.visible = list.slice();
            Store.write(K.visible, this.visible);
            this.emit();
        },

        /** 下载成功：清零该节点的失败计数 */
        markOk(url) {
            delete this.fails[url];
            this.lastOk[url] = Date.now();
            Store.write(K.fails, this.fails);
            Store.write(K.lastOk, this.lastOk);
        },

        /**
         * 批量预检成功：只写盘 2 次，而非 2N 次。
         * GM_setValue 是同步阻塞 API，测速后逐个写会让主线程明显卡顿。
         */
        markOkMany(urls) {
            const now = Date.now();
            (urls || []).forEach((u) => {
                if (!u) return;
                delete this.fails[u];
                this.lastOk[u] = now;
            });
            Store.write(K.fails, this.fails);
            Store.write(K.lastOk, this.lastOk);
        },
        pruneLastOk() {
            const cutoff = Date.now() - PRECHECK_TTL;
            let dirty = false;
            for (const k in this.lastOk) {
                if (this.lastOk[k] < cutoff) { delete this.lastOk[k]; dirty = true; }
            }
            if (dirty) Store.write(K.lastOk, this.lastOk);
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
        isFresh(url) { return (this.lastOk[url] || 0) > Date.now() - PRECHECK_TTL; },
        freshCandidates() { return this.candidates().filter((n) => this.isFresh(n.url)); },

        isStale() {
            return !this.nodes.length || (Date.now() - this.updatedAt > NODE_TTL);
        }
    };

    /** 节点加载：API → 内置测速 → 保留旧值；两条路径均并入内置镜像池统一管理 */
    async function loadNodes(reason) {
        try {
            NodeStore.setNodes(NodeStore.mergeBuiltin(await nodesFromApi()));
            Log.info(reason + '刷新：接口返回 ' + NodeStore.nodes.length + ' 个节点（含内置池）');
            return true;
        } catch (e) {
            Log.warn(reason + '刷新：接口失败 →', e.message);
        }
        try {
            NodeStore.setNodes(NodeStore.mergeBuiltin(await nodesFromProbe()));
            Log.info(reason + '刷新：内置测速得到 ' + NodeStore.nodes.length + ' 个节点');
            return true;
        } catch (e) {
            Log.warn(reason + '刷新：内置测速失败 →', e.message);
        }
        NodeStore.emit();
        return false;
    }

    /* ======================================================================
     * L5-a · CAPABILITY —— Downloader：只管「发射」，不接管下载
     *
     * 职责边界：
     *   脚本（本层）：挑选镜像 → HEAD 预检 → 原生 a[download] 点击
     *   浏览器原生通道：把下载事件交给默认下载器 或 Gopeed 浏览器扩展
     *   Gopeed 扩展：通过 chrome.downloads 事件监听原生下载并拦截
     *
     * 脚本一旦走 GM_download / blob / objectURL 中转，就绕开了原生下载事件，
     * Gopeed 永远拦不到——所以这里只有 clickAnchor 一条路径。
     * 镜像可用性靠 HEAD 预检判断：失败记入健康度并自动换下一个。
     * ==================================================================== */

    /** GitHub 原链 + 镜像前缀 → 镜像直链
     *  常规前缀以 / 拼接；以 ? & = 结尾的查询串式前缀（如 down.npee.cn/?）免斜杠直拼 */
    function mirrorUrl(githubUrl, nodeUrl) {
        if (!githubUrl || !nodeUrl) return '';
        const node = String(nodeUrl).replace(/\/+$/, '');
        const sep = /[?=&]$/.test(node) ? '' : '/';
        return node + sep + String(githubUrl).replace(/^\/+/, '');
    }

    /**
     * 通过原生 <a download> 触发浏览器下载事件。
     * 关键：Gopeed 浏览器扩展监听的就是这条原生事件——
     * 因此脚本只此一条路径，不中转、不接字节，确保下载工具能正常接管。
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

    /** HEAD 预检：确认镜像真的能给文件，再把直链交给浏览器 */
    function precheck(url, timeoutMs) {
        return gmRequest({ url, method: 'HEAD', timeout: timeoutMs || HEAD_TIMEOUT })
            .then((res) => {
                const m = /content-length:\s*(\d+)/i.exec(res.responseHeaders || '');
                return { ok: true, size: m ? parseInt(m[1], 10) : -1 };
            })
            .catch((e) => ({ ok: false, error: (e && e.message) || '预检失败' }));
    }

    const Downloader = {
        /** 直链交付：原生 a[download] 点击，发射后即交还浏览器，脚本不再介入 */
        deliver(githubUrl, filename) {
            clickAnchor(githubUrl, filename);
        },

        /**
         * 自动模式两段式（先快后稳）：
         *   ① fast-path：fresh 候选（5 分钟内预检成功过）直接 fire，跳过预检 → 0ms
         *   ② 慢路径：逐个短预检（2.5s）轮换，失败换下一个
         *   ③ 兜底：全部失败时对最快节点直接放行一次（仍是 clickAnchor 原生通道）
         *
         * 注意：fast-path 故意不刷新 lastOk 时间戳——采用固定窗口而非滑动窗口，
         * 保证持续使用时仍会每 5 分钟重新验证一次，避免镜像悄悄失效却一直拿坏链接。
         * @returns Promise<{ok, nodeUrl?, blind?, size?, error?, trace:string[]}>
         */
        async runAuto(githubUrl, filename, hooks) {
            hooks = hooks || {};
            if (!NodeStore.nodes.length) await loadNodes('自动下载');
            const trace = [];
            // fast-path:fresh 候选直接 fire,跳过预检
            const fresh = NodeStore.freshCandidates().slice(0, NODE_RETRY_MAX);
            if (fresh.length) {
                const best = fresh[0];
                if (hooks.onNode) hooks.onNode(best, 1, 1, false);
                this.deliver(mirrorUrl(githubUrl, best.url), filename);
                return { ok: true, nodeUrl: best.url, blind: false, trace };
            }
            const list = NodeStore.candidates().slice(0, NODE_RETRY_MAX);
            if (!list.length) return { ok: false, error: '没有可用镜像节点', trace: [] };

            for (let i = 0; i < list.length; i++) {
                const node = list[i];
                if (hooks.onNode) hooks.onNode(node, i + 1, list.length, false);
                const target = mirrorUrl(githubUrl, node.url);
                const head = await precheck(target, HEAD_TIMEOUT_FAST);
                if (head.ok) {
                    NodeStore.markOk(node.url);
                    this.deliver(target, filename);
                    return { ok: true, nodeUrl: node.url, size: head.size, blind: false, trace };
                }
                NodeStore.markFail(node.url);
                trace.push(Utils.shortDomain(node.url) + ' ✗ ' + head.error);
                Log.warn('镜像预检失败 →', Utils.shortDomain(node.url), head.error);
            }

            // 轮转耗尽：预检可能误判（部分镜像不支持 HEAD），对最快节点直接放行
            const best = list[0];
            if (hooks.onNode) hooks.onNode(best, list.length, list.length, true);
            this.deliver(mirrorUrl(githubUrl, best.url), filename);
            return { ok: true, nodeUrl: best.url, blind: true, trace };
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
            // selector 已限定 github 域名（含 codeload.github.com），此处不再二次过滤
            const href = link.href;
            const name = scenario.name(link) || Utils.filenameFromUrl(href);
            container.appendChild(this.build(href, name));
        },

        run() {
            if (!Settings.get().showPageButtons) return;   // 主开关：关闭则页面内不注入按钮
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
        }
        // SPA 重扫由 L7 Watcher 统一驱动（路由变化 / 相关 DOM 增量 / 兜底轮询）
    };
    /* ======================================================================
     * L5-c · CAPABILITY —— Enhancer：Release 增强显示
     *   Release 增强显示核心能力（DOM 编排层），四大能力均可独立开关、持久化于 Settings.enhance：
     *     groupSort        文件按平台分组、按当前系统/架构排序、推荐最可能安装包
     *     downloadCount    通过 GitHub API 显示各文件下载量
     *     replaceTime      相对时间 → 精确时间
     *     collapsibleNotes 更新日志可折叠
     *   主动排除冲突/冗余的部分：代理下拉（易与其他脚本重复）、回到顶部按钮。
     *   纯计算在 L2-b（Arch.*），本层只做 DOM 编排与数据获取。
     * ==================================================================== */

    const Enhancer = {
        _os: null,           // 用户手动覆盖的 OS
        _arch: null,         // 用户手动覆盖的架构
        _boxes: [],          // 已登记处理的 release details

        active(key) { return !!Settings.get().enhance[key]; },

        /** 行内 meta 容器（平台标签 / 下载量共同挂载点），幂等创建 */
        ensureMetaContainer(row) {
            let mc = row.querySelector('.gh-meta-container');
            if (!mc) {
                mc = document.createElement('div');
                mc.className = 'gh-meta-container d-flex flex-items-center flex-shrink-0 mr-3';
                const right = row.querySelector('.col-md-6') || row.querySelector('.flex-auto.flex-justify-end');
                const sha = right ? right.querySelector('.flex-1') : null;
                if (sha) sha.insertBefore(mc, sha.firstChild);
                else if (right) right.insertBefore(mc, right.firstChild);
                else { const left = row.querySelector('.col-lg-6'); if (left) left.appendChild(mc); else row.appendChild(mc); }
            }
            return mc;
        },

        /* ---- 页面级扫描：releases 页做分组/下载量；全局做时间/日志 ---- */
        scan() {
            if (this.active('replaceTime')) this.replaceTimes();
            if (this.active('collapsibleNotes')) this.processNotes();

            if (!/^\/[^\/]+\/[^\/]+\/releases/.test(location.pathname)) return;
            const repo = Arch.getRepoInfo();
            if (!repo) return;
            if (!(this.active('groupSort') || this.active('downloadCount'))) return;

            document.querySelectorAll('details').forEach((details) => {
                const summary = details.querySelector('summary');
                if (summary && /Assets/i.test(summary.textContent)) {
                    const tag = this.findTagName(details);
                    if (tag) this.processBox(details, repo, tag);
                }
            });
        },
        // SPA 重扫由 L7 Watcher 统一驱动

        /* ---- 相对时间替换（兼容 Shadow DOM 与实际渲染层） ---- */
        replaceTimes() {
            document.querySelectorAll('relative-time:not([data-gh-replaced])').forEach((el) => {
                const dt = el.getAttribute('datetime');
                if (!dt) return;
                const d = new Date(dt);
                if (isNaN(d.getTime())) return;
                const pad = (n) => String(n).padStart(2, '0');
                const s = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                          pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
                el.setAttribute('data-gh-replaced', '1');
                if (el.shadowRoot) el.shadowRoot.textContent = s;
                el.textContent = s;
                el.style.cssText = 'font-variant-numeric: tabular-nums;';
            });
        },

        /* ---- 更新日志手动折叠（默认展开） ---- */
        processNotes() {
            document.querySelectorAll('.markdown-body.tmp-my-3:not(.gh-notes-processed)').forEach((el) => {
                el.classList.add('gh-notes-processed');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'gh-notes-toggle';
                btn.innerHTML = '<span class="gh-notes-chevron"></span>更新日志';
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const collapsed = el.classList.toggle('gh-notes-collapsed');
                    btn.classList.toggle('is-collapsed', collapsed);
                });
                el.parentNode.insertBefore(btn, el);
            });
        },

        findTagName(details) {
            const m = location.pathname.match(/\/releases\/tag\/([^/?]+)/);
            if (m) return decodeURIComponent(m[1]);
            const box = details.closest('section, .Box, .js-details-container, div[data-test-selector="release-card"]');
            if (box) {
                const link = box.querySelector('a[href*="/releases/tag/"]');
                if (link) {
                    const mm = link.getAttribute('href').match(/\/releases\/tag\/([^/?]+)/);
                    if (mm) return decodeURIComponent(mm[1]);
                }
            }
            return null;
        },

        /* ---- 处理单个 release 折叠块（幂等：首次登记监听，之后每次按需重排/重注控件） ---- */
        processBox(details, repo, tag) {
            const first = details.dataset.ghBox !== '1';
            details.dataset.ghBox = '1';

            if (first) {
                this._boxes.push(details);
                details.addEventListener('toggle', () => {
                    if (details.open && this.active('groupSort')) this.formatAndSort(details);
                });
                const mo = new MutationObserver(() => {
                    if (details.open && this.active('groupSort')) this.formatAndSort(details);
                    if (details._assets) this.injectCounts(details, details._assets);
                });
                mo.observe(details, { childList: true, subtree: true });
            }

            this.injectControls(details, repo, tag);
            if (details.open && this.active('groupSort')) this.formatAndSort(details);
            if (details._assets) this.injectCounts(details, details._assets);
        },

        /** 通用下拉构造（OS / 架构共用）：写入选中值、同步页面同名下拉、全量重排 */
        buildSelect(cls, options, selected, onPick) {
            const sel = document.createElement('select');
            sel.className = cls;
            options.forEach((o) => {
                const opt = document.createElement('option');
                opt.value = o.value; opt.textContent = o.label;
                if (o.value === selected) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.addEventListener('click', (e) => e.stopPropagation());
            sel.addEventListener('mousedown', (e) => e.stopPropagation());
            sel.addEventListener('change', () => {
                onPick(sel.value);
                document.querySelectorAll('.' + cls).forEach((s) => { s.value = sel.value; });
                this._boxes.forEach((d) => { if (this.active('groupSort')) this.formatAndSort(d); });
            });
            return sel;
        },

        /* ---- 注入/移除摘要区的控件（按开关实时生效，可关闭即移除） ---- */
        injectControls(details, repo, tag) {
            const summary = details.querySelector('summary');
            const titleSpan = summary ? (summary.querySelector('.d-inline-flex.flex-items-center') || summary) : null;
            if (!titleSpan) return;
            const dlBtn = titleSpan.querySelector('.gh-fetch-dl-btn');

            // 下载量按钮
            if (this.active('downloadCount') && !summary.dataset.ghDlBtn) {
                summary.dataset.ghDlBtn = '1';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'Button Button--secondary Button--small ml-3 gh-fetch-dl-btn';
                btn.innerHTML = '<span class="Button-content"><span class="Button-label">显示下载量</span></span>';
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (details.dataset.ghFetching === '1') return;
                    const refresh = !!details._assets;
                    btn.querySelector('.Button-label').textContent = '获取中…';
                    btn.disabled = true;
                    this.fetchCounts(repo, tag).then((assets) => {
                        details._assets = assets;
                        this.injectCounts(details, assets);
                        btn.querySelector('.Button-label').textContent = '刷新下载量';
                        btn.disabled = false;
                    }).catch(() => {
                        btn.querySelector('.Button-label').textContent = '获取失败(限流)';
                        btn.disabled = false;
                    });
                });
                titleSpan.appendChild(btn);
                if (details._assets) this.injectCounts(details, details._assets);
            } else if (!this.active('downloadCount')) {
                if (dlBtn) { dlBtn.remove(); summary.dataset.ghDlBtn = ''; }
                // 同时清掉已注入的计数
                details.querySelectorAll('.gh-dl-count').forEach((el) => el.remove());
            }

            // OS / 架构 下拉 + 架构说明（与 groupSort 绑定，共用 buildSelect）
            if (this.active('groupSort')) {
                if (!summary.dataset.ghOsSel) {
                    summary.dataset.ghOsSel = '1';
                    titleSpan.appendChild(this.buildSelect(
                        'gh-os-select', Arch.OS_OPTIONS, this._os || Arch.getCurrentOS(),
                        (v) => { this._os = v; }));
                }
                if (!summary.dataset.ghArchSel) {
                    summary.dataset.ghArchSel = '1';
                    titleSpan.appendChild(this.buildSelect(
                        'gh-arch-select', Arch.ARCH_OPTIONS, this._arch || Arch.getCurrentArch(),
                        (v) => { this._arch = v; }));

                    const help = document.createElement('button');
                    help.type = 'button';
                    help.className = 'gh-arch-help-btn';
                    help.textContent = '?';
                    help.title = '架构说明';
                    help.addEventListener('mousedown', (e) => e.stopPropagation());
                    help.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.showArchHelp(); });
                    titleSpan.appendChild(help);
                }
            } else {
                const os = titleSpan.querySelector('.gh-os-select');
                if (os) { os.remove(); summary.dataset.ghOsSel = ''; }
                const arch = titleSpan.querySelector('.gh-arch-select');
                if (arch) { arch.remove(); summary.dataset.ghArchSel = ''; }
                const help = titleSpan.querySelector('.gh-arch-help-btn');
                if (help) help.remove();
            }
        },

        /* ---- 分组排序核心 ---- */
        formatAndSort(details) {
            const rows = Array.from(details.querySelectorAll('li')).filter((r) =>
                r.querySelector('a[href*="/releases/download/"], a[href*="/archive/"], a[href*="/attestations/"]'));
            if (!rows.length) return;

            const parent = rows[0].parentNode;
            const os = this._os || Arch.getCurrentOS();
            const arch = this._arch || Arch.getCurrentArch();

            // 幂等签名：行数 或 用户所选 OS/架构 任一变化才重排，避免 MutationObserver 死循环，
            // 同时保证切换 OS/架构下拉时文件顺序会真正重新排序（仅比较行数会导致切换失效）。
            const sig = os + '|' + arch + '|' + rows.length;
            if (details.dataset.ghSortSig === sig) return;
            details.dataset.ghSortSig = sig;

            rows.forEach((row) => {
                const link = row.querySelector('a[href*="/releases/download/"], a[href*="/archive/"], a[href*="/attestations/"]');
                let group = { id: 'other', showTag: false };
                let score = -10000;
                if (link) {
                    const href = link.getAttribute('href') || '';
                    const fn = Arch.getFileNameFromLink(link);
                    group = href.includes('/archive/') ? { id: 'source', showTag: false }
                        : href.includes('/attestations/') ? { id: 'meta', showTag: false }
                        : Arch.parseFileGroup(fn);
                    score = Arch.calculateMatchScore(fn, os, group.id, arch);
                }
                row.dataset.matchScore = String(score);
                row._group = group;
                row._link = link;
            });

            rows.forEach((r) => r.remove());
            parent.querySelectorAll('.gh-meta-files-wrapper, .gh-group-aux-wrapper').forEach((w) => w.remove());
            rows.sort((a, b) => parseInt(b.dataset.matchScore) - parseInt(a.dataset.matchScore));

            const normal = rows.filter((r) => r._group.id !== 'meta');
            const meta = rows.filter((r) => r._group.id === 'meta');

            const styleRow = (row) => {
                row.style.borderTop = '';
                row.style.borderLeft = '';
                row.style.backgroundColor = '';
                row.className = row.className.replace(/gh-group-\S+/g, '');
                row.classList.add(Arch.getGroupClass(row._group.id));

                let mc = this.ensureMetaContainer(row);
                row.querySelectorAll('.gh-platform-tag').forEach((t) => t.remove());
                if (row._group.showTag) {
                    const tag = document.createElement('span');
                    tag.className = 'Label gh-platform-tag ' + Arch.getTagClass(row._group.id) + ' mr-2';
                    tag.textContent = row._group.name;
                    mc.appendChild(tag);
                }
            };

            let gid = null, seg = [];
            const flush = () => {
                if (!seg.length) return;
                const g = seg[0]._group.id;
                const main = [], aux = [];
                seg.forEach((r) => {
                    const n = r._link ? Arch.getFileNameFromLink(r._link) : '';
                    (Arch.isAuxiliaryFile(n) ? aux : main).push(r);
                });
                main.forEach((r) => { parent.appendChild(r); styleRow(r); });
                if (aux.length) {
                    const w = document.createElement('details');
                    w.className = 'gh-group-aux-wrapper ' + Arch.getGroupClass(g);
                    const s = document.createElement('summary');
                    s.textContent = '校验/增量文件 (' + aux.length + ')';
                    w.appendChild(s);
                    aux.forEach((r) => { w.appendChild(r); styleRow(r); });
                    parent.appendChild(w);
                }
                seg = [];
            };
            normal.forEach((r) => { if (r._group.id !== gid) flush(); gid = r._group.id; seg.push(r); });
            flush();

            if (meta.length) {
                const w = document.createElement('details');
                w.className = 'gh-meta-files-wrapper';
                const s = document.createElement('summary');
                s.textContent = '签名 / 校验文件 (' + meta.length + ')';
                w.appendChild(s);
                meta.forEach((r) => { w.appendChild(r); styleRow(r); });
                parent.appendChild(w);
            }

            const showAll = Array.from(parent.children).find((c) =>
                !c.querySelector('a[href*="/releases/download/"], a[href*="/archive/"]') &&
                !c.classList.contains('gh-meta-files-wrapper') &&
                !c.classList.contains('gh-group-aux-wrapper') &&
                /show all/i.test(c.textContent));
            if (showAll) parent.appendChild(showAll);
        },

        /* ---- 下载量：GitHub API ---- */
        async fetchCounts(repo, tag) {
            const res = await gmRequest({
                url: 'https://api.github.com/repos/' + repo.owner + '/' + repo.repo + '/releases/tags/' + encodeURIComponent(tag),
                headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'GitHub-Boost-Helper/1.0.0' },
                timeout: 12000
            });
            const data = typeof res.response === 'string' ? JSON.parse(res.response) : res.response;
            return data.assets || [];
        },

        injectCounts(details, assets) {
            if (!assets) return;
            const rows = Array.from(details.querySelectorAll('li')).filter((r) =>
                r.querySelector('a[href*="/releases/download/"], a[href*="/archive/"]'));
            rows.forEach((row) => {
                const link = row.querySelector('a[href*="/releases/download/"], a[href*="/archive/"]');
                if (!link) return;
                const fn = Arch.getFileNameFromLink(link);
                const asset = assets.find((a) => a.name === fn);
                if (asset && !row.querySelector('.gh-dl-count')) {
                    const span = document.createElement('span');
                    span.className = 'color-fg-muted flex-shrink-0 d-flex flex-items-center mr-2 gh-dl-count';
                    span.style.whiteSpace = 'nowrap';
                    span.innerHTML =
                        '<svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" data-view-component="true" class="octicon octicon-download mr-1" style="flex-shrink:0;min-width:16px;">' +
                        '<path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"></path>' +
                        '<path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"></path>' +
                        '</svg><span>' + Arch.formatCount(asset.download_count) + '</span>';
                    this.ensureMetaContainer(row).appendChild(span);
                }
            });
        },

        /* ---- 架构说明弹窗（全局复用） ---- */
        _archModal: null,
        showArchHelp() {
            if (!this._archModal) {
                const overlay = document.createElement('div');
                overlay.className = 'gh-arch-help-overlay';
                overlay.innerHTML =
                    '<div class="gh-arch-help-modal">' +
                    '  <button type="button" class="gh-arch-help-close" aria-label="关闭">×</button>' +
                    '  <h3>设备架构说明</h3>' +
                    '  <p class="gh-arch-help-tip">架构指 CPU 指令集架构(ISA)，决定软件能否运行，不同架构一般不兼容。</p>' +
                    '  <table>' +
                    '    <thead><tr><th>架构</th><th>别名</th><th>常见设备</th><th>说明</th></tr></thead>' +
                    '    <tbody>' +
                    '      <tr><td><strong>x86</strong></td><td>i386、i686、32 位</td><td>老电脑、旧工控机</td><td>Intel/AMD 32 位，已逐渐淘汰</td></tr>' +
                    '      <tr><td><strong>x86_64</strong></td><td>amd64、x64</td><td>大多数 Windows/Linux PC</td><td>桌面与服务器最常见</td></tr>' +
                    '      <tr><td><strong>ARM32</strong></td><td>armv7、armeabi-v7a</td><td>老安卓手机、树莓派早期</td><td>32 位 ARM</td></tr>' +
                    '      <tr><td><strong>ARM64</strong></td><td>aarch64、arm64</td><td>新安卓手机、Apple Silicon、树莓派 3/4/5</td><td>移动设备主流</td></tr>' +
                    '    </tbody>' +
                    '  </table>' +
                    '</div>';
                overlay.querySelector('.gh-arch-help-close').addEventListener('click', () => { overlay.style.display = 'none'; });
                overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
                overlay.style.display = 'none';
                document.body.appendChild(overlay);
                this._archModal = overlay;
            }
            this._archModal.style.display = 'flex';
        }
    };

    /* ======================================================================
     * L5-d · CAPABILITY —— Tools：仓库页工具注入（当前：DeepWiki 跳转）
     *   scan()    按开关与页面类型决定「注入 / 校正 / 移除」，幂等可重入；
     *   findBar() 锚点降级链（对照 github.com/microsoft/vscode 真实 DOM）：
     *     ① 旧版 ul.pagehead-actions；
     *     ② 新版仓库头 #repository-container-header 内，Star 计数器
     *        （#repo-stars-counter-star，span→a→div→li→ul→…→header）或
     *        Watchers/Stargazers 链接作种子向上爬升：
     *        - 途经的第一个动作列表 <ul>（Watch/Fork/Star 所在列表）优先，
     *          按列表语义追加 <li>，与原生按钮同排；
     *        - 无列表则退到仓库头顶层操作容器（绝不注入 <button>/<a> 内部，
     *          非法嵌套会被 React 重渲染吞掉——v1.2 按钮消失的根因）；
     *     ③ 多种子设计：id 再次改版时仍有 a[href$="/watchers"] 兜底。
     * ==================================================================== */
    const Tools = {
        id: 'gh-deepwiki-li',
        enabled() {
            const t = Settings.get().tools;
            return !!(t && t.deepwiki);
        },

        /** 仓库头操作区锚点：动作列表 <ul> 或顶层操作容器，找不到返回 null */
        findBar() {
            // ① 旧版仓库头操作栏
            const oldBar = document.querySelector('ul.pagehead-actions');
            if (oldBar) return oldBar;
            // ② 种子节点：Star 计数器优先，Watchers/Stargazers 链接兜底
            const head = document.querySelector('#repository-container-header');
            const seed = (head && head.querySelector('#repo-stars-counter-star')) ||
                document.querySelector('a[href$="/watchers"], a[href$="/stargazers"]');
            if (!seed) return null;
            // ③ 爬升：记录途经的第一个动作列表，止于仓库头 / 主容器边界
            let list = null, top = seed, bounded = false;
            while (top.parentElement && top.parentElement !== document.body) {
                top = top.parentElement;
                if (top.tagName === 'UL' && !list && head && head.contains(top)) list = top;
                if ((head && top === head) || top.tagName === 'MAIN') { bounded = true; break; }
            }
            if (list) return list;                                        // Watch/Fork/Star 列表
            if (bounded && top !== head &&
                top.tagName !== 'BUTTON' && top.tagName !== 'A') return top;  // 顶层操作容器
            return null;
        },

        build(url) {
            const li = document.createElement('li');
            li.id = this.id;
            li.style.cssText = 'list-style:none;display:inline-flex;align-items:center;margin-left:8px;';
            const a = document.createElement('a');
            a.setAttribute('href', url);
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
            a.setAttribute('title', '在 DeepWiki 打开该仓库（AI 生成的 Wiki 文档，新标签页）');
            a.style.cssText =
                'display:inline-flex;align-items:center;gap:6px;' +
                'background:var(--button-default-bgColor-rest,var(--color-btn-bg));' +
                'color:var(--button-default-fgColor-rest,var(--color-btn-text));' +
                'border:1px solid var(--button-default-borderColor-rest,var(--color-btn-border));' +
                'border-radius:6px;padding:3px 12px;font-size:12px;font-weight:500;' +
                'line-height:20px;text-decoration:none;cursor:pointer;' +
                'transition:background-color 80ms cubic-bezier(0.65,0,0.35,1);';
            a.innerHTML =
                '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor" style="flex-shrink:0">' +
                '<path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"/></svg>' +
                '<span>DeepWiki</span>';
            a.addEventListener('mouseenter', () => {
                a.style.backgroundColor = 'var(--button-default-bgColor-hover,var(--color-btn-hover-bg))';
            });
            a.addEventListener('mouseleave', () => { a.style.backgroundColor = ''; });
            li.appendChild(a);
            return li;
        },

        scan() {
            const el = document.getElementById(this.id);
            const repo = this.enabled() ? Route.parseRepo(location.pathname) : null;
            if (!repo) {
                if (el) el.remove();
                return false;
            }
            const url = Route.deepWikiUrl(repo);
            if (el) {
                // 幂等：已在页面则只校正 href（SPA 路由切换到另一仓库时跟随更新）
                const a = el.querySelector('a');
                if (a && a.getAttribute('href') !== url) a.setAttribute('href', url);
                return true;
            }
            const bar = this.findBar();
            if (!bar) return false;
            const li = this.build(url);
            if (bar.tagName === 'UL') bar.prepend(li);   // 动作列表：列表语义（与 Watch/Fork/Star 同排）
            else bar.appendChild(li);                    // 顶层操作容器：行末追加
            return true;
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

/* ---------- 启动器：右侧中部圆形按钮，可拖拽，默认贴右 ---------- */
#ghb-launcher{
  position:fixed; right:0; top:50%; transform:translateY(-50%);
  margin-right:10px; z-index:2147483000;
  width:44px; height:44px; padding:0;
  display:flex; align-items:center; justify-content:center;
  border:none; border-radius:50%;
  background:var(--ghb-accent); color:#fff; cursor:pointer;
  box-shadow:0 6px 20px rgba(0,0,0,.32);
  transition:background .18s, box-shadow .18s, transform .18s, filter .18s;
  font-family:inherit; line-height:1;
}
#ghb-launcher:hover{background:var(--ghb-accent-2); box-shadow:0 8px 26px rgba(0,0,0,.4); transform:translateY(-50%) scale(1.06);}
#ghb-launcher.ghb-dragging{cursor:grabbing; filter:brightness(1.08); user-select:none; transform:translateY(-50%) scale(.96);}
#ghb-launcher .ghb-lau-mark{width:26px;height:26px;display:block;}
#ghb-launcher .ghb-lau-mark svg{width:26px;height:26px;}

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
.ghb-dl-sub{display:flex; justify-content:flex-end; padding:8px 16px 0; font-size:12px; color:var(--ghb-fg-2); flex:none;}
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

    /* ---------- 增强显示：Release 分组 / 平台标签 / OS·架构下拉 / 折叠 / 架构说明 ---------- */
    .gh-group-win { border-left: 4px solid var(--color-accent-emphasis, #1f6feb) !important; background-color: var(--color-accent-subtle, rgba(56,139,253,0.1)) !important; }
    .gh-group-win:hover { background-color: var(--color-accent-muted, rgba(56,139,253,0.15)) !important; }
    .gh-group-win a[href*="/releases/download/"], .gh-group-win a[href*="/archive/"] { color: var(--color-accent-emphasis, #1f6feb) !important; }

    .gh-group-mac { border-left: 4px solid var(--color-done-emphasis, #8957e5) !important; background-color: var(--color-done-subtle, rgba(137,87,229,0.1)) !important; }
    .gh-group-mac:hover { background-color: var(--color-done-muted, rgba(137,87,229,0.15)) !important; }
    .gh-group-mac a[href*="/releases/download/"], .gh-group-mac a[href*="/archive/"] { color: var(--color-done-emphasis, #8957e5) !important; }

    .gh-group-mobile { border-left: 4px solid #e3b341 !important; background-color: rgba(227,179,65,0.12) !important; }
    .gh-group-mobile:hover { background-color: rgba(227,179,65,0.18) !important; }
    .gh-group-mobile a[href*="/releases/download/"], .gh-group-mobile a[href*="/archive/"] { color: #e3b341 !important; }

    .gh-group-linux-rpm { border-left: 4px solid var(--color-danger-emphasis, #f85149) !important; background-color: var(--color-danger-subtle, rgba(248,81,73,0.1)) !important; }
    .gh-group-linux-rpm:hover { background-color: var(--color-danger-muted, rgba(248,81,73,0.15)) !important; }
    .gh-group-linux-rpm a[href*="/releases/download/"], .gh-group-linux-rpm a[href*="/archive/"] { color: var(--color-danger-emphasis, #f85149) !important; }

    .gh-group-linux-deb { border-left: 4px solid var(--color-severe-emphasis, #db6d28) !important; background-color: var(--color-severe-subtle, rgba(219,109,40,0.1)) !important; }
    .gh-group-linux-deb:hover { background-color: var(--color-severe-muted, rgba(219,109,40,0.15)) !important; }
    .gh-group-linux-deb a[href*="/releases/download/"], .gh-group-linux-deb a[href*="/archive/"] { color: var(--color-severe-emphasis, #db6d28) !important; }

    .gh-group-linux-arch { border-left: 4px solid var(--color-sponsors-emphasis, #bf4b8a) !important; background-color: var(--color-sponsors-subtle, rgba(191,75,138,0.1)) !important; }
    .gh-group-linux-arch:hover { background-color: var(--color-sponsors-muted, rgba(191,75,138,0.15)) !important; }
    .gh-group-linux-arch a[href*="/releases/download/"], .gh-group-linux-arch a[href*="/archive/"] { color: var(--color-sponsors-emphasis, #bf4b8a) !important; }

    .gh-group-linux-appimage { border-left: 4px solid #20c997 !important; background-color: rgba(32,201,151,0.1) !important; }
    .gh-group-linux-appimage:hover { background-color: rgba(32,201,151,0.15) !important; }
    .gh-group-linux-appimage a[href*="/releases/download/"], .gh-group-linux-appimage a[href*="/archive/"] { color: #20c997 !important; }

    .gh-group-linux-flatpak { border-left: 4px solid #0abda0 !important; background-color: rgba(10,189,160,0.1) !important; }
    .gh-group-linux-flatpak:hover { background-color: rgba(10,189,160,0.15) !important; }
    .gh-group-linux-flatpak a[href*="/releases/download/"], .gh-group-linux-flatpak a[href*="/archive/"] { color: #0abda0 !important; }

    .gh-group-linux-other { border-left: 4px solid var(--color-attention-emphasis, #9e6a03) !important; background-color: var(--color-attention-subtle, rgba(210,153,34,0.1)) !important; }
    .gh-group-linux-other:hover { background-color: var(--color-attention-muted, rgba(210,153,34,0.15)) !important; }
    .gh-group-linux-other a[href*="/releases/download/"], .gh-group-linux-other a[href*="/archive/"] { color: var(--color-attention-emphasis, #9e6a03) !important; }

    .gh-group-other { border-left: 4px solid transparent !important; }

    .gh-platform-tag { background-color: transparent !important; }
    .gh-platform-tag.gh-tag-win { color: var(--color-accent-emphasis, #1f6feb) !important; border-color: var(--color-accent-emphasis, #1f6feb) !important; }
    .gh-platform-tag.gh-tag-mac { color: var(--color-done-emphasis, #8957e5) !important; border-color: var(--color-done-emphasis, #8957e5) !important; }
    .gh-platform-tag.gh-tag-mobile { color: #e3b341 !important; border-color: #e3b341 !important; }
    .gh-platform-tag.gh-tag-linux-rpm { color: var(--color-danger-emphasis, #f85149) !important; border-color: var(--color-danger-emphasis, #f85149) !important; }
    .gh-platform-tag.gh-tag-linux-deb { color: var(--color-severe-emphasis, #db6d28) !important; border-color: var(--color-severe-emphasis, #db6d28) !important; }
    .gh-platform-tag.gh-tag-linux-arch { color: var(--color-sponsors-emphasis, #bf4b8a) !important; border-color: var(--color-sponsors-emphasis, #bf4b8a) !important; }
    .gh-platform-tag.gh-tag-linux-appimage { color: #20c997 !important; border-color: #20c997 !important; }
    .gh-platform-tag.gh-tag-linux-flatpak { color: #0abda0 !important; border-color: #0abda0 !important; }
    .gh-platform-tag.gh-tag-linux-other { color: var(--color-attention-emphasis, #9e6a03) !important; border-color: var(--color-attention-emphasis, #9e6a03) !important; }

    .gh-os-select, .gh-arch-select {
      appearance: auto; cursor: pointer; font-size: 12px; font-weight: 500; line-height: 20px;
      padding: 3px 8px; margin-left: 8px;
      background-color: var(--button-default-bgColor-rest, var(--color-btn-bg, #21262d));
      border: 1px solid var(--button-default-borderColor-rest, var(--color-btn-border, rgba(240,246,252,0.1)));
      border-radius: 6px; color: var(--button-default-fgColor-rest, var(--color-btn-text, #c9d1d9));
    }
    .gh-os-select:hover, .gh-arch-select:hover {
      background-color: var(--button-default-bgColor-hover, var(--color-btn-hover-bg, #30363d));
      border-color: var(--button-default-borderColor-hover, var(--color-btn-hover-border, rgba(240,246,252,0.3)));
    }

    .gh-meta-files-wrapper > summary, .gh-group-aux-wrapper > summary {
      cursor: pointer; padding: 8px 16px; font-size: 12px; color: var(--fgColor-muted, var(--color-fg-muted, #8b949e));
      border-top: 1px solid var(--borderColor-muted, var(--color-border-muted, #30363d));
    }
    .gh-meta-files-wrapper > summary:hover, .gh-group-aux-wrapper > summary:hover { color: var(--fgColor-default, var(--color-fg-default, #e6edf3)); }
    .gh-group-aux-wrapper > li { border-left: none !important; background-color: transparent !important; }

    .gh-notes-toggle {
      appearance: none; background: none; border: none; padding: 0; margin: 0 0 8px;
      display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
      color: var(--fgColor-muted, var(--color-fg-muted, #8b949e)); font-size: 14px; font-weight: 600;
    }
    .gh-notes-toggle:hover { color: var(--fgColor-default, var(--color-fg-default, #e6edf3)); }
    .markdown-body.gh-notes-collapsed { display: none !important; }
    .gh-notes-chevron { display: inline-block; width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 6px solid currentColor; transition: transform 0.12s ease; transform-origin: 50% 40%; }
    .gh-notes-toggle.is-collapsed .gh-notes-chevron { transform: rotate(-90deg); }

    .gh-arch-help-btn {
      appearance: none; width: 22px; height: 22px; line-height: 1; padding: 0; margin-left: 4px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 12px; font-weight: 600;
      background-color: var(--button-default-bgColor-rest, var(--color-btn-bg, #21262d));
      border: 1px solid var(--button-default-borderColor-rest, var(--color-btn-border, rgba(240,246,252,0.1)));
      border-radius: 6px; color: var(--button-default-fgColor-rest, var(--color-btn-text, #c9d1d9));
    }
    .gh-arch-help-btn:hover { background-color: var(--button-default-bgColor-hover, var(--color-btn-hover-bg, #30363d)); border-color: var(--button-default-borderColor-hover, var(--color-btn-hover-border, rgba(240,246,252,0.3))); }

    .gh-arch-help-overlay { position: fixed; inset: 0; z-index: 2147482999; background-color: rgba(1,4,9,0.6); display: flex; align-items: center; justify-content: center; }
    .gh-arch-help-modal {
      background-color: var(--color-canvas-default, #0d1117); border: 1px solid var(--color-border-default, #30363d);
      border-radius: 8px; padding: 16px 20px; max-width: 92vw; max-height: 85vh; overflow: auto; position: relative;
      box-shadow: var(--shadow-floating-large, 0 8px 24px rgba(0,0,0,0.4));
    }
    .gh-arch-help-modal h3 { margin: 0 0 8px; font-size: 16px; }
    .gh-arch-help-tip { margin: 0 0 12px; font-size: 12px; color: var(--color-fg-muted, #8b949e); }
    .gh-arch-help-modal table { border-collapse: collapse; width: 100%; font-size: 13px; }
    .gh-arch-help-modal th, .gh-arch-help-modal td { border: 1px solid var(--color-border-default, #30363d); padding: 6px 10px; text-align: left; vertical-align: top; }
    .gh-arch-help-modal th { background-color: var(--color-canvas-subtle, #161b22); font-weight: 600; }
    .gh-arch-help-close {
      position: absolute; top: 6px; right: 10px; background: none; border: none; color: var(--color-fg-muted, #8b949e);
      cursor: pointer; font-size: 22px; line-height: 1; padding: 0;
    }
    .gh-arch-help-close:hover { color: var(--color-fg-default, #e6edf3); }
    .gh-dl-count { font-size: 12px; }

.ghb-toast.ghb-err{background:#b62324;}
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
                '<span class="ghb-lau-mark">' + Icons.mark + '</span>';
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
                '  <div class="ghb-dl-sub"><span id="ghb-dl-count"></span></div>' +
                '  <div class="ghb-nodes" id="ghb-dl-nodes"></div>' +
                '  <div class="ghb-foot"><span>' + VERSION + '</span><span>作者 ' + AUTHOR + '</span></div>' +
                '</div>';
            document.body.appendChild(dl);

            Object.assign(this.el, { launcher, overlay, panel, dl });
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
                    launcher.style.right = 'auto';
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
                // 必须把 right 置 auto，否则 CSS 的 right:0 会与 inline left 冲突导致贴右
                l.style.transform = 'none';
                l.style.right = 'auto';
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

        /** 统一下载入口：由 autoDownload 分流——开=全自动最快节点直发（无感）；关=弹窗手选（脚本不接管下载） */
        download(githubUrl, filename) {
            if (!githubUrl) { this.Toast.err('链接无效'); return; }
            const name = filename || Utils.filenameFromUrl(githubUrl);
            if (Settings.get().autoDownload) this.autoDownload(githubUrl, name);
            else this.DlModal.open(githubUrl, name);
        },

        /**
         * 全自动：fresh 候选直接 fire，否则轮换预检。
         * 两个体验保障：
         *   ① 延迟展示 sticky —— fast-path 常在 150ms 内完成，立刻弹 toast 会一闪而过反而碍眼
         *   ② try/finally 释放 _autoBusy —— 异常时若不释放，自动下载将永久卡死只能刷新页面
         */
        async autoDownload(githubUrl, filename) {
            if (this._autoBusy) { this.Toast.warn('已有下载任务在进行中'); return; }
            this._autoBusy = true;
            let sticky = null;
            const timer = setTimeout(() => {
                sticky = this.Toast.sticky('正在选择最快镜像…');
            }, 150);
            const done = (kind, msg) => { sticky ? sticky[kind](msg) : this.Toast[kind](msg); };
            try {
                const r = await Downloader.runAuto(githubUrl, filename, {
                    onNode: (node, i, n, last) => {
                        if (sticky) sticky.update('(' + i + '/' + n + ') 预检 ' + Utils.shortDomain(node.url) + (last ? '（兜底直连）' : '') + '…');
                    }
                });
                clearTimeout(timer);
                if (r.ok && r.blind) done('warn', '镜像预检均失败，已对最快节点直接放行 · ' + filename);
                else if (r.ok) done('ok', '已交给浏览器下载 · ' + filename + '（' + Utils.shortDomain(r.nodeUrl) + '）');
                else done('err', r.error + '｜可点「复制链接」手动下载');
            } catch (e) {
                clearTimeout(timer);
                done('err', '下载失败：' + ((e && e.message) || '未知错误'));
                Log.error('自动下载异常', e);
            } finally {
                clearTimeout(timer);
                this._autoBusy = false;   // 异常路径也必须释放，否则功能永久卡死
            }
        },

        /** 按钮旋转态包装：执行期间加 ghb-spin 并禁用，结束（含异常路径）统一恢复 */
        async spinLoad(btn, task) {
            const svg = btn.querySelector('svg');
            if (svg) svg.classList.add('ghb-spin');
            btn.disabled = true;
            try { return await task(); }
            finally {
                if (svg) svg.classList.remove('ghb-spin');
                btn.disabled = false;
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

            /** 常驻状态提示：自动下载过程的反馈载体，结束时收敛为普通 toast */
            sticky(text) {
                const t = document.createElement('div');
                t.className = 'ghb-toast ghb-info';
                t.textContent = text;
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
                    update(msg) { if (!gone) t.textContent = msg || text; },
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
                    '  <button class="ghb-tab" data-tab="enhance">增强</button>' +
                    '  <button class="ghb-tab" data-tab="tools">工具</button>' +
                    '  <button class="ghb-tab" data-tab="settings">设置</button>' +
                    '</div>' +
                    '<div class="ghb-body">' +
                    '  <div class="ghb-page" id="ghb-page-nodes"></div>' +
                    '  <div class="ghb-page" id="ghb-page-inject"></div>' +
                    '  <div class="ghb-page" id="ghb-page-enhance"></div>' +
                    '  <div class="ghb-page" id="ghb-page-tools"></div>' +
                    '  <div class="ghb-page" id="ghb-page-settings"></div>' +
                    '</div>' +
                    '<div class="ghb-foot"><span>作者 ' + AUTHOR + '</span><span id="ghb-panel-count"></span></div>';

                root.querySelector('#ghb-panel-close').addEventListener('click', () => this.toggle());
                root.querySelectorAll('.ghb-tab').forEach((btn) => {
                    btn.addEventListener('click', () => this.switch(btn.dataset.tab));
                });
                this.renderNodesPage();
                this.renderInjectPage();
                this.renderEnhancePage();
                this.renderToolsPage();
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
                this.renderEnhancePage();
                this.renderToolsPage();
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
                    const unknown = (n.latency || 0) >= LATENCY_UNKNOWN;
                    const ms = n.latency || 0;
                    const lv = Utils.level(unknown ? LATENCY_SCALE : ms);
                    const on = NodeStore.visible.includes(n.url);
                    return '<div class="ghb-row">' +
                        '<label class="ghb-cb"><input type="checkbox" class="ghb-n-cb" data-url="' + Utils.esc(n.url) + '"' +
                            (on ? ' checked' : '') + '><span></span></label>' +
                        '<div class="ghb-main">' +
                        '  <div class="ghb-name" title="' + Utils.esc(n.url) + '">' + Utils.esc(Utils.shortDomain(n.url)) +
                                (n.builtin ? '<span class="ghb-tag" style="margin-left:6px;">内置</span>' : '') + '</div>' +
                        '  <div class="ghb-meta ghb-t-' + lv + '"><span class="ghb-bar"><i class="ghb-f-' + lv +
                        '" style="width:' + (unknown ? 2 : Utils.pct(ms)) + '%"></i></span><span>' +
                                (unknown ? '未测速' : ms + 'ms') + '</span></div>' +
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
                const ok = await View.spinLoad(btn, () => loadNodes('手动'));
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
                NodeStore.markOkMany(list.map((n) => n.url));
                NodeStore.applyProbe(list);   // 测挂节点保留池中（沉底为未测速），不删除
                View.Toast.ok('测速完成，' + list.length + ' 个节点已就绪');
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

            switchRow(id, title, desc, checked, key) {
                return '<div class="ghb-setting">' +
                    '  <label class="ghb-label" for="' + id + '">' +
                    '    <span class="ghb-lt">' + Utils.esc(title) + '</span>' +
                    '    <span class="ghb-ld">' + Utils.esc(desc || '') + '</span>' +
                    '  </label>' +
                    '  <span class="ghb-switch"><input type="checkbox" id="' + id + '"' +
                            (key ? ' data-key="' + key + '"' : '') +
                            (checked ? ' checked' : '') + '><i></i></span>' +
                    '</div>';
            },

            bindSwitches(page, onToggle) {
                page.querySelectorAll('.ghb-switch input').forEach((cb) => {
                    cb.addEventListener('change', () => onToggle(cb));
                });
            },

            renderInjectPage() {
                const page = this.root.querySelector('#ghb-page-inject');
                const cfg = Settings.get().inject;
                page.innerHTML =
                    '<div class="ghb-hint">控制各位置「镜像下载」按钮的显示。改动立即生效，已渲染的按钮需刷新页面才移除。</div>' +
                    SCENARIOS.map((s) => this.switchRow('ghb-inj-' + s.key, s.label, s.desc, cfg[s.key], s.key)).join('');

                this.bindSwitches(page, (cb) => {
                    Settings.setInject(cb.dataset.key, cb.checked);
                    const s = SCENARIOS.find((x) => x.key === cb.dataset.key);
                    View.Toast.info((cb.checked ? '已开启「' : '已关闭「') + (s ? s.label : cb.dataset.key) + '」');
                    Injector.schedule(150);
                });
            },

            renderSettingsPage() {
                const page = this.root.querySelector('#ghb-page-settings');
                const s = Settings.get();

                page.innerHTML =
                    this.switchRow('ghb-s-autorefresh', '启动时刷新节点', '打开页面时若缓存过期则自动拉取最新节点', s.refreshOnStart) +
                    this.switchRow('ghb-s-launcher', '显示侧边启动器', '关闭后可用油猴菜单「打开加速面板」呼出', s.showLauncher) +
                    this.switchRow('ghb-s-pagebtn', '显示页面内镜像按钮', '关闭后 GitHub 页面不出现注入的加速按钮，可用面板或启动器手动打开弹窗', s.showPageButtons) +
                    this.switchRow('ghb-s-auto', '全自动下载', '开启：自动选最快镜像直发（无感，失败自动换下一个）；关闭：每次下载先弹窗手选镜像', s.autoDownload) +
                    '<div class="ghb-setting">' +
                    '  <span class="ghb-label"><span class="ghb-lt">恢复默认设置</span>' +
                    '  <span class="ghb-ld">清空节点缓存与全部偏好</span></span>' +
                    '  <button class="ghb-btn ghb-danger" id="ghb-s-reset">' + Icons.reset + '重置</button>' +
                    '</div>' +
                    '<div class="ghb-about">' +
                    '  <b>' + VERSION + '</b> · 作者 ' + AUTHOR + '<br>' +
                    '  本脚本不接管下载：只负责挑选可用镜像并生成直链，下载一律走浏览器原生通道，Gopeed / IDM 等工具可正常接管。<br>' +
                    '  若浏览器无反应，点「复制链接」粘贴进下载工具即可。' +
                    '</div>';

                page.querySelector('#ghb-s-autorefresh').addEventListener('change', (e) => {
                    Settings.set({ refreshOnStart: e.target.checked });
                });
                page.querySelector('#ghb-s-auto').addEventListener('change', (e) => {
                    Settings.set({ autoDownload: e.target.checked });
                    View.Toast.info(e.target.checked
                        ? '已开启全自动：自动选最快镜像，失败自动换下一个'
                        : '已切换为手动：每次下载先弹窗手选镜像');
                });
                page.querySelector('#ghb-s-pagebtn').addEventListener('change', (e) => {
                    Settings.set({ showPageButtons: e.target.checked });
                    View.Toast.info('页面内镜像按钮已' + (e.target.checked ? '开启' : '关闭') + ',刷新页面后生效');
                });
    
                page.querySelector('#ghb-s-launcher').addEventListener('change', (e) => {
                    View.setLauncherVisible(e.target.checked);
                    View.Toast.info('侧边启动器已' + (e.target.checked ? '显示' : '隐藏'));
                });
                page.querySelector('#ghb-s-reset').addEventListener('click', () => {
                    resetAll();
                    View.restoreLauncherPos();
                    this.refresh();
                    View.Toast.ok('已恢复默认设置');
                });
            },
            renderEnhancePage() {
                const page = this.root.querySelector('#ghb-page-enhance');
                if (!page) return;
                const cfg = Settings.get().enhance;
                const rows = [
                    { key: 'groupSort', t: '文件分组排序', d: '按平台分组、按当前系统/架构排序，高亮最可能安装的包，并提供 OS / 架构手动切换' },
                    { key: 'downloadCount', t: '显示下载量', d: '通过 GitHub API 显示每个 Release 文件的下载次数（受 API 限流影响）' },
                    { key: 'replaceTime', t: '相对时间转精确时间', d: '将「2 days ago」替换为「YYYY-MM-DD HH:MM:SS」' },
                    { key: 'collapsibleNotes', t: '更新日志可折叠', d: '给 Release 更新日志增加折叠开关，默认展开' }
                ];
                page.innerHTML =
                    '<div class="ghb-hint">Release 增强显示：文件分组排序、下载量、精确时间、日志折叠，均可独立开关。改动即时生效，部分需刷新页面。</div>' +
                    rows.map((r) => this.switchRow('ghb-e-' + r.key, r.t, r.d, cfg[r.key], r.key)).join('');

                this.bindSwitches(page, (cb) => {
                    togglePref('enhance', cb.dataset.key,
                        (rows.find((x) => x.key === cb.dataset.key) || {}).t, Enhancer);
                });
            },

            renderToolsPage() {
                const page = this.root.querySelector('#ghb-page-tools');
                if (!page) return;
                const cfg = Settings.get().tools;
                const rows = [
                    { key: 'deepwiki', t: 'DeepWiki 跳转按钮', d: '在仓库页顶部操作区注入 DeepWiki 入口，新标签打开该仓库的 AI 生成 Wiki 文档；非仓库页（设置、组织等）不会注入' }
                ];
                page.innerHTML =
                    '<div class="ghb-hint">仓库页辅助工具：页面级小功能，改动即时生效，无需刷新。</div>' +
                    rows.map((r) => this.switchRow('ghb-t-' + r.key, r.t, r.d, cfg[r.key], r.key)).join('');

                this.bindSwitches(page, (cb) => {
                    togglePref('tools', cb.dataset.key,
                        (rows.find((x) => x.key === cb.dataset.key) || {}).t, Tools);
                });
            },

        },

        /* ---------- 下载弹窗 ---------- */
        DlModal: {
            url: '',
            name: '',
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
                    if (b) this.onDownload(b.dataset.node, b);
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && root.classList.contains('ghb-open')) this.close();
                });
            },

            open(githubUrl, filename) {
                this.url = githubUrl || '';
                this.name = filename || Utils.filenameFromUrl(githubUrl);
                this.root.querySelector('#ghb-dl-name').textContent = this.name;
                this.renderNodes();
                this.root.classList.add('ghb-open');

                if (!NodeStore.nodes.length) loadNodes('弹窗').then(() => this.renderNodes());
            },

            close() {
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
                    const unknown = (n.latency || 0) >= LATENCY_UNKNOWN;
                    const ms = n.latency || 0;
                    return '<div class="ghb-nrow">' +
                        '<span class="ghb-nd" title="' + Utils.esc(n.url) + '">' + Utils.esc(Utils.shortDomain(n.url)) + '</span>' +
                        '<span class="ghb-tag ghb-t-' + Utils.level(unknown ? LATENCY_SCALE : ms) + '">' +
                            (unknown ? '未测速' : ms + 'ms') + '</span>' +
                        '<button class="ghb-btn ghb-dl-go" data-node="' + Utils.esc(n.url) + '">' +
                            Icons.download + '下载</button>' +
                        '</div>';
                }).join('');
            },

            async onRefresh(btn) {
                await View.spinLoad(btn, () => loadNodes('弹窗'));
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

            async onDownload(nodeUrl, btn) {
                const target = mirrorUrl(this.url, nodeUrl);
                if (!target) { View.Toast.err('链接拼装失败'); return; }
                // fast-path:fresh 候选直接 fire
                if (NodeStore.isFresh(nodeUrl)) {
                    this.close();
                    Downloader.deliver(target, this.name);
                    View.Toast.ok('已交给浏览器下载 · ' + this.name + '｜Gopeed 等工具会自动接管');
                    return;
                }

                if (btn) { btn.disabled = true; btn.textContent = '预检中…'; }
                const head = await precheck(target, HEAD_TIMEOUT_FAST);

                if (!head.ok) {
                    NodeStore.markFail(nodeUrl);
                    if (btn) { btn.disabled = false; btn.innerHTML = Icons.download + '下载'; }
                    View.Toast.err('该节点预检失败（' + head.error + '），已记入健康度，试试其他节点');
                    return;
                }
                NodeStore.markOk(nodeUrl);
                this.close();
                Downloader.deliver(target, this.name);
                View.Toast.ok('已交给浏览器下载 · ' + this.name + '｜Gopeed 等工具会自动接管');
            }
        }
    };

    /* ======================================================================
     * L7 · BOOTSTRAP —— 装配 · Watcher(SPA 统一重扫) · 菜单 · 生命周期
     * ==================================================================== */

    /** 统一偏好开关：面板与油猴菜单共用同一条路径，杜绝两处逻辑漂移 */
    function togglePref(group, key, label, scanner) {
        const s = Settings.get();
        const next = !s[group][key];
        s[group][key] = next;
        Store.write(K.settings, s);
        View.Toast.info('「' + label + '」已' + (next ? '启用' : '禁用') + '，页面即时生效');
        scanner.scan();
        refreshMenu();
    }

    /* ---- Watcher：SPA 统一重扫（全脚本唯一的 DOM/路由监听者） ----
     * 路由变化 → 全模块重扫；DOM 增量命中关键词 → 防抖重扫；
     * 外加 turbo/pjax 事件与 5s 兜底轮询（原 Injector 职责并入）。
     * 三个能力模块只暴露幂等的 run/scan，此处可安全高频调用。 */
    const RELEVANT_RE = /download|release|archive|codeload|raw|relative-time|markdown-body|assets|pagehead-actions|repository-container-header/i;

    const Watcher = {
        _timer: null,

        schedule(ms) {
            clearTimeout(this._timer);
            this._timer = setTimeout(() => {
                // 模块间相互隔离：单个模块异常不拖垮其余注入（v1.4.0 前 Tools 会被前置异常掐死）
                try { Injector.run(); } catch (e) { Log.warn('Injector 异常', e); }
                try { Enhancer.scan(); } catch (e) { Log.warn('Enhancer 异常', e); }
                try { Tools.scan(); } catch (e) { Log.warn('Tools 异常', e); }
            }, ms || 0);
        },

        start() {
            this.schedule(500);
            let lastHref = location.href;
            const mo = new MutationObserver((records) => {
                if (location.href !== lastHref) { lastHref = location.href; this.schedule(500); return; }
                const relevant = records.some((m) => {
                    for (const n of m.addedNodes) {
                        // 只比对新增元素的开头片段：命中判断够用，且避免序列化大子树
                        if (n.nodeType === 1 && RELEVANT_RE.test((n.outerHTML || '').slice(0, 6000))) return true;
                    }
                    return false;
                });
                if (relevant) this.schedule(INJECT_DEBOUNCE);
            });
            mo.observe(document.body, { childList: true, subtree: true });
            document.addEventListener('turbo:load', () => this.schedule(300));
            document.addEventListener('pjax:end', () => this.schedule(300));
            // 兜底轮询：注入 + DeepWiki 补挂（GitHub 重渲染吞按钮后 ≤5s 自动恢复）
            setInterval(() => {
                try { Injector.run(); } catch (e) { Log.warn('Injector 异常', e); }
                try { Tools.scan(); } catch (e) { Log.warn('Tools 异常', e); }
            }, INJECT_INTERVAL);
        }
    };

    /* ---- 油猴菜单：emoji 前缀分组（原「─── 组名 ───」占位行是死菜单项，已移除） ----
     * 开关项标签带「：开 ✓ / ：关」状态，任何切换后 refreshMenu() 重注册保持一致。 */
    let menuCmds = [];

    const onOff = (v) => v ? '：开 ✓' : '：关';

    function buildMenuItems() {
        const st = Settings.get();
        const eh = st.enhance, th = st.tools;
        return [
            ['🚀 打开加速面板', () => { if (!View.Panel.open) View.Panel.toggle(); }],
            ['🔄 刷新镜像节点', () => loadNodes('菜单').then((ok) =>
                ok ? View.Toast.ok('已刷新 ' + NodeStore.nodes.length + ' 个节点') : View.Toast.err('刷新失败'))],
            ['👁 侧边启动器' + onOff(st.showLauncher), () => {
                View.setLauncherVisible(!Settings.get().showLauncher);
                View.Toast.info('侧边启动器已' + (Settings.get().showLauncher ? '显示' : '隐藏'));
                refreshMenu();
            }],
            ['⚡ 全自动下载' + onOff(st.autoDownload), () => {
                Settings.set({ autoDownload: !Settings.get().autoDownload });
                View.Toast.info('全自动下载已' + (Settings.get().autoDownload ? '开启' : '关闭'));
                refreshMenu();
            }],
            ['✨ 分组排序' + onOff(eh.groupSort), () => togglePref('enhance', 'groupSort', '文件分组排序', Enhancer)],
            ['✨ 显示下载量' + onOff(eh.downloadCount), () => togglePref('enhance', 'downloadCount', '显示下载量', Enhancer)],
            ['✨ 精确时间' + onOff(eh.replaceTime), () => togglePref('enhance', 'replaceTime', '相对时间替换', Enhancer)],
            ['✨ 日志折叠' + onOff(eh.collapsibleNotes), () => togglePref('enhance', 'collapsibleNotes', '更新日志折叠', Enhancer)],
            ['📖 DeepWiki 跳转' + onOff(th.deepwiki), () => togglePref('tools', 'deepwiki', 'DeepWiki 跳转', Tools)],
            ['⚙️ 重置全部设置', () => {
                resetAll();
                View.restoreLauncherPos();
                View.Toast.ok('已重置，刷新页面后生效');
            }]
        ];
    }

    function refreshMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        if (typeof GM_unregisterMenuCommand === 'function') {
            menuCmds.forEach((h) => { try { GM_unregisterMenuCommand(h); } catch (e) { /* 忽略 */ } });
        }
        menuCmds = [];
        buildMenuItems().forEach(([label, fn]) => {
            menuCmds.push(GM_registerMenuCommand(label, fn || (() => {})));
        });
    }

    /** 清空全部持久化数据并恢复默认（油猴菜单与设置页共用，避免两处逻辑漂移） */
    function resetAll() {
        Settings.reset();
        Store.remove(K.nodes); Store.remove(K.visible); Store.remove(K.updatedAt); Store.remove(K.fails); Store.remove(K.lastOk);
        NodeStore.nodes = []; NodeStore.visible = [];
        NodeStore.updatedAt = 0; NodeStore.fails = {}; NodeStore.lastOk = {};
        NodeStore.emit();
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

        refreshMenu();
        try { Enhancer.scan(); } catch (e) { Log.warn('Enhancer 异常', e); }
        try { Tools.scan(); } catch (e) { Log.warn('Tools 异常', e); }
        Watcher.start();   // 唯一的 SPA 监听者：驱动 Injector / Enhancer / Tools 重扫

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
