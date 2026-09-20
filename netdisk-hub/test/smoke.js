/**
 * 冒烟测试：直接 require 真实脚本，验证核心纯函数与两条下载通道的请求体构造。
 * 运行：node test/smoke.js
 */
const assert = require("assert");
const mod = require("../netdisk-hub.user.js");

const { VERSION, KEY, util, store, aria, providers, providerApi, engine, catcher, inject, pageState } = mod;

let pass = 0;
let fail = 0;
const groups = [];

function group(name) { groups.push(name); console.log("\n[" + name + "]"); }
function t(name, fn) {
	try { fn(); pass++; console.log("  ok   " + name); }
	catch (e) { fail++; console.log("  FAIL " + name + "  ->  " + e.message); }
}

/* ---------------- 工具层 ---------------- */
group("util");

t("fixFilename 过滤文件系统非法字符", () => {
	assert.strictEqual(util.fixFilename('a/b:c*d?e"f<g>h|i\\j'), "a_b_c_d_e_f_g_h_i_j");
});
t("fixFilename 空值回退", () => {
	assert.strictEqual(util.fixFilename(""), "download");
	assert.strictEqual(util.fixFilename(null), "download");
	assert.strictEqual(util.fixFilename(undefined, "x.bin"), "x.bin");
});
t("fixFilename 保留中文与空格", () => {
	assert.strictEqual(util.fixFilename("我的 文件.zip"), "我的 文件.zip");
});

t("sizeFormat 分级换算", () => {
	assert.strictEqual(util.sizeFormat(0), "0 B");
	assert.strictEqual(util.sizeFormat(1024), "1.00 KiB");
	assert.strictEqual(util.sizeFormat(1536), "1.50 KiB");
	assert.strictEqual(util.sizeFormat(1048576), "1.00 MiB");
	assert.strictEqual(util.sizeFormat(1073741824), "1.00 GiB");
});
t("sizeFormat 非法输入回退", () => {
	assert.strictEqual(util.sizeFormat(-1), "-");
	assert.strictEqual(util.sizeFormat("abc"), "-");
	assert.strictEqual(util.sizeFormat(undefined), "-");
});

t("standHeaders 键名归一化为驼峰", () => {
	assert.deepStrictEqual(util.standHeaders({ "user-agent": "x", "referer": "y" }), { "User-Agent": "x", "Referer": "y" });
});
t("standHeaders 解析原始字符串", () => {
	assert.deepStrictEqual(util.standHeaders("A: 1\r\nB: 2"), { A: "1", B: "2" });
});
t("headersToArray 生成 Aria2 header 数组", () => {
	assert.deepStrictEqual(util.headersToArray({ "user-agent": "x" }), ["User-Agent: x"]);
});
t("nameFromUrl 仅在带扩展名时才采用", () => {
	assert.strictEqual(util.nameFromUrl("https://a.com/b/c%20d.zip"), "c d.zip");
	assert.strictEqual(util.nameFromUrl("https://a.com/api/usercode"), "", "接口路径段不应被当文件名");
	assert.strictEqual(util.nameFromUrl("https://a.com/"), "");
});
t("escapeHtml 防注入", () => {
	assert.strictEqual(util.escapeHtml('<img src=x onerror="a">'), "&lt;img src=x onerror=&quot;a&quot;&gt;");
});

/* ---------------- Aria2 通道 ---------------- */
group("aria");

