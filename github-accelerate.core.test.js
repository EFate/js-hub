/**
 * github-accelerate.js 核心纯函数回归测试（独立运行：node github-accelerate.core.test.js）
 *
 * 被测对象：L2 FOUNDATION 层的 Arch / Route 对象字面量。
 * 用括号计数从源文件中原样提取字面量再 eval，保证测试对象与生产代码逐字一致。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'github-accelerate.js');
const src = fs.readFileSync(SRC, 'utf8');

/** 从 startMarker 之后做花括号平衡扫描，提取完整对象字面量文本 */
function extractBlock(startMarker) {
    const a = src.indexOf(startMarker);
    if (a < 0) throw new Error('未找到标记: ' + startMarker);
    const open = src.indexOf('{', a);
    let depth = 0, inStr = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i], p = src[i - 1];
        if (inStr) {
            if (c === inStr && p !== '\\') inStr = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '{') depth++;
        if (c === '}') { depth--; if (depth === 0) return src.slice(a, i + 1); }
    }
    throw new Error('括号不平衡: ' + startMarker);
}

const archSrc = extractBlock('const Arch = {');
const routeSrc = extractBlock('const Route = {');

/** NodeStore 提取：需注入 Store/K/Log 桩与内置池常量 */
const LATENCY_UNKNOWN = 99999;
const BUILTIN_MIRRORS = [
    'https://gh-proxy.com/', 'https://ghproxy.net/', 'https://down.npee.cn/?'
];
const nodeStoreSrc = extractBlock('const NodeStore = {');
const makeNodeStore = (store) => new Function(
    'Store', 'K', 'Log', 'BUILTIN_MIRRORS', 'LATENCY_UNKNOWN', 'PRECHECK_TTL',
    nodeStoreSrc + '\n; return NodeStore;'
)(store,
  { nodes: 'n', visible: 'v', updatedAt: 'u', fails: 'f', lastOk: 'l' },
  { warn() {}, error() {} },
  BUILTIN_MIRRORS, LATENCY_UNKNOWN, 5 * 60 * 1000);
const NodeStore = makeNodeStore({ read: () => null, write() {}, remove() {} });

/** 顶层 function 声明提取（mirrorUrl 等简单函数：从标记起做花括号平衡） */
function extractFn(name) {
    const marker = 'function ' + name + '(';
    const a = src.indexOf(marker);
    if (a < 0) throw new Error('未找到函数: ' + name);
    const open = src.indexOf('{', a);
    let depth = 0, inStr = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i], p = src[i - 1];
        if (inStr) { if (c === inStr && p !== '\\') inStr = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '{') depth++;
        if (c === '}') { depth--; if (depth === 0) return src.slice(a, i + 1); }
    }
    throw new Error('括号不平衡: ' + name);
}

const mirrorUrl = new Function('return (' + extractFn('mirrorUrl').replace('function mirrorUrl', 'function') + ')')();

// navigator/location 以参数注入，隔离测试环境与真实浏览器
const sandbox = new Function(
    'navigator', 'location',
    archSrc + '\n' + routeSrc + '\n; return { Arch, Route };'
);
const { Arch, Route } = sandbox(
    { userAgent: 'windows nt 10.0', platform: 'win32', userAgentData: { arch: 'x86' } },
    { pathname: '/EFate/js-hub' }
);

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    ok ? pass++ : fail++;
    console.log((ok ? '  ✓ ' : '  ✗ ') + label +
        (ok ? '' : `  期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`));
}

console.log('--- Route.parseRepo（白名单式仓库解析） ---');
eq(Route.parseRepo('/EFate/js-hub'), { owner: 'EFate', repo: 'js-hub' }, '普通仓库页');
eq(Route.parseRepo('/NVIDIA/dgx-spark-playbooks'), { owner: 'NVIDIA', repo: 'dgx-spark-playbooks' }, '截图中的仓库');
eq(Route.parseRepo('/EFate/js-hub/blob/main/a.js'), { owner: 'EFate', repo: 'js-hub' }, '深路径只取 owner/repo');
eq(Route.parseRepo('/settings/profile'), null, 'settings 页拒绝');
eq(Route.parseRepo('/topics/es6'), null, 'topics 页拒绝');
eq(Route.parseRepo('/orgs/foo'), null, 'orgs 页拒绝');
eq(Route.parseRepo('/'), null, '根路径拒绝');

console.log('--- Route.deepWikiUrl ---');
eq(Route.deepWikiUrl({ owner: 'NVIDIA', repo: 'dgx-spark-playbooks' }),
    'https://deepwiki.com/NVIDIA/dgx-spark-playbooks', 'owner/repo 映射到 deepwiki.com');

console.log('--- Arch.getGroupClass / getTagClass（查表化后与原 if 链等价） ---');
eq(Arch.getGroupClass('windows'), 'gh-group-win', 'windows 组类');
eq(Arch.getGroupClass('linux-deb'), 'gh-group-linux-deb', 'linux-deb 组类');
eq(Arch.getGroupClass('linux-other'), 'gh-group-linux-other', 'linux-other 组类');
eq(Arch.getGroupClass('android'), 'gh-group-mobile', '移动端合并组类');
eq(Arch.getGroupClass('other'), 'gh-group-other', '其它组类');
eq(Arch.getTagClass('windows'), 'gh-tag-win', 'windows 标签类');
eq(Arch.getTagClass('other'), '', '无标签返回空');

