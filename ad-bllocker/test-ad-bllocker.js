/*
 * ad-bllocker.js 冒烟测试
 * 约定：直接 require 真实脚本（Node 导出内部 API），纯函数断言，不引第三方框架。
 * 覆盖：配置完整性 / 广告 URL 指纹 / 悬浮判定 / 赞助角标正则 / Store 与白名单 / NetGuard 注入拦截 / 元数据
 */
'use strict';
var path = require('path');
var api = require(path.join(__dirname, 'ad-bllocker.js'));

var passed = 0, failed = 0;
function ok(cond, name) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name); }
}
function section(name) { console.log('\n[' + name + ']'); }

/* ---------- 1. 配置完整性 ---------- */
section('1. 配置完整性');
ok(api.CONFIG.KEYS.ENABLED === 'bl.enabled', '存储键 ENABLED');
ok(api.CONFIG.KEYS.STRONG === 'bl.strong', '存储键 STRONG');
ok(api.CONFIG.KEYS.LAUNCHER === 'bl.launcher', '存储键 LAUNCHER');
ok(api.CONFIG.KEYS.WHITELIST === 'bl.whitelist', '存储键 WHITELIST');
ok(api.CONFIG.KEYS.STATS === 'bl.stats', '存储键 STATS');
ok(api.CONFIG.AD.SWEEP_LIMIT === 24, '单轮清扫上限 = 24');

/* ---------- 2. 广告 URL 指纹 ---------- */
section('2. 广告 URL 指纹');
var RE = api.CONFIG.AD.URL_RE;
ok(RE.test('https://pagead2.googlesyndication.com/pagead/show_ads.js'), 'googlesyndication');
ok(RE.test('https://googleads.g.doubleclick.net/aclk?x=1'), 'doubleclick');
ok(RE.test('https://evil.com/ads/banner.js'), '/ads/ 路径');
ok(RE.test('https://evil.com/gg/920.js'), '/gg/ 路径');
ok(RE.test('https://cjp.ddsp3.work/abc/fixed_ui_f7f7a6.js'), '/abc/ 模板注入器');
ok(RE.test('https://site.com/000/flink/analytics.php'), '/000/ 统计通道');
ok(RE.test('https://s.popads.net/pop.js'), 'popads');
ok(RE.test('https://main.exoclick.com/tag.js'), 'exoclick');
ok(RE.test('https://onesignal.com/sdks/web/v16/OneSignalSDK.page.js'), 'OneSignal 推送诱导');
ok(RE.test('https://coinhive.com/lib/coinhive.min.js'), 'coinhive 矿机');
ok(RE.test('https://evil.com/minero/lib.js'), 'minero 矿机');
ok(!RE.test('https://cdn.example.com/static/app.js'), '正常 JS 不命中');
ok(!RE.test('https://site.com/video/episode1.mp4'), '视频地址不命中');
ok(!RE.test('https://site.com/static/css/style.css'), 'CSS 不命中');
ok(!RE.test('https://cdn.bootcdn.net/ajax/libs/jquery/3.6.0/jquery.min.js'), '公共 CDN jQuery 不命中');

/* ---------- 3. 悬浮广告纯判定 decideFloat ---------- */
section('3. 悬浮广告纯判定 decideFloat');
var vw = 1280, vh = 800;
ok(api.decideFloat({ w: 1280, h: 780, vw: vw, vh: vh, pos: 'fixed', hasLink: true, hasMedia: true, textLen: 30, inBlacklist: false }) === true, '全屏遮罩（有链接有媒体）→ 移除');
ok(api.decideFloat({ w: 1280, h: 90, vw: vw, vh: vh, pos: 'fixed', hasLink: true, hasMedia: true, textLen: 8, inBlacklist: true }) === true, '底部地板条（黑名单）→ 移除');
ok(api.decideFloat({ w: 120, h: 120, vw: vw, vh: vh, pos: 'fixed', hasLink: true, hasMedia: true, textLen: 4, inBlacklist: true }) === true, '角标悬浮（黑名单）→ 移除');
ok(api.decideFloat({ w: 120, h: 120, vw: vw, vh: vh, pos: 'fixed', hasLink: true, hasMedia: true, textLen: 4, inBlacklist: false }) === false, '角标但不在黑名单 → 保留');
ok(api.decideFloat({ w: 1280, h: 700, vw: vw, vh: vh, pos: 'fixed', hasLink: false, hasMedia: true, textLen: 260, inBlacklist: true }) === false, '富文本长内容 → 保留');
ok(api.decideFloat({ w: 300, h: 250, vw: vw, vh: vh, pos: 'static', hasLink: true, hasMedia: true, textLen: 5, inBlacklist: true }) === false, 'static 定位不误杀');
ok(api.decideFloat({ w: 728, h: 90, vw: vw, vh: vh, pos: 'fixed', hasLink: true, hasMedia: true, textLen: 6, inBlacklist: false }) === true, '顶部 leaderboard（fixed + 链接）→ 移除');