t("rpcUrl 标准配置", () => {
	assert.strictEqual(aria.rpcUrl({ domain: "http://localhost", port: "6800", path: "/jsonrpc" }),
		"http://localhost:6800/jsonrpc");
});
t("rpcUrl 容错：协议缺失、斜杠多余、路径无前导斜杠", () => {
	assert.strictEqual(aria.rpcUrl({ domain: "localhost", port: "6800", path: "jsonrpc" }),
		"http://localhost:6800/jsonrpc");
	assert.strictEqual(aria.rpcUrl({ domain: "http://localhost/", port: ":6800", path: "/jsonrpc" }),
		"http://localhost:6800/jsonrpc");
});
t("rpcUrl 端口留空时省略", () => {
	assert.strictEqual(aria.rpcUrl({ domain: "http://localhost", port: "", path: "/jsonrpc" }),
		"http://localhost/jsonrpc");
});
t("buildAddUri 未设密钥时省略 secret", () => {
	const body = aria.buildAddUri({ token: "" }, { url: "https://f/1.zip", out: "1.zip" });
	assert.strictEqual(body.method, "aria2.addUri");
	assert.strictEqual(body.jsonrpc, "2.0");
	assert.strictEqual(body.params.length, 2);
	assert.deepStrictEqual(body.params[0], ["https://f/1.zip"]);
	assert.strictEqual(body.params[1].out, "1.zip");
});
t("buildAddUri 设置密钥时携带 token", () => {
	const body = aria.buildAddUri({ token: "abc" }, { url: "https://f/1.zip", out: "1.zip" });
	assert.strictEqual(body.params.length, 3);
	assert.strictEqual(body.params[0], "token:abc");
});
t("buildAddUri 透传请求头与保存目录", () => {
	const body = aria.buildAddUri({ token: "", dir: "/dl" },
		{ url: "u", out: "n", headers: { "User-Agent": "pan.baidu.com" } });
	assert.strictEqual(body.params[1].dir, "/dl");
	assert.deepStrictEqual(body.params[1].header, ["User-Agent: pan.baidu.com"]);
});
t("buildAddUri 空 dir 不写入 options", () => {
	const body = aria.buildAddUri({ token: "", dir: "" }, { url: "u", out: "n" });
	assert.strictEqual("dir" in body.params[1], false);
});
t("buildVersion 请求体", () => {
	assert.deepStrictEqual(aria.buildVersion({ token: "" }).params, []);
	assert.deepStrictEqual(aria.buildVersion({ token: "k" }).params, ["token:k"]);
});
t("toCommand 生成 aria2c 命令行", () => {
	const cmd = aria.toCommand({ url: "https://f/a b.zip", out: "a b.zip", headers: { "User-Agent": "ua" } });
	assert.ok(cmd.startsWith("aria2c "), "应以 aria2c 开头");
	assert.ok(cmd.includes('--out "a b.zip"'), "应包含 --out");
	assert.ok(cmd.includes('--header="User-Agent: ua"'), "应包含 header");
	assert.ok(cmd.includes("--continue=true"), "应支持断点续传");
});

/* ---------------- 网盘适配层 ---------------- */
group("providers");

t("适配器可按 id 取用", () => {
	assert.strictEqual(providerApi.byId("baidu").name, "百度网盘");
	assert.strictEqual(providerApi.byId("nope"), null);
});
t("域名匹配规则", () => {
	const hit = (host) => {
		for (let i = 0; i < providers.length; i++) if (providers[i].match.test(host)) return providers[i].id;
		return null;
	};
	assert.strictEqual(hit("pan.baidu.com"), "baidu");
	assert.strictEqual(hit("yun.baidu.com"), "baidu");
	assert.strictEqual(hit("pan.quark.cn"), "quark");
	assert.strictEqual(hit("drive.uc.cn"), "uc", "UC 是独立一家，应命中 uc 而非夸克");
	assert.strictEqual(hit("www.aliyundrive.com"), null, "未保留的网盘不应命中");
	assert.strictEqual(hit("www.123pan.com"), null, "未保留的网盘不应命中");
	assert.strictEqual(hit("example.com"), null);
});
t("每个适配器都提供请求头来源与提示语", () => {
	providers.forEach((p) => {
		assert.ok(p.id && p.name, "需有 id 与 name");
		const hasHeader = p.header && typeof p.header === "object";
		// 百度把 UA 写在 header 里，夸克单列 ua 字段（要求客户端 UA）
		assert.ok(hasHeader || typeof p.ua === "string", p.id + " 缺少 header 或 ua");
		assert.ok(typeof p.hint === "string" && p.hint.length > 0, p.id + " 缺少 hint");
	});
});
t("每个适配器都配置了按页面分组的挂载点", () => {
	providers.forEach((p) => {
		assert.ok(p.mount && typeof p.mount === "object", p.id + " 缺少 mount");
		["home", "share"].forEach((k) => {
			assert.ok(Array.isArray(p.mount[k]) && p.mount[k].length > 0, p.id + " 缺少 " + k + " 挂载点");
			p.mount[k].forEach((sel) => {
				assert.ok(typeof sel === "string" && sel.length > 0, p.id + "." + k + " 选择器须为非空字符串");
			});
		});
	});
});
t("挂载点选择器不含 :has()（旧内核兼容红线）", () => {
	providers.forEach((p) => {
		Object.keys(p.mount).forEach((k) => {
			p.mount[k].forEach((sel) => {
				assert.strictEqual(sel.indexOf(":has("), -1, p.id + "." + k + " 含 :has()：" + sel);
			});
		});
	});
});
t("每个适配器都配置了页面类型识别规则", () => {
	providers.forEach((p) => {
		assert.ok(p.pages && p.pages.home instanceof RegExp && p.pages.share instanceof RegExp, p.id + " 缺少 pages");
	});
});
t("页面判据能区分 home / share", () => {
	const hit = (id, path) => {
		const p = providerApi.byId(id);
		if (p.pages.home.test(path)) return "home";
		if (p.pages.share.test(path)) return "share";
		return "";
	};
	assert.strictEqual(hit("baidu", "/disk/main"), "home");
	assert.strictEqual(hit("baidu", "/disk/home"), "home");
	assert.strictEqual(hit("baidu", "/s/1abc"), "share");
	assert.strictEqual(hit("baidu", "/login"), "");
	assert.strictEqual(hit("quark", "/list"), "home");
});
t("selectorsFor 在页面类型未知时合并全部候选", () => {
	const sel = inject.selectorsFor(providerApi.byId("baidu"));
	assert.ok(sel.length >= 2, "应合并 home 与 share 候选：" + JSON.stringify(sel));
});