console.log('--- Arch.parseFileGroup ---');
eq(Arch.parseFileGroup('setup.exe').id, 'windows', 'exe → windows');
eq(Arch.parseFileGroup('app.dmg').id, 'mac', 'dmg → mac');
eq(Arch.parseFileGroup('app.apk').id, 'android', 'apk → android');
eq(Arch.parseFileGroup('app.deb').id, 'linux-deb', 'deb → linux-deb');
eq(Arch.parseFileGroup('app.rpm').id, 'linux-rpm', 'rpm → linux-rpm');
eq(Arch.parseFileGroup('SHA256SUMS.sha256').id, 'meta', 'sha256 → meta');
eq(Arch.parseFileGroup('source.tar.gz').id, 'source', 'source 包 → source');

console.log('--- Arch.parseFileArch（先 64 位后 32 位） ---');
eq(Arch.parseFileArch('app-aarch64.zip'), 'arm64', 'aarch64 → arm64');
eq(Arch.parseFileArch('win-x64.exe'), 'x86_64', 'x64 → x86_64');
eq(Arch.parseFileArch('app-armv7.zip'), 'arm32', 'armv7 → arm32');
eq(Arch.parseFileArch('app-i386.zip'), 'x86', 'i386 → x86');
eq(Arch.parseFileArch('universal.dmg'), 'universal', 'universal 识别');

console.log('--- Arch.calculateMatchScore（排序语义） ---');
const winExe = Arch.calculateMatchScore('setup-x64.exe', 'windows', 'windows', 'x86_64');
const macDmg = Arch.calculateMatchScore('app.dmg', 'windows', 'mac', 'x86_64');
eq(winExe > macDmg, true, `当前 OS 组(${winExe}) 优先于其它组(${macDmg})`);
const arm64Apk = Arch.calculateMatchScore('app-arm64.apk', 'android', 'android', 'arm64');
const x64Apk = Arch.calculateMatchScore('app-x86_64.apk', 'android', 'android', 'arm64');
eq(arm64Apk > x64Apk, true, `所选架构 arm64(${arm64Apk}) 优先于 x86_64(${x64Apk})`);
const metaScore = Arch.calculateMatchScore('x.sha256', 'windows', 'meta', 'x86_64');
const srcScore = Arch.calculateMatchScore('src.tar.gz', 'windows', 'source', 'x86_64');
eq(metaScore < 0 && srcScore < 0, true, 'meta/source 沉底为负分');

console.log('--- mirrorUrl（镜像直链拼装） ---');
eq(mirrorUrl('https://github.com/a/b/releases/download/v1/x.zip', 'https://gh-proxy.com/'),
    'https://gh-proxy.com/https://github.com/a/b/releases/download/v1/x.zip', '常规前缀 / 拼接');
eq(mirrorUrl('https://github.com/a/b.zip', 'https://ghfast.top'),
    'https://ghfast.top/https://github.com/a/b.zip', '前缀无尾斜杠自动补 /');
eq(mirrorUrl('https://github.com/a/b.zip', 'https://down.npee.cn/?'),
    'https://down.npee.cn/?https://github.com/a/b.zip', '查询串式前缀免斜杠直拼');
eq(mirrorUrl('', 'https://gh-proxy.com/'), '', '空链接防御');
eq(mirrorUrl('https://github.com/a', ''), '', '空节点防御');

console.log('--- NodeStore.mergeBuiltin / dedupe（内置池统一管理） ---');
{
    // ① API 节点 + 内置池合并：API 独有节点保留，内置源全部纳入
    const apiNodes = [{ url: 'https://api-node.example/', latency: 120 }];
    const merged = NodeStore.mergeBuiltin(apiNodes);
    eq(merged.length, apiNodes.length + BUILTIN_MIRRORS.length, '合并后总数 = API + 内置');
    eq(merged[0].url, 'https://api-node.example/', 'API 节点保持在首位');
    eq(merged.slice(1).every((n) => n.builtin === true && n.latency === LATENCY_UNKNOWN),
        true, '新增内置源带 builtin 标记且为未测速');
}
{
    // ② 去重：内置池中已有节点（尾斜杠差异）不重复纳入
    const apiNodes = [{ url: 'https://gh-proxy.com/', latency: 200 }];   // 与内置池重复（仅尾斜杠差）
    const merged = NodeStore.mergeBuiltin(apiNodes);
    eq(merged.filter((n) => n.url.replace(/\/+$/, '') === 'https://gh-proxy.com').length, 1,
        '同址节点（忽略尾斜杠）只保留一条');
}
{
    // ③ dedupe：同址保留低延迟；未测速沉底；builtin 标记透传
    const duped = NodeStore.dedupe([
        { url: 'https://x.com/', latency: 500 },
        { url: 'https://x.com', latency: 100 },
        { url: 'https://y.com/', latency: LATENCY_UNKNOWN, builtin: true }
    ]);
    eq(duped.length, 2, '同址去重后剩 2 条');
    eq(duped[0].latency, 100, '保留低延迟条目');
    eq(duped[duped.length - 1].latency, LATENCY_UNKNOWN, '未测速节点沉底');
    eq(duped[duped.length - 1].builtin, true, 'builtin 标记在去重后保留');
}
{
    // ④ hydrate：旧版本缓存（仅 API 节点）加载时也并入内置池
    const cachedNodes = [{ url: 'https://api-node.example/', latency: 120 }];
    const storeData = { n: cachedNodes, v: ['https://api-node.example/'], u: 1, f: {}, l: {} };
    const store = {
        read: (k) => (storeData[k] !== undefined ? storeData[k] : null),
        write() {}, remove() {}
    };
    const NS2 = makeNodeStore(store);
    NS2.hydrate();
    eq(NS2.nodes.length, cachedNodes.length + BUILTIN_MIRRORS.length, '缓存加载后总数 = 缓存 + 内置');
    eq(NS2.nodes.some((n) => n.builtin && n.latency === LATENCY_UNKNOWN), true, '内置源以未测速并入缓存列表');
    eq(NS2.nodes[0].url, 'https://api-node.example/', '缓存 API 节点保持在首位');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