/* ---------- 4. 类名黑名单与赞助角标 ---------- */
section('4. 类名黑名单与赞助角标');
var NAME = api.CONFIG.AD.NAME_RE;
ok(NAME.test('ad-box'), 'ad-box 命中');
ok(NAME.test('gg-banner'), 'gg-banner 命中');
ok(NAME.test('kefu-float'), '客服浮窗命中');
ok(NAME.test('downapp-tip'), 'APP 下载条命中');
ok(!NAME.test('article'), 'article 不命中');
ok(!NAME.test('header'), 'header 不命中');
ok(!NAME.test('navigation'), 'navigation 不命中');
var SP = api.CONFIG.AD.SPONSOR_RE;
ok(SP.test('广告'), '角标「广告」');
ok(SP.test('推广'), '角标「推广」');
ok(SP.test('Sponsored'), '角标 Sponsored');
ok(SP.test('AD'), '角标 AD');
ok(!SP.test('广告位招租热线电话'), '长文本不命中');
ok(!SP.test('办理广告业务请联系'), '长文本不命中 2');

/* ---------- 5. Store 与白名单 ---------- */
section('5. Store 与白名单');
ok(api.Store.isEnabled() === true, '默认启用');
ok(api.Store.isStrong() === false, '默认标准模式');
ok(api.Store.showLauncher() === true, '默认显示悬浮球');
api.Store.setEnabled(false);
ok(api.Store.isEnabled() === false, '停用后读取一致');
api.Store.setEnabled(true);
api.Store.setStrong(true);
ok(api.Store.isStrong() === true, '强力模式往返');
api.Store.setStrong(false);
ok(api.Store.addWhitelist('a.com') === true, '加入白名单');
ok(api.Store.isWhitelisted('a.com') === true, '白名单命中');
ok(api.Store.addWhitelist('a.com') === false, '重复加入返回 false');
ok(api.Store.removeWhitelist('a.com') === true, '移出白名单');
ok(api.Store.isWhitelisted('a.com') === false, '移出后不命中');
api.Store.addStats({ blocked: 3, swept: 5 });
api.Store.addStats({ blocked: 1 });
var st = api.Store.stats();
ok(st.blocked === 4 && st.swept === 5, '统计累计（拦截 4 / 清扫 5）');
api.Store.resetStats();
ok(api.Store.stats().blocked === 0, '统计重置');
api.Store.resetAll();
ok(api.Store.isEnabled() === true && api.Store.getWhitelist().length === 0, '恢复默认设置');

/* ---------- 6. NetGuard 注入拦截（假 DOM + 原型 setter 桩） ---------- */
section('6. NetGuard 注入拦截');
var NG = api.NetGuard;
NG.active = true;
var captured = [];
function FakeScriptEl() { this.tagName = 'SCRIPT'; }
// 给原型挂 src setter 桩（脚本从 prototype 取描述符）
Object.defineProperty(FakeScriptEl.prototype, 'src', {
    configurable: true, enumerable: true,
    get: function () { return this._src; },
    set: function (v) { this._src = v; captured.push(v); }
});
var fakeDoc = {
    createElement: function () { return new FakeScriptEl(); }
};
// 用桩临时替换取描述符的原型来源不可行（脚本直引 HTMLScriptElement）——
// Node 环境无该原型，_armSrcGuard 会安全返回（d 为 null），此处验证不抛异常
var el;
try { el = NG._armSrcGuard(new FakeScriptEl()); ok(true, '_armSrcGuard 在 Node 环境安全返回'); }
catch (e) { ok(false, '_armSrcGuard 抛异常: ' + e.message); }
NG.active = false;

/* ---------- 7. 元数据与头部 ---------- */
section('7. 用户脚本元数据');
var fs = require('fs');
var src = fs.readFileSync(path.join(__dirname, 'ad-bllocker.js'), 'utf8');
ok(src.indexOf('@updateURL') !== -1 && src.indexOf('@downloadURL') !== -1, '更新地址保留');
ok(src.indexOf('ad-bllocker/ad-bllocker.js') !== -1, '更新地址指向 ad-bllocker 目录');
ok(src.indexOf('@run-at       document-start') !== -1, 'document-start 注入时机');
ok(src.indexOf('@match        *://*/*') !== -1, '全站 match');
ok(src.indexOf('L6  BOOTSTRAP') !== -1, 'L1-L6 分层注释完整');
ok(src.indexOf('data-slots') !== -1, '广告位通道存在');
ok(src.indexOf('SPONSOR_RE') !== -1, '赞助角标通道存在');
ok(src.indexOf('LayoutEngine') === -1 && src.indexOf('vir-grid') === -1, '无界面重组残留');

console.log('\n========== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==========');
process.exit(failed ? 1 : 0);