/* ---------------- 页面状态层 ---------------- */
group("pageState");

t("findReact / findVue / propsOf / win 均为函数", () => {
	["findReact", "findVue", "propsOf", "win"].forEach((k) => {
		assert.strictEqual(typeof pageState[k], "function", "缺少方法：" + k);
	});
});
t("无 DOM 环境下三个取数方法都安全返回 null", () => {
	assert.strictEqual(pageState.findReact(null), null);
	assert.strictEqual(pageState.findVue(null), null);
	assert.strictEqual(pageState.propsOf(null), null);
});
t("真实 fiber 形态：能从 host fiber 上探到组件实例", () => {
	const props = { list: [{ fid: "a" }], selectedRowKeys: ["a"] };
	const dom = {};
	dom["__reactFiber$test"] = { type: "div", return: { type: function C() {}, stateNode: { props } } };
	const found = pageState.propsOf(pageState.findReact(dom));
	assert.strictEqual(found, props, "应取到组件的 props");
});
t("每个适配器都实现了 collect（读取勾选文件）", () => {
	providers.forEach((p) => {
		assert.strictEqual(typeof p.collect, "function", p.id + " 缺少 collect");
	});
});
t("百度与夸克均已接入自动换链", () => {
	assert.strictEqual(typeof providerApi.byId("quark").resolve, "function", "夸克应支持换直链");
	assert.strictEqual(typeof providerApi.byId("baidu").resolve, "function", "百度应支持换直链");
});
t("baiduShareInfo 逐项兜底收集分享参数（缺失环境返回完整空结构而不抛错）", () => {
	const info = providerApi.baiduShareInfo();
	assert.ok(typeof info === "object" && info !== null);
	["surl", "baiduId", "uk", "shareId", "bdstoken", "jsToken", "sekey"].forEach((k) => {
		assert.ok(k in info, "缺少字段 " + k);
	});
});
t("util.b64 结果与 Node Buffer 一致（百度 logid 参数依赖）", () => {
	assert.strictEqual(util.b64("ABCDEF0123456789"), Buffer.from("ABCDEF0123456789", "utf8").toString("base64"));
	assert.strictEqual(util.b64("中文"), Buffer.from("中文", "utf8").toString("base64"));
	assert.strictEqual(util.b64(""), "");
});
t("只保留百度 / 夸克 / UC 三家，且三家都是完整实现", () => {
	const ids = providers.map((p) => p.id).sort();
	assert.deepStrictEqual(ids, ["baidu", "quark", "uc"], "适配器应恰好三家：" + ids.join(", "));
	providers.forEach((p) => {
		assert.strictEqual(typeof p.resolve, "function", p.id + " 缺少换链实现（不应存在只能识别不能换链的网盘）");
		assert.ok(p.pages && p.pages.home, p.id + " 缺少 pages.home");
		assert.ok(p.mount && p.mount.home && p.mount.home.length, p.id + " 缺少 home 挂载点");
		assert.strictEqual(typeof p.collect, "function", p.id + " 缺少 collect");
	});
});

