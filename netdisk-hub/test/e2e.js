/**
 * 端到端验收：用 jsdom 加载真实脚本，跑通「页面注入 -> 文件扫描 -> 推送 Aria2 -> 连通测试」全链路。
 * 依赖：先在 .tmp 目录执行 npm i jsdom
 * 运行：node test/e2e.js
 */
const path = require("path");
const assert = require("assert");

const JSDOM_PATH = path.resolve(__dirname, "../../.tmp/node_modules/jsdom");
let JSDOM;
try {
	JSDOM = require(JSDOM_PATH).JSDOM;
} catch (e) {
	console.error("未找到 jsdom，请先在 .tmp 目录安装：npm i jsdom");
	process.exit(2);
}

const SCRIPT = path.resolve(__dirname, "../netdisk-hub.user.js");

// 模拟夸克网盘分享页：宿主工具栏容器（内含一个原生按钮）+ 文件列表容器
const PAGE = `<!DOCTYPE html><html><body>
<div class="share-btns" id="hostBar"><button id="nativeBtn">保存到网盘</button></div>
<div class="frame-main"><div class="file-list" id="fileList"></div></div>
</body></html>`;

let pass = 0;
let fail = 0;
const pending = [];
const t = (name, fn) => {
	pending.push((async () => {
		try { await fn(); pass++; console.log("  ok   " + name); }
		catch (e) { fail++; console.log("  FAIL " + name + "  ->  " + e.message); }
	})());
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

async function main() {
	const dom = new JSDOM(PAGE, {
		url: "https://pan.quark.cn/s/abc123def",
		runScripts: "outside-only",
		pretendToBeVisual: true
	});
	const { window } = dom;
	const g = global;

	// ---- 挂载浏览器全局 ----
	g.window = window;
	g.document = window.document;
	g.location = window.location;
	g.Blob = window.Blob;
	g.URL = window.URL;
	g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
	try { g.navigator = window.navigator; } catch (e) { /* 保留宿主 navigator */ }

	// ---- 桩：油猴 API ----
	const storeMap = new Map();
	const menus = [];
	const requests = [];
	const opened = [];
	storeMap.set("nd.opt", { channel: "api", showIdm: true, firstTip: false, history: [] });

	g.GM_getValue = (k, d) => (storeMap.has(k) ? storeMap.get(k) : d);
	g.GM_setValue = (k, v) => { storeMap.set(k, v); };
	g.GM_deleteValue = (k) => { storeMap.delete(k); };
	g.GM_setClipboard = (text) => { g.__clip = text; };
	g.GM_registerMenuCommand = (label, fn) => { menus.push({ label, fn }); };
	let signSeq = 0;   // 换链签名序号，模拟「每次直链都不同」
	g.GM_xmlhttpRequest = (opt) => {
		requests.push(opt);
		setTimeout(() => {
			const url = String(opt.url || "");
			let body;
			if (/clouddrive\/file\/download/.test(url)) {
				// 刻意让签名每次都变 —— 网盘直链就是这种行为，这是重复条目的来源
				signSeq += 1;
				body = { code: 0, data: [{ file_name: "影片A.mp4", size: 2048, download_url: "https://cdn.quark.cn/dl/abc?sign=s" + signSeq }] };
			} else if (/getVersion/.test(opt.data || "")) {
				body = { id: 1, jsonrpc: "2.0", result: { version: "1.36.0", enabledFeatures: ["Async DNS"] } };
			} else {
				body = { id: 1, jsonrpc: "2.0", result: "2089b05ecca3d829" };
			}
			if (opt.onload) opt.onload({ status: 200, responseText: JSON.stringify(body), response: body, responseHeaders: "" });
		}, 0);
		return { abort() { /* noop */ } };
	};

	// 模拟页面框架（React）内部状态：文件列表组件挂在 .file-list 上，
	// 勾选态存在 props.selectedRowKeys 里 —— 这正是「扫 DOM 扫不到」的原因。
	// 字段刻意用真实夸克的 `file`（false 表示文件夹），而非 `dir`：
	// 早先版本只判 dir，于是文件夹被当成文件送进换链接口，什么也取不回来。
	const compProps = {
		stoken: "st-1",
		list: [
			{ fid: "f1", file_name: "影片A.mp4", size: 2048, file: true, share_fid_token: "tk1" },
			{ fid: "f2", file_name: "未勾选.txt", size: 10, file: true, share_fid_token: "tk2" },
			{ fid: "d1", file_name: "某个文件夹", size: 0, file: false, share_fid_token: "tk3" }
		],
		selectedRowKeys: ["f1", "d1"]
	};
	window.document.getElementById("fileList")["__reactFiber$nd"] = {
		type: "div",
		return: { type: function FileList() {}, stateNode: { props: compProps } }
	};
	// 换链后取回的直链需要带上页面 Cookie，这里造一个非空值以便断言
	window.document.cookie = "nd_test=1";
	window.open = (url) => { opened.push(url); return null; };
	// jsdom 不内置 fetch，这里补一个最小实现，以便覆盖脚本的 fetch hook 分支
	if (typeof window.fetch !== "function") {
		window.fetch = function () {
			return Promise.resolve({ ok: true, headers: { get: () => "" }, clone() { return this; } });
		};
	}

	// ---- 加载真实脚本 ----
	delete require.cache[require.resolve(SCRIPT)];
	const mod = require(SCRIPT);

	console.log("\n[加载期]");
	await tick(60);   // 等注入观察器跑完
	t("注册了油猴菜单命令（兜底入口）", () => {
		assert.ok(menus.some((m) => m.label === "打开下载助手"), "应注册「打开下载助手」");
		assert.ok(menus.some((m) => m.label === "Aria2 设置"), "应注册「Aria2 设置」");
	});
	t("懒挂载：未打开面板时不挂载面板容器", () => {
		assert.strictEqual(document.getElementById("nd-scope"), null, "未打开面板时不应挂载容器");
	});
	t("不注入任何悬浮器件", () => {
		assert.strictEqual(document.querySelectorAll('[class*="launcher"]').length, 0, "不应存在启动器");
	});

	console.log("\n[页面注入层]");
	t("入口被注入到宿主工具栏容器内", () => {
		const bar = document.getElementById("hostBar");
		const entry = bar.querySelector(".nd-entry");
		assert.ok(entry, "宿主工具栏内应出现「下载助手」入口");
		assert.strictEqual(entry.closest("#hostBar"), bar, "入口必须嵌在宿主容器内");
	});
	t("入口注入到工具栏最右侧（原生按钮之后）", () => {
		const bar = document.getElementById("hostBar");
		const kids = Array.prototype.filter.call(bar.children, (el) => el.nodeType === 1);
		assert.strictEqual(kids[kids.length - 1].classList.contains("nd-entry"), true,
			"入口应是容器最后一个元素：" + kids.map((k) => k.id || k.className).join(","));
	});
	t("入口未脱离文档流（不是悬浮器件）", () => {
		const entry = document.querySelector(".nd-entry");
		const directChild = Array.prototype.indexOf.call(document.body.children, entry) >= 0;
		assert.ok(!directChild, "入口不应直挂 body");
		assert.ok(!entry.hasAttribute("style"), "入口不应带内联定位样式");
	});
	t("入口样式在注入时即已就位（不依赖面板懒挂载）", () => {
		assert.ok(document.getElementById("nd-entry-style"), "应存在独立的入口样式表");
		assert.strictEqual(document.getElementById("nd-scope"), null, "此时面板仍不应挂载");
	});
	t("入口图标自带内联表现属性（样式缺失也≠实心色块）", () => {
		const svg = document.querySelector(".nd-entry svg");
		assert.ok(svg, "入口应有图标");
		assert.strictEqual(svg.getAttribute("fill"), "none");
		assert.strictEqual(svg.getAttribute("stroke"), "currentColor");
		assert.strictEqual(svg.getAttribute("width"), "14");
	});
	t("按 pathname 识别出当前为分享页（share）", () => {
		assert.strictEqual(mod.providerApi.pageType(mod.providers[2]), "share");
	});
	t("重复注入不会产生第二个入口", () => {
		const bar = document.getElementById("hostBar");
		const before = bar.querySelectorAll(".nd-entry").length;
		mod.inject.mount(mod.providers[0]);
		mod.inject.mount(mod.providers[0]);
		assert.strictEqual(bar.querySelectorAll(".nd-entry").length, before, "不应重复注入");
	});

	// waitFor 的异步行为单独验证（t() 为同步断言）
	const lateHost = document.createElement("div");
	lateHost.className = "late-host";
	let lateHit = null;
	mod.inject.waitFor(".late-host", (el) => { lateHit = el; });
	const notFiredYet = lateHit === null;
	document.body.appendChild(lateHost);
	await tick(60);
	t("容器尚不存在时 waitFor 不触发", () => assert.ok(notFiredYet, "不应提前触发"));
	t("异步渲染出的容器出现后触发注入", () => assert.strictEqual(lateHit, lateHost, "应在容器出现后触发"));
	t("点击注入的入口可打开面板", () => {
		document.querySelector(".nd-entry").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		const panel = document.getElementById("nd-panel");
		assert.ok(panel && panel.classList.contains("nd-open"), "点击入口后面板应打开");
	});

	console.log("\n[面板与扫描]");
	mod.ui.open();
	const scope = document.getElementById("nd-scope");
	const panel = document.getElementById("nd-panel");
	// 打开面板就应自动换链，用户不必再点一次按钮
	const autoResolveReq = requests.filter((r) => /clouddrive\/file\/download/.test(String(r.url))).length;

	t("打开面板即自动换取直链（无需手动点按钮）", () => {
		assert.ok(autoResolveReq >= 1, "打开面板时应已发出换链请求，实际 " + autoResolveReq);
	});
	t("换链结果直接呈现在「可用直链」卡内", () => {
		assert.ok(scope.querySelector('[data-el="caught-count"]'), "应有可用直链计数");
		assert.ok(/可用直链/.test(scope.textContent), "卡片标题应为「可用直链」");
	});
	t("菜单唤出后注入面板容器", () => {
		assert.ok(scope, "#nd-scope 应存在");
		assert.ok(panel, "#nd-panel 应存在");
		assert.ok(panel.classList.contains("nd-open"), "面板应处于打开态");
	});
	t("页面中确实没有启动器元素", () => {
		assert.strictEqual(document.querySelectorAll('[class*="launcher"]').length, 0);
		assert.strictEqual(document.getElementById("nd-launcher"), null);
	});
	t("识别到夸克网盘并判定为分享页", () => {
		assert.strictEqual(mod.ui.state.provider.id, "quark", "应识别为夸克网盘");
		assert.strictEqual(mod.providerApi.pageType(mod.providers[2]), "share", "应判定为分享页");
	});
	t("从页面框架状态里读出勾选的文件（而非扫 DOM）", () => {
		const files = mod.ui.state.files;
		assert.strictEqual(files.length, 2, "应读出 2 个勾选项（f1 与 d1）");
		assert.strictEqual(files[0].fid, "f1");
		assert.strictEqual(files[0].name, "影片A.mp4");
		assert.strictEqual(files[1].dir, true, "文件夹应被标记出来");
	});
	t("面板只呈现「可用直链」一张主卡", () => {
		assert.ok(scope.querySelector('[data-el="caught-count"]'), "应有可用直链计数");
		assert.strictEqual(scope.querySelector('[data-el="scan-tip"]'), null, "不应再有统计/说明行");
		assert.strictEqual(scope.querySelector('[data-el="file-list"]'), null, "不应再有勾选文件列表");
		assert.ok(/可用直链/.test(scope.textContent), "主卡标题应为「可用直链」");
	});
	t("没有直链时只给一句可操作的提示，且不做任何统计", () => {
		mod.catcher.clear();
		mod.ui.renderCaught();
		const empty = scope.querySelector('[data-el="caught-list"] .nd-empty');
		assert.ok(empty, "应有空态提示");
		assert.ok(empty.textContent.trim().length > 8, "提示不应为空：" + empty.textContent);
		assert.ok(!/\d+\s*个文件/.test(empty.textContent), "提示里不应出现统计：" + empty.textContent);
	});
	t("没有条目时不显示批量按钮", () => {
		assert.strictEqual(scope.querySelector('[data-el="batch-bar"]').hidden, true, "空列表应隐藏批量按钮");
	});

	console.log("\n[换直链链路：读勾选 → 调接口 → 入库]");
	requests.length = 0;
	scope.querySelector('[data-act="resolve"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await tick(150);
	t("换链接口只收到文件，文件夹被剔除", () => {
		const req = requests.find((r) => /clouddrive\/file\/download/.test(String(r.url)));
		assert.ok(req, "应请求换链接口");
		const body = JSON.parse(req.data);
		assert.deepStrictEqual(body.fids, ["f1"], "文件夹 d1 不应被送进换链接口");
		assert.strictEqual(body.pwd_id, "abc123def", "分享页应带上 pwd_id");
	});
	t("请求头携带了网盘要求的客户端 UA", () => {
		const req = requests.find((r) => /clouddrive\/file\/download/.test(String(r.url)));
		assert.ok(/quark-cloud-drive/.test(JSON.stringify(req.headers || {})), "应带夸克客户端 UA");
	});
	t("返回的直链被写入候选池", () => {
		const hit = mod.catcher.pool.find((f) => f.url.indexOf("cdn.quark.cn") >= 0);
		assert.ok(hit, "直链应入库：" + JSON.stringify(mod.catcher.pool.map((x) => x.url)));
		assert.strictEqual(hit.name, "影片A.mp4");
		assert.strictEqual(hit.from, "接口");
	});
	t("直链随行带上 Referer 与 Cookie（否则推送后 403）", () => {
		const hit = mod.catcher.pool.find((f) => f.url.indexOf("cdn.quark.cn") >= 0);
		assert.ok(hit.headers, "直链应携带请求头");
		assert.strictEqual(hit.headers.Referer, "https://pan.quark.cn/");
		assert.strictEqual(hit.headers.Cookie, "nd_test=1");
	});

	console.log("\n[重复防护：重新获取不堆叠]");
	{
		const before = mod.catcher.pool.length;
		scope.querySelector('[data-act="resolve"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await tick(150);
		t("重新获取直链不会产生重复（同名覆盖为最新）", () => {
			assert.ok(mod.catcher.pool.length === before, `条数应不变（${before} → ${mod.catcher.pool.length}）`);
			const hit = mod.catcher.pool.find((f) => f.name === "影片A.mp4");
			assert.ok(hit, "同名条目应仍在");
			assert.ok(/sign=s\d+$/.test(hit.url), "签名应已更新为最新：" + hit.url);
		});
	}
	// 全部为文件夹的场景：应被拒绝，且原因指向文件夹（而非发一次注定无结果的请求）
	compProps.selectedRowKeys = ["d1"];
	mod.ui.scan();
	let folderErr = "";
	try { await mod.engine.resolveSelected(mod.providers[2]); }
	catch (e) { folderErr = e.message; }

	t("勾选里只有文件夹时，提示直接告诉用户该做什么", () => {
		mod.catcher.clear();
		mod.ui.renderCaught();
		const empty = scope.querySelector('[data-el="caught-list"] .nd-empty');
		assert.ok(empty, "无直链时应有提示");
		assert.ok(/文件夹/.test(empty.textContent), "提示应指明文件夹：" + empty.textContent);
	});
	t("没有可换链的文件时不显示「重新获取直链」", () => {
		assert.strictEqual(scope.querySelector('[data-el="resolve-btn"]').hidden, true, "应隐藏");
	});
	t("全部是文件夹时给出可操作的提示，而不是发无意义的请求", () => {
		assert.ok(/文件夹/.test(folderErr), "拒绝原因应指明文件夹：" + folderErr);
	});

	compProps.selectedRowKeys = ["f1", "d1"];
	mod.ui.scan();

	t("有可换链的文件时「重新获取直链」才出现", () => {
		assert.strictEqual(scope.querySelector('[data-el="resolve-btn"]').hidden, false, "应显示");
	});

	console.log("\n[Aria2 通道：真实点击链路]");
	// 前面清理过候选池，这里重新换一次链，确保有可点的条目
	scope.querySelector('[data-act="resolve"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await tick(150);
	assert.ok(mod.catcher.pool.length > 0, "换链后应有候选");
	requests.length = 0;
	scope.querySelector('[data-act="caught-aria"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await tick(60);

	t("点击捕获项的 Aria2 按钮发出 POST 到默认 RPC 地址", () => {
		const req = requests.find((r) => r.method === "POST");
		assert.ok(req, "应有 POST 请求");
		assert.strictEqual(req.url, "http://localhost:6800/jsonrpc");
	});
	t("请求体是合法的 aria2.addUri JSON-RPC", () => {
		const req = requests.find((r) => r.method === "POST");
		const body = JSON.parse(req.data);
		assert.strictEqual(body.jsonrpc, "2.0");
		assert.strictEqual(body.method, "aria2.addUri");
		assert.ok(body.params[0][0].includes("cdn.quark.cn"), "params 首个 uris 应是捕获到的直链");
		assert.strictEqual(body.params[1].out, "影片A.mp4");
		assert.ok(Array.isArray(body.params[1].header), "应携带 header 数组");
	});
	t("推送后写入历史记录", () => {
		assert.ok(storeMap.get("nd.opt").history.length >= 1, "应记录一条历史");
	});

	console.log("\n[设置页：连通性测试]");
	requests.length = 0;
	const testBtn = scope.querySelector('[data-act="test-aria"]');
	testBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await tick(80);

	t("测试连接发出 aria2.getVersion", () => {
		const req = requests.find((r) => r.method === "POST");
		assert.ok(req, "应有 POST 请求");
		const body = JSON.parse(req.data);
		assert.strictEqual(body.method, "aria2.getVersion");
	});
	t("成功后将版本号回显到界面", () => {
		const status = scope.querySelector('[data-el="aria-status"]').textContent;
		assert.ok(status.includes("1.36.0"), "状态应显示版本：" + status);
	});
	t("地址与端口合并为一行，保存时正确拆回 domain + port", () => {
		const addr = scope.querySelector('[data-cfg="address"]');
		assert.ok(addr, "应有「服务器地址」输入框");
		assert.strictEqual(addr.value, "http://localhost:6800", "应显示合并后的地址");
		addr.value = "http://localhost:16800";
		scope.querySelector('[data-act="save-aria"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		assert.strictEqual(storeMap.get("nd.aria").port, "16800", "端口应被拆出");
		assert.strictEqual(storeMap.get("nd.aria").domain, "http://localhost", "主机应被拆出");
	});
	t("地址未写协议时自动补 http://", () => {
		const addr = scope.querySelector('[data-cfg="address"]');
		addr.value = "127.0.0.1:7000";
		scope.querySelector('[data-act="save-aria"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		assert.strictEqual(storeMap.get("nd.aria").domain, "http://127.0.0.1");
		assert.strictEqual(storeMap.get("nd.aria").port, "7000");
		addr.value = "http://localhost:16800";
		scope.querySelector('[data-act="save-aria"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	});

	console.log("\n[复制命令行出口]");
	g.__clip = null;
	scope.querySelector('[data-act="copy-all-cmds"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await tick(30);
	t("复制出的命令行可直接使用", () => {
		assert.ok(g.__clip, "剪贴板应有内容");
		assert.ok(g.__clip.includes("aria2c"), "应含 aria2c：" + g.__clip);
		assert.ok(g.__clip.includes('--out "影片A.mp4"'), "应含文件名");
		assert.ok(g.__clip.includes("--continue=true"), "应支持断点续传");
	});

	console.log("\n[批量出口与任务管理页]");
	// 再补一条候选，用于验证批量复制
	mod.catcher.put("https://cdn.quark.cn/dl/def?sign=2", "影片B.mp4", 4096, "接口", true);
	mod.ui.renderCaught();

	g.__clip = null;
	scope.querySelector('[data-act="copy-caught"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await tick(30);
	t("复制全部直链：按 CRLF 拼接当前候选", () => {
		assert.ok(g.__clip, "剪贴板应有内容");
		const lines = String(g.__clip).split("\r\n");
		assert.strictEqual(lines.length, mod.catcher.pool.length, "行数应等于候选数");
		assert.ok(lines[0].indexOf("cdn.quark.cn") >= 0, g.__clip);
	});
	t("复制全部命令行：每行一条 aria2c", () => {
		g.__clip = null;
		scope.querySelector('[data-act="copy-all-cmds"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		const lines = String(g.__clip || "").split("\r\n");
		assert.strictEqual(lines.length, mod.catcher.pool.length);
		assert.ok(lines.every((l) => l.startsWith("aria2c ")), g.__clip);
	});
	t("已移除任务管理页：设置与下载页都不应再有该入口", () => {
		assert.strictEqual(scope.querySelector('[data-cfg="taskUrl"]'), null, "设置里不应有任务管理页");
		assert.strictEqual(scope.querySelector('[data-act="open-task"]'), null, "下载页不应有任务管理页入口");
		assert.strictEqual(scope.textContent.indexOf("任务管理页"), -1, "界面上不应出现该字样");
	});

	console.log("\n[直链捕获层]");
	t("网络层 hook 行为生效：页面发 XHR 即被截获（toString 已伪装成原生样貌）", () => {
		try {
			const xhr = new window.XMLHttpRequest();
			xhr.open("GET", "https://cdn.quark.cn/dl/hooked.zip?dlink=1&sign=x");
			xhr.send();   // jsdom 对跨域会异步报错，但 put 发生在 send 包装里，已入库
		} catch (e) { /* 忽略：不同 jsdom 版本对跨域 XHR 的抛错时机不同 */ }
		assert.ok(
			mod.catcher.pool.some((f) => f.url.indexOf("hooked.zip") >= 0),
			"XHR 发出的直链应进入候选池"
		);
	});

	mod.catcher.clear();
	t("从接口响应体中捕获到直链", () => {
		mod.catcher.fromBody({
			errno: 0,
			list: [{ server_filename: "影片.mp4", size: 2048, dlink: "https://d.pcs.baidu.com/file/cap1?dlink=1&sign=z" }]
		});
		assert.strictEqual(mod.catcher.pool.length, 1, "应捕获 1 条");
	});
	t("捕获结果渲染进面板", () => {
		mod.ui.renderCaught();
		assert.strictEqual(scope.querySelector('[data-el="caught-count"]').textContent, "1");
		assert.strictEqual(scope.querySelectorAll('[data-el="caught-list"] .nd-row').length, 1);
	});

	requests.length = 0;
	scope.querySelector('[data-act="caught-aria"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await tick(60);
	t("捕获项可一键推送 Aria2", () => {
		const req = requests.find((r) => r.method === "POST");
		assert.ok(req, "应有 RPC 请求");
		const body = JSON.parse(req.data);
		assert.strictEqual(body.method, "aria2.addUri");
		assert.ok(body.params[0][0].includes("cap1"), "推送的应是捕获到的直链");
		assert.strictEqual(body.params[1].out, "影片.mp4");
	});
	t("清空按钮可重置捕获列表", () => {
		scope.querySelector('[data-act="clear-caught"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		assert.strictEqual(mod.catcher.pool.length, 0);
		assert.strictEqual(scope.querySelector('[data-el="caught-count"]').textContent, "0");
	});

	console.log("\n[标签页切换与关闭]");
	t("三个标签页可切换", () => {
		const cfgTab = scope.querySelector('[data-tab="cfg"]');
		cfgTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		assert.ok(scope.querySelector('[data-page="cfg"]').classList.contains("nd-on"), "设置页应激活");
		assert.ok(!scope.querySelector('[data-page="dl"]').classList.contains("nd-on"), "下载页应隐藏");
	});
	t("关闭按钮收起面板但保留容器", () => {
		scope.querySelector('[data-act="close"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		assert.ok(!panel.classList.contains("nd-open"), "面板应关闭");
		assert.ok(document.getElementById("nd-scope"), "容器保留以便复开");
	});

	/* ==================== 场景二：百度分享页 ==================== */

	console.log("\n[百度分享页]");
	const BD_PAGE = `<!DOCTYPE html><html><body>
<div class="module-share-top-bar"><div class="x-button-box" id="bdBar"></div></div>
<div class="file-list" id="bdList"></div>
</body></html>`;
	const dom2 = new JSDOM(BD_PAGE, {
		url: "https://pan.baidu.com/s/1okG6FZw28O8rpasBv-Yl8w?pwd=2twm",
		runScripts: "outside-only",
		pretendToBeVisual: true
	});
	const w2 = dom2.window;
	g.window = w2;
	g.document = w2.document;
	g.location = w2.location;
	g.Blob = w2.Blob;
	g.URL = w2.URL;
	g.requestAnimationFrame = w2.requestAnimationFrame.bind(w2);

	const storeMap2 = new Map();
	const requests2 = [];
	storeMap2.set("nd.opt", { showIdm: false, firstTip: false, history: [] });
	g.GM_getValue = (k, d) => (storeMap2.has(k) ? storeMap2.get(k) : d);
	g.GM_setValue = (k, v) => { storeMap2.set(k, v); };
	g.GM_deleteValue = (k) => { storeMap2.delete(k); };
	g.GM_setClipboard = (text) => { g.__clip = text; };
	g.GM_registerMenuCommand = () => { /* 本场景不关注菜单 */ };
	g.GM_xmlhttpRequest = (opt) => {
		requests2.push(opt);
		setTimeout(() => {
			const url = String(opt.url || "");
			let body;
			if (/share\/tplconfig/.test(url)) {
				body = { errno: 0, data: { sign: "SGN123", timestamp: "1700000000" } };
			} else if (/api\/sharedownload/.test(url)) {
				body = { errno: 0, list: [{ dlink: "https://d.pcs.baidu.com/file/xyz?fid=111&dst=1", server_filename: "视频.mkv", size: 1623456789 }] };
			} else if (/getVersion/.test(opt.data || "")) {
				body = { id: 1, jsonrpc: "2.0", result: { version: "1.36.0" } };
			} else {
				body = { id: 1, jsonrpc: "2.0", result: "task-ok" };
			}
			if (opt.onload) opt.onload({ status: 200, responseText: JSON.stringify(body), response: body, responseHeaders: "" });
		}, 0);
		return { abort() { /* noop */ } };
	};

	// 模拟百度分享页运行时状态：locals.dump / jsToken / sekey / BAIDUID
	w2.document.cookie = "BAIDUID=ABCDEF0123456789:FG=1";
	w2.locals = { dump: () => ({ share_uk: { value: "2815629761" }, shareid: { value: "3912345678" }, bdstoken: { value: "tok123" } }) };
	w2.jsToken = "A9B8C7D6";
	w2.currentSekey = "@sekey-xyz@";
	// Vue 勾选态：真实字段 fs_id / server_filename / isdir
	w2.document.getElementById("bdList").__vue__ = {
		allFileList: [
			{ fs_id: 111, server_filename: "视频.mkv", size: 1623456789, isdir: 0, selected: true },
			{ fs_id: 222, server_filename: "没勾.mp4", size: 10, isdir: 0, selected: false }
		]
	};

	delete require.cache[require.resolve(SCRIPT)];
	const mod2 = require(SCRIPT);

	await tick(60);
	t("识别为百度网盘分享页", () => {
		assert.strictEqual(mod2.providerApi.current().id, "baidu");
		assert.strictEqual(mod2.providerApi.pageType(mod2.providers[0]), "share");
	});
	t("baiduShareInfo 读齐运行时参数", () => {
		const info = mod2.providerApi.baiduShareInfo();
		assert.strictEqual(info.uk, "2815629761");
		assert.strictEqual(info.shareId, "3912345678");
		assert.strictEqual(info.bdstoken, "tok123");
		assert.strictEqual(info.jsToken, "A9B8C7D6");
		assert.strictEqual(info.sekey, "@sekey-xyz@");
		assert.strictEqual(info.surl, "okG6FZw28O8rpasBv-Yl8w", "surl 应去掉开头的 1");
		assert.ok(info.baiduId.indexOf("ABCDEF0123456789") === 0, "应取到 BAIDUID");
	});

	requests2.length = 0;
	mod2.ui.open();
	await tick(120);   // 等自动换链（tplconfig + sharedownload 各一跳）

	t("打开面板即自动换链：先取签名", () => {
		const req = requests2.find((r) => /share\/tplconfig/.test(String(r.url)));
		assert.ok(req, "应请求 tplconfig");
		assert.ok(req.url.includes("surl=1okG6FZw28O8rpasBv-Yl8w"), "应带 surl：" + req.url);
		assert.ok(req.url.includes("logid=" + encodeURIComponent(Buffer.from("ABCDEF0123456789:FG=1", "utf8").toString("base64"))), "logid 应为 BAIDUID 的 base64");
	});
	t("sharedownload 提交了勾选文件的 fid 与全部分享参数", () => {
		const req = requests2.find((r) => /api\/sharedownload/.test(String(r.url)));
		assert.ok(req, "应请求 sharedownload");
		assert.ok(req.url.includes("sign=SGN123") && req.url.includes("timestamp=1700000000"), "应带上签名与时间戳：" + req.url);
		assert.ok(req.url.includes("jsToken=A9B8C7D6"), "应带 jsToken");
		const data = String(req.data || "");
		assert.ok(data.includes(encodeURIComponent(JSON.stringify([111]))), "fid_list 应只含勾选的 111（222 未勾选不应出现）：" + data);
		assert.ok(data.includes("uk=2815629761") && data.includes("primaryid=3912345678"), "应带 uk 与 primaryid");
		assert.ok(data.includes(encodeURIComponent(JSON.stringify({ sekey: "@sekey-xyz@" }))), "带提取码的分享应有 extra.sekey");
	});
	t("dlink 入库且随行携带下载所需请求头", () => {
		const hit = mod2.catcher.pool.find((f) => f.url.indexOf("d.pcs.baidu.com") >= 0);
		assert.ok(hit, "直链应入库");
		assert.strictEqual(hit.name, "视频.mkv");
		assert.ok(hit.headers, "应随行保存请求头");
		assert.strictEqual(hit.headers["User-Agent"], "pan.baidu.com", "直链下载需专属 UA");
		assert.ok(/BAIDUID=ABCDEF0123456789/.test(hit.headers.Cookie || ""), "需页面 Cookie");
		assert.strictEqual(hit.headers.Referer, "https://pan.baidu.com/");
	});
	t("推送 Aria2 时请求头原样带出（否则直链 403）", async () => {
		requests2.length = 0;
		const btn = document.querySelector('[data-act="caught-aria"]');
		btn.dispatchEvent(new w2.MouseEvent("click", { bubbles: true }));
		await tick(60);
		const req = requests2.find((r) => String(r.url).includes("/jsonrpc"));
		assert.ok(req, "应发出 RPC 请求");
		const payload = JSON.parse(req.data);
		const headerArr = payload.params[1].header || [];
		assert.ok(headerArr.some((h) => /^User-Agent: pan\.baidu\.com$/.test(h)), "应带 UA：pan.baidu.com");
		assert.ok(headerArr.some((h) => /^Cookie:.*BAIDUID/.test(h)), "应带 Cookie");
	});

	t("入口按钮被宿主重渲染替换后，点击仍能打开面板（capture 委托兜底）", () => {
		mod2.ui.close();
		const bar = w2.document.getElementById("bdBar");
		const old = bar.querySelector(".nd-entry");
		if (old) old.remove();
		// 模拟宿主重渲染：放一个全新的、没绑任何监听的节点
		const fresh = w2.document.createElement("div");
		fresh.className = "nd-entry";
		bar.appendChild(fresh);
		fresh.dispatchEvent(new w2.MouseEvent("click", { bubbles: true }));
		assert.ok(mod2.ui.isOpen(), "捕获阶段委托应接住点击并打开面板");
	});

	/* ==================== 场景三：百度网盘内页 ==================== */

	console.log("\n[百度网盘内页]");
	const BH_PAGE = `<!DOCTYPE html><html><body>
<div class="wp-s-agile-tool-bar__header" id="bhBar"></div>
<div class="file-list" id="bhList"></div>
</body></html>`;
	const dom3 = new JSDOM(BH_PAGE, {
		url: "https://pan.baidu.com/disk/main?idx=2",
		runScripts: "outside-only",
		pretendToBeVisual: true
	});
	const w3 = dom3.window;
	g.window = w3;
	g.document = w3.document;
	g.location = w3.location;
	g.Blob = w3.Blob;
	g.URL = w3.URL;
	g.requestAnimationFrame = w3.requestAnimationFrame.bind(w3);

	const storeMap3 = new Map();
	const requests3 = [];
	storeMap3.set("nd.opt", { showIdm: false, firstTip: false, history: [] });
	g.GM_getValue = (k, d) => (storeMap3.has(k) ? storeMap3.get(k) : d);
	g.GM_setValue = (k, v) => { storeMap3.set(k, v); };
	g.GM_deleteValue = (k) => { storeMap3.delete(k); };
	g.GM_setClipboard = (text) => { g.__clip = text; };
	g.GM_registerMenuCommand = () => { /* 本场景不关注菜单 */ };
	g.GM_xmlhttpRequest = (opt) => {
		requests3.push(opt);
		setTimeout(() => {
			const url = String(opt.url || "");
			let res;
			if (/oauth\/2\.0\/authorize/.test(url)) {
				// 模拟已授权过的账号：授权页直接重定向到 oob 并带出令牌
				res = { status: 200, finalUrl: "https://openapi.baidu.com/oauth/2.0/oob?access_token=TOK123abc", responseText: "", responseHeaders: "" };
			} else if (/filemetas/.test(url)) {
				// 真实 filemetas 的字段名是 filename（server_filename 是 sharedownload 的），
				// 且 dlink 末段无文件名 —— 名字必须从勾选文件对回
				res = { status: 200, finalUrl: url, responseText: JSON.stringify({ errno: 0, list: [{ fs_id: 333, filename: "接口返回的名字.onnx", size: 97607680, dlink: "https://d.pcs.baidu.com/file/inner?fid=333&dst=1" }] }), responseHeaders: "" };
			} else {
				res = { status: 200, finalUrl: url, responseText: JSON.stringify({ id: 1, jsonrpc: "2.0", result: "task-ok" }), responseHeaders: "" };
			}
			if (opt.onload) opt.onload(res);
		}, 0);
		return { abort() { /* noop */ } };
	};

	w3.document.cookie = "BAIDUID=FFFF111122223333:FG=1";
	w3.document.getElementById("bhList").__vue__ = {
		allFileList: [
			{ fs_id: 333, server_filename: "模型.onnx", size: 97607680, isdir: 0, selected: true },
			{ fs_id: 444, server_filename: "没勾.pt", size: 10, isdir: 0, selected: false }
		]
	};

	delete require.cache[require.resolve(SCRIPT)];
	const mod3 = require(SCRIPT);

	await tick(60);
	t("识别为百度网盘内页（home）", () => {
		assert.strictEqual(mod3.providerApi.current().id, "baidu");
		assert.strictEqual(mod3.providerApi.pageType(mod3.providers[0]), "home");
	});
	t("百度页面跳过了网络 hook（原生 API 未被包装）", () => {
		const raw = w3.XMLHttpRequest.prototype.open;
		assert.ok(!/apply|__ndUrl/.test(String(raw)) && String(raw).indexOf("[native code]") >= 0 || String(raw).indexOf("__ndUrl") < 0,
			"XHR.open 不应带包装痕迹");
		try {
			const probe = new w3.XMLHttpRequest();
			probe.open("GET", "https://d.pcs.baidu.com/file/probe?dlink=1");
			probe.send();
		} catch (e) { /* 忽略 */ }
		assert.ok(!mod3.catcher.pool.some((f) => f.url.indexOf("probe") >= 0), "hook 跳过后不应截获任何请求");
	});

	requests3.length = 0;
	mod3.ui.open();
	await tick(160);   // 静默授权 + filemetas 两跳

	t("内页自动换链：先静默授权拿令牌", () => {
		const req = requests3.find((r) => /oauth\/2\.0\/authorize/.test(String(r.url)));
		assert.ok(req, "应请求百度授权页");
		assert.ok(String(req.url).includes("response_type=token"), "应为令牌式授权");
	});
	t("filemetas 只提交勾选文件的 fs_id，并携带授权令牌", () => {
		const req = requests3.find((r) => /filemetas/.test(String(r.url)));
		assert.ok(req, "应请求 filemetas");
		assert.ok(req.url.includes(encodeURIComponent(JSON.stringify([333]))), "fsids 应只含勾选的 333");
		assert.ok(req.url.includes("access_token=TOK123abc"), "应携带授权令牌");
		assert.ok(req.url.includes("dlink=1"), "应声明需要 dlink");
	});
	t("令牌已缓存（下次换链不再重复授权）", () => {
		assert.strictEqual(storeMap3.get("nd.baidu").token, "TOK123abc");
	});
	t("内页 dlink 入库且随行 UA + Cookie", () => {
		const hit = mod3.catcher.pool.find((f) => f.url.indexOf("inner?fid=333") >= 0);
		assert.ok(hit, "直链应入库");
		assert.strictEqual(hit.name, "模型.onnx", "名字应来自勾选文件（勾选名优先于接口字段）");
		assert.strictEqual(hit.headers["User-Agent"], "pan.baidu.com");
		assert.ok(/BAIDUID=FFFF111122223333/.test(hit.headers.Cookie || ""), "需页面 Cookie");
	});

	/* ==================== 场景四：移动云盘分享页 ==================== */

	console.log("\n[移动云盘分享页]");
	const MC_PAGE = `<!DOCTYPE html><html><body>
<div class="top-btns" id="mcBar"></div>
<div class="main_file_list" id="mcList"></div>
</body></html>`;
	const dom4 = new JSDOM(MC_PAGE, {
		url: "https://yun.139.com/shareweb/#/w/i/2xop3UhNZXiaq",
		runScripts: "outside-only",
		pretendToBeVisual: true
	});
	const w4 = dom4.window;
	g.window = w4;
	g.document = w4.document;
	g.location = w4.location;
	g.Blob = w4.Blob;
	g.URL = w4.URL;
	g.requestAnimationFrame = w4.requestAnimationFrame.bind(w4);

	const storeMap4 = new Map();
	const requests4 = [];
	storeMap4.set("nd.opt", { showIdm: false, firstTip: false, history: [] });
	g.GM_getValue = (k, d) => (storeMap4.has(k) ? storeMap4.get(k) : d);
	g.GM_setValue = (k, v) => { storeMap4.set(k, v); };
	g.GM_deleteValue = (k) => { storeMap4.delete(k); };
	g.GM_setClipboard = (text) => { g.__clip = text; };
	g.GM_registerMenuCommand = () => { /* 本场景不关注菜单 */ };
	let v3Empty = false;   // 置 true 时模拟「下载接口返回空」，验证备用接口兜底
	g.GM_xmlhttpRequest = (opt) => {
		requests4.push(opt);
		setTimeout(async () => {
			const url = String(opt.url || "");
			if (/IOutLink\/(dlFromOutLinkV3|getContentInfoFromOutLink)/.test(url)) {
				const isV3 = /dlFromOutLinkV3/.test(url);
				const payload = isV3
					? (v3Empty
						? { result: { resultCode: "1000", resultDesc: "no link" }, data: {} }
						: { data: { extInfo: { cdnDownloadURL: "https://download-cdn.139.com/file.mkv?sign=mc1" } } })
					: { data: { presentURL: "https://download-cdn.139.com/fallback.mkv?sign=mc2" } };
				const enc = await mod4Helper.encrypt(payload);   // 响应用同款 AES 协议加密
				if (opt.onload) opt.onload({ status: 200, finalUrl: url, responseText: enc, responseHeaders: "" });
				return;
			}
			const body = { id: 1, jsonrpc: "2.0", result: "task-ok" };
			if (opt.onload) opt.onload({ status: 200, responseText: JSON.stringify(body), response: body, responseHeaders: "" });
		}, 0);
		return { abort() { /* noop */ } };
	};
	g.__mcSetV3Empty = (v) => { v3Empty = v; };

	// 登录态：mcloudAccount 从页面存储提取 11 位手机号
	w4.document.cookie = "MQuser=13812345678";
	// Vue 分享状态：selectList（勾选项）+ linkID（分享标识），文件项带 path
	w4.document.getElementById("mcList").__vue__ = {
		linkID: "2xop3UhNZXiaq",
		selectList: [
			{ item: { contentID: "c1", contentName: "家庭教师 Vol.2.mkv", contentSize: 1524626176, path: "家庭教师 Vol.2/家庭教师 Vol.2.mkv" } }
		]
	};

	delete require.cache[require.resolve(SCRIPT)];
	const mod4 = require(SCRIPT);
	// mock 侧的加密助手（与脚本同一协议实现，用于构造加密响应）
	const mod4Helper = { encrypt: mod4.providerApi.mcloudEncrypt };

	await tick(60);
	t("识别为移动云盘分享页", () => {
		assert.strictEqual(mod4.providerApi.current().id, "mcloud");
		assert.strictEqual(mod4.providerApi.pageType(mod4.providers.find((p) => p.id === "mcloud")), "share");
	});

	requests4.length = 0;
	mod4.ui.open();
	await tick(600);   // 静默加密（crypto.subtle 异步）+ 网络跳，给足时间

	t("打开面板即自动换链：请求加密分享接口", () => {
		const req = requests4.find((r) => /dlFromOutLinkV3/.test(String(r.url)));
		assert.ok(req, "应请求移动分享加密接口");
		assert.ok(/share-kd-njs\.yun\.139\.com/.test(String(req.url)), "应指向 share-kd-njs 网关");
	});
	t("请求体按协议加密，解密后含 linkID 与勾选文件", async () => {
		const req = requests4.find((r) => /dlFromOutLinkV3/.test(String(r.url)));
		const decrypted = await mod4.providerApi.mcloudDecryptResponse({ responseText: req.data });
		const inner = decrypted && decrypted.dlFromOutLinkReqV3;
		assert.ok(inner, "应能解出 dlFromOutLinkReqV3 结构");
		assert.strictEqual(inner.linkID, "2xop3UhNZXiaq", "linkID 应为分享 ID");
		assert.ok(inner.account && /^1[3-9]\d{9}$/.test(inner.account), "应自动提取 139 账号");
		assert.deepStrictEqual(inner.coIDLst.item, ["c1"], "coIDLst 应只含勾选文件");
	});
	t("解密后的直链入库且文件名正确", () => {
		const hit = mod4.catcher.pool.find((f) => f.url.indexOf("download-cdn.139.com") >= 0);
		assert.ok(hit, "直链应入库");
		assert.strictEqual(hit.name, "家庭教师 Vol.2.mkv");
	});
	t("空态文案不再引导「点一次下载」", () => {
		assert.ok(!/点一次/.test(document.body.textContent), "页面上不应出现「点一次下载」的引导");
	});

	// 下载接口返回空时：应自动走备用接口取链
	g.__mcSetV3Empty(true);
	mod4.catcher.clear();
	mod4.ui._resolvedSig = "";
	requests4.length = 0;
	await mod4.engine.resolveSelected(mod4.providers.find((p) => p.id === "mcloud"));
	await tick(300);

	t("下载接口为空时自动走备用接口取链", () => {
		assert.ok(requests4.some((r) => /getContentInfoFromOutLink/.test(String(r.url))), "应请求备用接口");
		assert.ok(mod4.catcher.pool.some((f) => f.url.indexOf("fallback.mkv") >= 0), "备用接口的地址应入库");
	});
	t("两个接口都给不出链接时，提示带服务端响应特征（便于定位）", async () => {
		const backup = mod4.providerApi.mcloudShareCall;
		mod4.providerApi.mcloudShareCall = async () => ({
			data: { result: { resultCode: "1000" } },
			diag: '已解出字段 result/data；result={"resultCode":"1000"}'
		});
		let err = "";
		try { await mod4.engine.resolveSelected(mod4.providers.find((p) => p.id === "mcloud")); }
		catch (e) { err = e.message; }
		mod4.providerApi.mcloudShareCall = backup;
		assert.ok(/1000/.test(err), "错误里应含服务端返回码：" + err);
		assert.ok(/字段/.test(err), "错误里应含响应字段诊断：" + err);
	});

	await Promise.all(pending);   // 等齐所有异步断言，避免假绿
	console.log("\n========================================");
	console.log("端到端    通过: " + pass + "    失败: " + fail);
	console.log("========================================");
	process.exit(fail ? 1 : 0);
}

main().catch((e) => {
	console.error("端到端测试异常：", e);
	process.exit(1);
});
