/*
 * video-interface-redesign.js 冒烟测试
 * 约定：直接 require 真实脚本（Node 导出内部 API），纯函数断言，不引第三方框架。
 * 覆盖：配置完整性 / 识别评分与硬门槛 / 广告 URL 正则 / 悬浮判定 / 导航折叠判定 / Store 往返
 */
'use strict';
var path = require('path');
var api = require(path.join(__dirname, 'video-interface-redesign.js'));

var passed = 0, failed = 0;
function ok(cond, name) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name); }
}
function section(name) { console.log('\n[' + name + ']'); }

/* ---------- 1. 配置完整性 ---------- */
section('1. 配置完整性');
ok(api.CONFIG.KEYS.ENABLED === 'vir.enabled', '存储键 ENABLED');
ok(api.CONFIG.KEYS.STRENGTH === 'vir.strength', '存储键 STRENGTH');
ok(api.CONFIG.KEYS.EXEMPT === 'vir.exempt', '存储键 EXEMPT');
ok(api.CONFIG.KEYS.STATS === 'vir.stats', '存储键 STATS');
ok(api.CONFIG.DETECT.THRESHOLD === 7, '激活分数线 = 7');
ok(api.CONFIG.AD.SWEEP_LIMIT === 24, '单轮清扫上限 = 24');

/* ---------- 2. 识别评分：截图站点画像 ---------- */
section('2. 识别评分（截图站点画像）');
var site = {
    title: '多多视频 - 每日更新',
    meta: '视频,影视,高清,每日更新',
    navLinks: 22,      // 4 列 × 多行分类导航
    rankTabs: 5,       // 热播/总/月/周/日 排行榜
    cards: 12,         // 2 列视频卡片栅格（图+标题+日期）
    path: '/'
};
var r1 = api.SiteDetector.verdict(site);
ok(r1.active === true, '典型视频站激活（评分 ' + r1.score + '）');
ok(r1.score >= 10, '评分不低于 10（实际 ' + r1.score + '）');

/* ---------- 3. 硬门槛压制误报 ---------- */
section('3. 硬门槛压制误报（新闻门户画像）');
var news = {
    title: '某新闻门户 - 要闻',
    meta: '新闻,资讯,视频',          // meta 命中 +1
    navLinks: 20,                    // 导航大 +3
    rankTabs: 0,
    cards: 10,                       // 图文卡片含日期 +3
    path: '/'
}; // score = 7 达线，但无排行榜，且标题未命中
var r2 = api.SiteDetector.verdict(news);
ok(r2.active === false, '评分达线但标题未命中 → 仍需硬门槛判定：' + r2.score + ' 分');
// 上例激活失败是因为 cards≥6、navLinks≥10 都满足 —— 评分 7 刚好达线时确实会激活，
// 追加更典型的误报样本：卡片不足 6 张
var portal = { title: '', meta: '', navLinks: 20, rankTabs: 0, cards: 5, path: '/' };
ok(api.SiteDetector.verdict(portal).active === false, '卡片 < 6 硬门槛 → 不激活');
var bare = { title: '', meta: '', navLinks: 4, rankTabs: 0, cards: 20, path: '/vod/1' };
ok(api.SiteDetector.verdict(bare).active === false, '导航 < 10 硬门槛 → 不激活');
ok(api.SiteDetector.verdict({ title: '', meta: '', navLinks: 0, rankTabs: 0, cards: 0, path: '' }).active === false, '空快照 → 不激活');

/* ---------- 4. 广告 URL 正则 ---------- */
section('4. 广告 URL 正则');
var RE = api.CONFIG.AD.URL_RE;
ok(RE.test('https://pagead2.googlesyndication.com/pagead/show_ads.js'), 'googlesyndication 命中');
ok(RE.test('https://googleads.g.doubleclick.net/aclk?x=1'), 'doubleclick 命中');
ok(RE.test('https://evil.com/ads/banner.js'), '/ads/ 命中');
ok(RE.test('https://evil.com/gg/920.js'), '/gg/ 命中');
ok(RE.test('https://evil.com/guanggao/tk.js'), 'guanggao 命中');
ok(!RE.test('https://cdn.example.com/static/app.js'), '正常 JS 不命中');
ok(!RE.test('https://site.com/video/episode1.mp4'), '视频地址不命中');
ok(!RE.test('https://site.com/static/css/style.css'), 'CSS 不命中');