/* ---------------- 文件夹判据 / 下载请求头 / 分享 ID ---------------- */
group("providers 辅助");

t("isFolder 按各网盘的真实字段识别文件夹", () => {
	// 夸克的真实字段是 file（false 表示文件夹），页面里没有 dir ——
	// 早先只判 dir，于是文件夹被当成文件送进换链接口，自然什么也取不回来
	assert.strictEqual(providerApi.isFolder({ file: false }), true, "夸克：file=false 是文件夹");
	assert.strictEqual(providerApi.isFolder({ file: true }), false, "夸克：file=true 是文件");
	assert.strictEqual(providerApi.isFolder({ isdir: true }), true, "百度");
	assert.strictEqual(providerApi.isFolder({ dir: true }), true, "兜底字段");
	assert.strictEqual(providerApi.isFolder({}), false, "字段缺失时按文件处理");
	assert.strictEqual(providerApi.isFolder(null), false, "空值不应抛错");
});
t("downloadHeaders 保留网盘声明的头，未标记 credential 的不补页面头", () => {
	const q = providerApi.downloadHeaders(providerApi.byId("quark"));
	assert.ok(/quark-cloud-drive/.test(q["User-Agent"] || ""), "应含夸克客户端 UA");
});
t("夸克声明了 credential（其直链校验 Referer 与 Cookie）", () => {
	assert.strictEqual(providerApi.byId("quark").credential, true);
});
t("sharePwdId 在无页面统计对象时安全返回空串", () => {
	assert.strictEqual(typeof providerApi.sharePwdId(), "string");
});
t("put 支持随行请求头入库（推送 Aria2 时携带）", () => {
	catcher.clear();
	catcher.put("https://cdn.quark.cn/a.mp4?x=1", "a.mp4", 10, "接口", true, { Referer: "https://pan.quark.cn/" });
	assert.strictEqual(catcher.pool.length, 1);
	assert.strictEqual(catcher.pool[0].headers.Referer, "https://pan.quark.cn/");
	catcher.put("https://cdn.quark.cn/b.mp4?x=1", "b.mp4", 10, "请求", true);
	assert.strictEqual(catcher.pool[0].headers, null, "未提供时存 null，不臆造");
	catcher.clear();
});
t("同名文件视为同一条：重新获取不会堆叠重复", () => {
	catcher.clear();
	// 直链带签名，两次换取 URL 不同 —— 按 URL 去重挡不住，这正是重复的来源
	catcher.put("https://cdn.quark.cn/dl/1?sign=old", "影片A.mp4", 100, "接口", true);
	catcher.put("https://cdn.quark.cn/dl/1?sign=new", "影片A.mp4", 100, "接口", true);
	assert.strictEqual(catcher.pool.length, 1, "同名只留一条");
	assert.ok(catcher.pool[0].url.indexOf("sign=new") > 0, "应换成新签名");
	// 不同的文件各占一条，且最新的置顶
	catcher.put("https://cdn.quark.cn/dl/2?sign=x", "影片B.mp4", 100, "接口", true);
	assert.strictEqual(catcher.pool.length, 2);
	assert.ok(/影片B/.test(catcher.pool[0].name), "最新入库的应置顶");
	catcher.clear();
});
t("拿不到文件名时退回按 URL 去重，无名条目不会挤成一条", () => {
	catcher.clear();
	catcher.put("https://x.com/api/usercode?a=1", "", 0, "响应头", true);
	catcher.put("https://x.com/api/report?a=1", "", 0, "响应头", true);
	assert.strictEqual(catcher.pool.length, 2, "无名条目应各自保留");
	catcher.clear();
});
t("夸克与 UC 各用自己那套接口与客户端 UA（混用必然失败）", () => {
	const q = providerApi.byId("quark");
	assert.ok(/drive-pc\.quark\.cn/.test(q.endpoint), "夸克应走 drive-pc 客户端接口");
	assert.ok(/pr=ucpro/.test(q.endpoint), "夸克应带客户端标识 pr=ucpro");
	assert.ok(/quark-cloud-drive/.test(q.ua), "夸克 UA 应为 quark-cloud-drive");

	const u = providerApi.byId("uc");
	assert.ok(/pc-api\.uc\.cn/.test(u.endpoint), "UC 应走 pc-api 客户端接口");
	assert.ok(/pr=UCBrowser/.test(u.endpoint), "UC 应带客户端标识 pr=UCBrowser");
	assert.ok(/uc-cloud-drive/.test(u.ua), "UC UA 应为 uc-cloud-drive");

	assert.notStrictEqual(q.endpoint, u.endpoint, "两家接口不能相同");
	assert.notStrictEqual(q.ua, u.ua, "两家 UA 不能相同");
	assert.deepStrictEqual(q.mount.share, [".share-btns"], "夸克分享页挂载点");
	assert.deepStrictEqual(u.mount.share, [".file-info-share-buttom"], "UC 分享页挂载点");

	// 下载头各取各的 UA（Referer / Cookie 取自页面，Node 无 location，由 e2e 覆盖）
	[q, u].forEach((p) => {
		const h = providerApi.downloadHeaders(p);
		assert.strictEqual(h["User-Agent"], p.ua, p.id + " 下载头应为自己的客户端 UA");
		assert.strictEqual(p.credential, true, p.id + " 应标记 credential（直链需页面 Referer + Cookie）");
	});
});

