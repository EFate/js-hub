/**
 * github-accelerate.js Tools（DeepWiki 注入）回归测试
 * 运行：node github-accelerate.tools.test.js
 *
 * 用例 1 的 DOM 结构逐字复刻自 github.com/microsoft/vscode 服务端 HTML
 * （v1.4.1 修复所依据的真实结构）：
 *   #repository-container-header
 *     └ div（flex 行）
 *        ├ 标题区
 *        └ div > ul（Watch/Fork/Star 动作列表）
 *                 └ li > a > div > span#repo-stars-counter-star
 *
 * 做法括号平衡提取真实 Tools 对象字面量原样 eval（配合真实 Route 与
 * Settings 桩），保证被测代码与生产逐字一致。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'github-accelerate.js'), 'utf8');

function extractBlock(startMarker) {
    const a = SRC.indexOf(startMarker);
    if (a < 0) throw new Error('未找到标记: ' + startMarker);
    const open = SRC.indexOf('{', a);
    let depth = 0, inStr = null;
    for (let i = open; i < SRC.length; i++) {
        const c = SRC[i], p = SRC[i - 1];
        if (inStr) { if (c === inStr && p !== '\\') inStr = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '/' && SRC[i + 1] === '/') { while (i < SRC.length && SRC[i] !== '\n') i++; continue; }
        if (c === '{') depth++;
        if (c === '}') { depth--; if (depth === 0) return SRC.slice(a, i + 1); }
    }
    throw new Error('括号不平衡: ' + startMarker);
}

const routeSrc = extractBlock('const Route = {');
const toolsSrc = extractBlock('const Tools = {');
const realRoute = new Function('return (' + routeSrc.replace('const Route = ', '') + ')')();

/* ---------- 极简假 DOM ---------- */
function node(tag, id) {
    return {
        tagName: String(tag).toUpperCase(),
        id: id || '',
        parentElement: null,
        children: [],
        style: {},
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; },
        addEventListener() { /* 测试不需要真实事件 */ },
        appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
        prepend(c) { c.parentElement = this; this.children.unshift(c); return c; },
        contains(n) {
            for (const ch of this.children) {
                if (ch === n || ch.contains(n)) return true;
            }
            return false;
        },
        querySelector(sel) {
            const wantId = sel.includes('#repo-stars-counter-star') ? 'repo-stars-counter-star' : null;
            const wantHrefEnd = /a\[href\$="(\/[^"]+)"\]/.exec(sel);   // a[href$="/watchers"] 等
            const walk = (n) => {
                for (const ch of n.children) {
                    if (wantId && ch.id === wantId) return ch;
                    if (wantHrefEnd && ch.tagName === 'A' &&
                        typeof ch.attrs.href === 'string' && ch.attrs.href.endsWith(wantHrefEnd[1])) return ch;
                    const hit = walk(ch);
                    if (hit) return hit;
                }
                return null;
            };
            return walk(this);
        }
    };
}

/** vscode 真实仓库头结构（含动作列表 ul） */
function vscodeHeaderDom() {
    const head = node('div'); head.id = 'repository-container-header';
    const flexRow = node('div');
    const titleArea = node('div');
    const actionsWrap = node('div');
    const ul = node('ul');                       // Watch / Fork / Star 动作列表
    const li = node('li');
    const a = node('a');
    const div = node('div');
    const counter = node('span', 'repo-stars-counter-star');
    div.appendChild(counter);
    a.appendChild(div);
    li.appendChild(a);
    ul.appendChild(li);
    actionsWrap.appendChild(ul);
    flexRow.appendChild(titleArea);
    flexRow.appendChild(actionsWrap);
    head.appendChild(flexRow);
    return { head, ul, counter };
}

function makeTools(doc, pathname) {
    const Settings = { get: () => ({ tools: { deepwiki: true } }) };
    return new Function('Settings', 'Route', 'document', 'location',
        toolsSrc + '\n; return Tools;')(
        Settings, realRoute, doc, { pathname: pathname || '/microsoft/vscode' });
}

let pass = 0, fail = 0;
function ok(cond, label) {
    cond ? pass++ : fail++;
    console.log((cond ? '  ✓ ' : '  ✗ ') + label);
}

console.log('--- Tools.findBar（锚点降级链，v1.4.1） ---');

/* 用例 1：vscode 真实结构 —— 必须命中动作列表 ul，而非外层 flex 行 */
{
    const dom = vscodeHeaderDom();
    const Tools = makeTools({
        querySelector: (sel) => {
            if (sel === 'ul.pagehead-actions') return null;
            if (sel === '#repository-container-header') return dom.head;
            return null;
        }
    });
    const bar = Tools.findBar();
    ok(bar === dom.ul, 'vscode 真实结构：命中 Watch/Fork/Star 动作列表 <ul>');
    ok(bar.contains(dom.counter), '锚点包含 Star 计数器（同列表）');
}