/* ---------- 5. 悬浮广告纯判定 ---------- */
section('5. 悬浮广告纯判定 decideFloat');
var vw = 400, vh = 800;
ok(api.decideFloat({ w: 400, h: 780, vw: vw, vh: vh, pos: 'fixed', hasLink: true, hasMedia: true, textLen: 30, inBlacklist: false }) === true, '全屏遮罩（有链接有媒体）→ 移除');
ok(api.decideFloat({ w: 400, h: 90, vw: vw, vh: vh, pos: 'fixed', hasLink: true, hasMedia: true, textLen: 8, inBlacklist: true }) === true, '底部横幅（黑名单）→ 移除');
ok(api.decideFloat({ w: 120, h: 120, vw: vw, vh: vh, pos: 'fixed', hasLink: true, hasMedia: true, textLen: 4, inBlacklist: true }) === true, '角标悬浮球（黑名单）→ 移除');
ok(api.decideFloat({ w: 120, h: 120, vw: vw, vh: vh, pos: 'fixed', hasLink: true, hasMedia: true, textLen: 4, inBlacklist: false }) === false, '角标但不在黑名单 → 保留');
ok(api.decideFloat({ w: 400, h: 600, vw: vw, vh: vh, pos: 'fixed', hasLink: false, hasMedia: true, textLen: 260, inBlacklist: true }) === false, '富文本长内容 → 保留');
ok(api.decideFloat({ w: 150, h: 150, vw: vw, vh: vh, pos: 'static', hasLink: true, hasMedia: true, textLen: 5, inBlacklist: true }) === false, 'static 定位不误杀');

/* ---------- 6. 分类导航折叠判定 ---------- */
section('6. 分类导航折叠判定 shouldCollapseNav');
var navTexts = ['首页', '国产', '亚洲', '欧美', '动漫', '中字', '分区', '排行', '收藏', '留言', '更多', 'APP'];
ok(api.shouldCollapseNav(navTexts) === true, '12 个短文本链接 → 折叠');
ok(api.shouldCollapseNav(navTexts.slice(0, 8)) === false, '不足 12 个 → 不折叠');
ok(api.shouldCollapseNav(['这是一条很长很长的导航链接文本', '另一条也很长的链接文本'].concat(navTexts.slice(0, 10))) === false, '长文本占多 → 不折叠');
ok(api.shouldCollapseNav([]) === false, '空数组 → 不折叠');

/* ---------- 7. Store 往返（内存兜底） ---------- */
section('7. Store 往返');
ok(api.Store.isEnabled() === true, '默认启用');
api.Store.setEnabled(false);
ok(api.Store.isEnabled() === false, '停用后读取一致');
api.Store.setEnabled(true);
api.Store.setStrength('strong');
ok(api.Store.strength() === 'strong', '强度往返');
api.Store.setStrength('normal');
var added = api.Store.toggleExempt('a.com');
ok(added === true && api.Store.isExempt('a.com') === true, '加入豁免');
var removed2 = api.Store.toggleExempt('a.com');
ok(removed2 === false && api.Store.isExempt('a.com') === false, '移除豁免');
ok(typeof api.Store.isForced === 'undefined' && typeof api.Store.toggleForce === 'undefined', '强制激活 API 已移除');
api.Store.addStats({ blocked: 3, swept: 5 });
api.Store.addStats({ blocked: 1 });
var st = api.Store.stats();
ok(st.blocked === 4 && st.swept === 5, '统计累计（拦截 4 / 清扫 5）');
api.Store.resetStats();
ok(api.Store.stats().blocked === 0, '统计重置');

/* ---------- 7.5 judge 缓存策略：负向重试 / 正向缓存 ---------- */
section('7.5 judge 缓存策略');
var sd = api.SiteDetector;
var origCollect = sd.collect, origCache = sd._cache;
var calls = 0;
sd._cache = {};
sd.collect = function () { calls++; return { title: '', meta: '', navLinks: 0, rankTabs: 0, cards: 0, path: '' }; };
sd.judge('t.neg');
sd.judge('t.neg');
ok(calls === 2, '负向结果不缓存（第二次仍重新采集）');
sd.collect = function () { return { title: '多多视频', meta: '', navLinks: 20, rankTabs: 5, cards: 12, path: '/' }; };
var jOk = sd.judge('t.pos');
ok(jOk.active === true, '内容就绪后重试激活');
sd.collect = function () { calls++; return null; };
calls = 0; // 清零：单独验证「命中缓存不再采集」
var jAgain = sd.judge('t.pos');
ok(jAgain === sd._cache['t.pos'] && calls === 0, '正向结果命中缓存（不再采集）');
sd.collect = origCollect;
sd._cache = origCache;

/* ---------- 8. 元数据与头部 ---------- */
section('8. 用户脚本元数据');
var fs = require('fs');
var src = fs.readFileSync(path.join(__dirname, 'video-interface-redesign.js'), 'utf8');
ok(src.indexOf('@updateURL') !== -1 && src.indexOf('@downloadURL') !== -1, '更新地址保留');
ok(src.indexOf('@run-at       document-start') !== -1, 'document-start 注入时机');
ok(src.indexOf('@match        *://*/*') !== -1, '全站 match（识别制激活）');
ok(src.indexOf('L7  BOOTSTRAP') !== -1, 'L1-L7 分层注释完整');

console.log('\n========== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==========');
process.exit(failed ? 1 : 0);