/* ---------------- 注入层 ---------------- */
group("inject");

t("入口标记 class 已定义（供防重复与样式使用）", () => {
	assert.strictEqual(typeof inject.FLAG, "string");
	assert.ok(inject.FLAG.length > 0);
});
t("waitFor / entry / mount / start 均为函数", () => {
	["waitFor", "entry", "mount", "start"].forEach((k) => {
		assert.strictEqual(typeof inject[k], "function", "缺少方法：" + k);
	});
});
t("waitFor 在无 document 环境下不抛异常", () => {
	assert.doesNotThrow(() => inject.waitFor(".nothing", () => { /* 不应被调用 */ }));
});

/* ---------------- 直链捕获层 ---------------- */
group("catcher");

t("isDirectUrl 只认高置信特征", () => {
	assert.strictEqual(catcher.isDirectUrl("https://d.pcs.baidu.com/file/abc?dlink=1&sign=x"), true);
	assert.strictEqual(catcher.isDirectUrl("https://api.site.com/file/download?id=1"), true);
});
t("isDirectUrl 拒绝噪声 URL（回归：曾把接口路径误判为直链）", () => {
	[
		"https://pan.baidu.com/api/usercode?x=1",
		"https://pan.baidu.com/api/report?x=1",
		"https://pan.baidu.com/api/scene?x=1",
		"https://pan.baidu.com/api/available?x=1",
		"https://pan.baidu.com/api/dir?x=1",
		"https://pan.baidu.com/api/dd_config?x=1",
		"https://pan.baidu.com/api/detail?x=1"
	].forEach((u) => {
		assert.strictEqual(catcher.isDirectUrl(u), false, "不应判定为直链：" + u);
	});
});
t("isDirectUrl 不再靠弱域名特征放行", () => {
	assert.strictEqual(catcher.isDirectUrl("https://bj29.cn-beijing-data.aliyundrive.net/xx/abc?x=1"), false);
});
t("isDirectUrl 排除页面与静态资源", () => {
	assert.strictEqual(catcher.isDirectUrl("https://pan.baidu.com/disk/main"), false);
	assert.strictEqual(catcher.isDirectUrl("https://pan.baidu.com/static/app.js"), false);
	assert.strictEqual(catcher.isDirectUrl("https://pan.baidu.com/img/logo.png"), false);
});
t("isDirectUrl 排除纯接口路径", () => {
	assert.strictEqual(catcher.isDirectUrl("https://api.aliyundrive.com/v2/file/get_download_url"), false);
	assert.strictEqual(catcher.isDirectUrl("https://pan.baidu.com/api/sharedownload"), false);
});
t("isDirectUrl 拒绝非 http 协议与空值", () => {
	assert.strictEqual(catcher.isDirectUrl("javascript:void(0)"), false);
	assert.strictEqual(catcher.isDirectUrl(""), false);
	assert.strictEqual(catcher.isDirectUrl(null), false);
});
t("fromBody 递归提取直链字段与文件名", () => {
	catcher.clear();
	catcher.fromBody({ code: 0, list: [{ server_filename: "影片.mp4", dlink: "https://d.pcs.baidu.com/file/xyz?dlink=1", size: 1024 }] });
	assert.strictEqual(catcher.pool.length, 1);
	assert.strictEqual(catcher.pool[0].name, "影片.mp4");
	assert.strictEqual(catcher.pool[0].size, 1024);
});
t("fromBody 忽略普通字段里的普通链接", () => {
	catcher.clear();
	catcher.fromBody({ homepage: "https://www.example.com/", docs: "https://help.example.com/guide" });
	assert.strictEqual(catcher.pool.length, 0, "非直链键名不应入库");
});
t("fromBody 深度受限不会栈溢出", () => {
	let deep = { dlink: "https://d.pcs.baidu.com/file/deep?dlink=1" };
	for (let i = 0; i < 20; i++) deep = { child: deep };
	assert.doesNotThrow(() => catcher.fromBody(deep));
});
t("put 按 URL 去重", () => {
	catcher.clear();
	const u = "https://d.pcs.baidu.com/file/same?dlink=1";
	assert.strictEqual(catcher.put(u, "a.zip", 1, "测试"), true);
	assert.strictEqual(catcher.put(u, "b.zip", 2, "测试"), false, "重复 URL 不应入库");
	assert.strictEqual(catcher.pool.length, 1);
});
t("put 遵守候选池上限", () => {
	catcher.clear();
	for (let i = 0; i < catcher.MAX + 10; i++) {
		catcher.put("https://d.pcs.baidu.com/file/f" + i + "?dlink=1", "f" + i, i, "测试");
	}
	assert.strictEqual(catcher.pool.length, catcher.MAX);
});
t("clear 可重置候选池", () => {
	catcher.put("https://d.pcs.baidu.com/file/x?dlink=1", "x", 1, "测试");
	catcher.clear();
	assert.strictEqual(catcher.pool.length, 0);
});
t("fromResponse 依据响应头识别直链并取出文件名", () => {
	catcher.clear();
	assert.strictEqual(catcher.fromResponse("https://cdn.site.com/a/b/c?x=1",
		{ "content-disposition": 'attachment; filename="影片.mp4"' }), true);
	assert.strictEqual(catcher.pool.length, 1);
	assert.strictEqual(catcher.pool[0].name, "影片.mp4");
	assert.strictEqual(catcher.pool[0].from, "响应头");
});
t("fromResponse 对普通 JSON 响应不误报", () => {
	catcher.clear();
	assert.strictEqual(catcher.fromResponse("https://cdn.site.com/a/b/c?x=1", { "content-type": "application/json" }), false);
	assert.strictEqual(catcher.pool.length, 0);
});
t("响应体渠道来的地址不受 URL 启发式误杀", () => {
	catcher.clear();
	catcher.fromBody({ dlink: "https://some-cdn.example.net/very/long/path/without/keywords" });
	assert.strictEqual(catcher.pool.length, 1, "响应体已判定的地址应入库");
});