/* 用例 2：Star 计数器 id 消失 —— watchers 链接兜底仍命中同一列表 */
{
    const dom = vscodeHeaderDom();
    // 移除 counter 的 id（模拟 GitHub 再次改版）
    dom.counter.id = '';
    // 真实 DOM 中 Watch 计数也是 a[href$="/watchers"]，补进列表
    const watch = node('a'); watch.attrs.href = '/microsoft/vscode/watchers';
    const wli = node('li'); wli.appendChild(watch); dom.ul.appendChild(wli);
    const Tools = makeTools({
        querySelector: (sel) => {
            if (sel === 'ul.pagehead-actions') return null;
            if (sel === '#repository-container-header') return dom.head;
            if (sel.startsWith('a[href$="/watchers"]')) return watch;
            return null;
        }
    });
    ok(Tools.findBar() === dom.ul, 'id 改版后：watchers 链接兜底命中同一动作列表');
}

/* 用例 3：旧版 UI —— ul.pagehead-actions 优先 */
{
    const ul = node('ul');
    const Tools = makeTools({ querySelector: (sel) => sel === 'ul.pagehead-actions' ? ul : null });
    ok(Tools.findBar() === ul, '旧版 UI：优先命中 ul.pagehead-actions');
}

/* 用例 4：无任何锚点 —— 返回 null 留待重扫 */
{
    const Tools = makeTools({ querySelector: () => null });
    ok(Tools.findBar() === null, '无锚点：返回 null（留待 Watcher 重扫）');
}

/* 用例 5：仓库页 scan() —— 注入进动作列表，href / 安全属性正确 */
{
    const dom = vscodeHeaderDom();
    const Tools = makeTools({
        querySelector: (sel) => {
            if (sel === 'ul.pagehead-actions') return null;
            if (sel === '#repository-container-header') return dom.head;
            return null;
        },
        getElementById: () => null,
        createElement: (tag) => node(tag)
    });
    ok(Tools.scan() === true, '仓库页 scan() 注入成功');
    ok(dom.ul.children[0] && dom.ul.children[0].id === 'gh-deepwiki-li',
        '按钮以 <li> 挂入动作列表首位（与 Watch/Fork/Star 同排）');
    const a = dom.ul.children[0].children[0];
    ok(!!a && a.getAttribute('href') === 'https://deepwiki.com/microsoft/vscode',
        'href 指向 deepwiki.com/microsoft/vscode');
    ok(a && a.getAttribute('target') === '_blank' &&
        a.getAttribute('rel') === 'noopener noreferrer', '新标签页 + noopener 安全属性');
}

/* 用例 6：幂等 —— 二次 scan 不重复注入，路由切换只校正 href */
{
    const dom = vscodeHeaderDom();
    let created = 0;
    const Tools = makeTools({
        querySelector: (sel) => {
            if (sel === '#repository-container-header') return dom.head;
            return null;
        },
        getElementById: () => null,
        createElement: (tag) => { created++; return node(tag); }
    });
    Tools.scan();
    const afterFirst = created;   // build() 每次创建 li + a 两个元素
    // 把已注入节点接到 getElementById 上（模拟真实 DOM 状态）
    const injected = dom.ul.children.find((c) => c.id === 'gh-deepwiki-li');
    ok(!!injected, '（前置）首次注入已存在于动作列表');
    const Tools2 = makeTools({
        querySelector: () => null,
        getElementById: (id) => id === 'gh-deepwiki-li' ? injected : null,
        createElement: (tag) => { created++; return node(tag); }
    });
    const r2 = Tools2.scan();
    ok(r2 === true && created === afterFirst, '二次 scan 幂等：不重复创建按钮' +
        (r2 !== true ? '（scan 返回 ' + r2 + '）' : created !== afterFirst ? '（created ' + afterFirst + '→' + created + '）' : ''));
}

/* 用例 7：非仓库页（settings）—— 不注入并移除已有按钮 */
{
    const existing = node('li');
    const removed = { v: false };
    existing.remove = function () { removed.v = true; };
    const Tools = makeTools({
        querySelector: () => null,
        getElementById: (id) => id === 'gh-deepwiki-li' ? existing : null,
        createElement: (tag) => node(tag)
    }, '/settings/profile');
    ok(realRoute.parseRepo('/settings/profile') === null, 'Route 判定 settings 非仓库页');
    ok(Tools.scan() === false && removed.v, '非仓库页：scan() 返回 false 并移除旧按钮');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