/* ---------------- 存储层 ---------------- */
group("store");

t("默认值开箱即用", () => {
	const cfg = store.get(KEY.aria);
	assert.strictEqual(cfg.domain, "http://localhost");
	assert.strictEqual(cfg.port, "6800");
	assert.strictEqual(cfg.path, "/jsonrpc");
	assert.strictEqual(cfg.token, "");
});
t("patch 局部更新且不丢失其它字段", () => {
	store.set(KEY.aria, { domain: "http://localhost", port: "6800", path: "/jsonrpc", token: "", dir: "" });
	const next = store.patch(KEY.aria, { port: "16800" });
	assert.strictEqual(next.port, "16800");
	assert.strictEqual(next.domain, "http://localhost");
	assert.strictEqual(store.get(KEY.aria).path, "/jsonrpc");
});
t("get 返回副本，外部改动不回写", () => {
	const a = store.get(KEY.aria);
	a.port = "hacked";
	assert.notStrictEqual(store.get(KEY.aria).port, "hacked");
});
t("已剔除只写不读的「默认通道」设置", () => {
	assert.strictEqual(store.get(KEY.opt).channel, undefined, "channel 无任何消费者，不应再存在");
});
t("可选出口默认关闭，保持界面清爽", () => {
	const opt = store.get(KEY.opt);
	assert.strictEqual(opt.showIdm, false);
});
t("addressOf 把 domain + port 并成一行", () => {
	assert.strictEqual(aria.addressOf({ domain: "http://localhost", port: "6800" }), "http://localhost:6800");
	assert.strictEqual(aria.addressOf({ domain: "http://localhost/", port: "" }), "http://localhost");
	assert.strictEqual(aria.addressOf({}), "");
});
t("parseAddress 拆回 domain + port，容忍各种写法", () => {
	assert.deepStrictEqual(aria.parseAddress("http://localhost:6800"), { domain: "http://localhost", port: "6800" });
	assert.deepStrictEqual(aria.parseAddress("localhost:6800"), { domain: "http://localhost", port: "6800" });
	assert.deepStrictEqual(aria.parseAddress("https://host:16800/"), { domain: "https://host", port: "16800" });
	assert.deepStrictEqual(aria.parseAddress("127.0.0.1"), { domain: "http://127.0.0.1", port: "" });
	assert.deepStrictEqual(aria.parseAddress("http://localhost:6800/jsonrpc"), { domain: "http://localhost", port: "6800" });
	assert.deepStrictEqual(aria.parseAddress("  "), { domain: "", port: "" });
});
t("地址往返无损：addressOf → parseAddress 回到原值", () => {
	const cfg = { domain: "http://localhost", port: "6800" };
	const back = aria.parseAddress(aria.addressOf(cfg));
	assert.strictEqual(back.domain, cfg.domain);
	assert.strictEqual(back.port, cfg.port);
});

/* ---------------- 引擎层 ---------------- */
group("engine");

t("mergeHeaders 保留业务请求头", () => {
	const h = engine.mergeHeaders({ Referer: "https://pan.baidu.com/" });
	assert.strictEqual(h.Referer, "https://pan.baidu.com/");
});
t("commandOf 走通完整链路", () => {
	const cmd = engine.commandOf({ url: "https://f/x.zip", name: "x.zip", headers: { "User-Agent": "ua" } });
	assert.ok(cmd.includes('aria2c "https://f/x.zip"'));
	assert.ok(cmd.includes('--out "x.zip"'));
});
t("allLinks 按 CRLF 拼接全部直链", () => {
	const files = [{ url: "https://f/1.zip" }, { url: "https://f/2.zip" }];
	assert.strictEqual(engine.allLinks(files), "https://f/1.zip\r\nhttps://f/2.zip");
});
t("allLinks 空列表安全返回空串", () => {
	assert.strictEqual(engine.allLinks([]), "");
	assert.strictEqual(engine.allLinks(null), "");
	assert.strictEqual(engine.allLinks(undefined), "");
});
t("allCommands 每行一条可执行命令", () => {
	const lines = engine.allCommands([
		{ url: "https://f/1.zip", name: "1.zip", headers: {} },
		{ url: "https://f/2.zip", name: "2.zip", headers: {} }
	]).split("\r\n");
	assert.strictEqual(lines.length, 2);
	assert.ok(lines[0].startsWith("aria2c ") && lines[1].startsWith("aria2c "));
});

/* ---------------- 汇总 ---------------- */
console.log("\n========================================");
console.log("版本: " + VERSION + "    通过: " + pass + "    失败: " + fail);
console.log("========================================");
process.exit(fail ? 1 : 0);
