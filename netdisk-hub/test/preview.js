/**
 * 界面预览生成器（开发辅助，不属于交付脚本）
 *
 * 面板是运行时注入的，脱离用户脚本无法单独查看。这里用 jsdom 加载真实脚本、
 * 灌入一组有代表性的数据（含文件夹与已换取的直链），再把渲染结果连同真实样式
 * 导出成一个静态 HTML，便于直接确认视觉效果。
 *
 * 注意：脚本的入口注入走 DOMContentLoaded 之后的观察器，导出前必须等它跑完。
 *
 * 运行：node test/preview.js      （需先装 jsdom，见 README）
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require(path.resolve(__dirname, "../../.tmp/node_modules/jsdom"));

const DIR = path.resolve(__dirname, "..");
const SCRIPT = path.resolve(DIR, "netdisk-hub.user.js");
const OUT = path.resolve(DIR, "preview.html");

const PAGE = `<!DOCTYPE html><html><body>
<div class="share-btns" id="hostBar"><button id="nativeBtn" style="padding:7px 16px;">保存到网盘</button></div>
<div class="frame-main"><div class="file-list" id="fileList"></div></div>
</body></html>`;

const dom = new JSDOM(PAGE, {
	url: "https://pan.quark.cn/s/abc123def",
	runScripts: "outside-only",
	pretendToBeVisual: true
});
const { window } = dom;
const g = global;

g.window = window;
g.document = window.document;
g.location = window.location;
g.Blob = window.Blob;
g.URL = window.URL;
g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
try { g.navigator = window.navigator; } catch (e) { /* 保留宿主 navigator */ }

const storeMap = new Map();
storeMap.set("nd.opt", { showIdm: false, entryStyle: "light", firstTip: false });
g.GM_getValue = (k, d) => (storeMap.has(k) ? storeMap.get(k) : d);
g.GM_setValue = (k, v) => { storeMap.set(k, v); };
g.GM_deleteValue = (k) => { storeMap.delete(k); };
g.GM_setClipboard = () => { /* noop */ };
g.GM_registerMenuCommand = () => { /* noop */ };
g.GM_xmlhttpRequest = (opt) => {
	setTimeout(() => {
		if (opt.onload) opt.onload({ status: 200, responseText: "{}", response: {}, responseHeaders: "" });
	}, 0);
	return { abort() { /* noop */ } };
};

(async () => {
	// 勾选场景刻意贴近真实：分享包里常见的几个文件夹 + 少量真正的文件
	const compProps = {
		stoken: "st-1",
		list: [
			{ fid: "d1", file_name: "解压工具及教程（请先看）", size: 0, file: false, share_fid_token: "t1" },
			{ fid: "d2", file_name: "解压密码CC", size: 0, file: false, share_fid_token: "t2" },
			{ fid: "d3", file_name: "有任何问题请联系q群110769693842", size: 0, file: false, share_fid_token: "t3" },
			{ fid: "f1", file_name: "电影合集.2026.1080p.BluRay.HEVC.mkv", size: 4510269440, file: true, share_fid_token: "t4" },
			{ fid: "f2", file_name: "中文字幕包.zip", size: 12582912, file: true, share_fid_token: "t5" },
			{ fid: "f3", file_name: "播放说明.pdf", size: 839680, file: true, share_fid_token: "t6" }
		],
		selectedRowKeys: ["d1", "d2", "d3", "f1", "f2", "f3"]
	};
	window.document.getElementById("fileList")["__reactFiber$nd"] = {
		type: "div",
		return: { type: function FileList() {}, stateNode: { props: compProps } }
	};
	window.document.cookie = "nd_preview=1";
	window.open = () => null;

	delete require.cache[require.resolve(SCRIPT)];
	const mod = require(SCRIPT);

	// 入口注入挂在 DOMContentLoaded 之后的观察器上，导出前必须等它跑完
	await new Promise((r) => setTimeout(r, 150));
	if (!document.querySelectorAll(".nd-entry").length) {
		console.warn("警告：入口未注入，预览里不会出现「下载助手」按钮。");
	}

	// 换成已换取的直链，模拟「获取直链」完成后的状态
	mod.links.clear();
	[
		["https://cdn.quark.cn/dl/9f2a1c?sign=preview-a", "电影合集.2026.1080p.BluRay.HEVC.mkv", 4510269440],
		["https://cdn.quark.cn/dl/4b7d02?sign=preview-b", "中文字幕包.zip", 12582912],
		["https://cdn.quark.cn/dl/1e88cd?sign=preview-c", "播放说明.pdf", 839680]
	].reverse().forEach(([url, name, size]) => {
		mod.links.put(url, name, size, { Referer: "https://pan.quark.cn/", Cookie: "nd_preview=1" });
	});

	mod.ui.open();
	mod.ui.renderCaught();
	// 换链是异步的，静态快照前把按钮状态复位，免得截到「获取中…」
	mod.ui.busy(mod.ui.root.querySelector('[data-el="resolve-btn"]'), false);
	mod.ui.renderCaught();

	const entryStyle = Array.from(document.querySelectorAll("style")).map((s) => s.textContent).join("\n");
	const scope = document.getElementById("nd-scope");
	scope.querySelector("#nd-panel").classList.add("nd-open");
	scope.querySelector("#nd-overlay").classList.add("nd-open");

	const html = `<!DOCTYPE html>
<html data-color-mode="dark">
<head>
<meta charset="utf-8" />
<title>下载助手 · 界面预览</title>
<style>${entryStyle}</style>
<style>
  html,body{margin:0;padding:0;}
  body{background:#161b22;min-height:100vh;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}
  .preview-note{position:fixed;left:16px;top:86px;z-index:2147483006;max-width:300px;
    color:#0b0f14;font-size:12px;line-height:1.7;background:#fff;padding:6px 10px;border-radius:6px;}
  /* 模拟网盘工具栏：抬高到遮罩之上，衬托注入按钮的实际位置与配色 */
  #hostBar{background:#fff;padding:14px 18px;display:flex;justify-content:flex-end;align-items:center;
    position:relative;z-index:2147483005;}
  #nativeBtn{padding:7px 16px;background:#2e6be6;color:#fff;border:none;border-radius:6px;font-size:14px;}
  #frame-main{display:none;}
</style>
</head>
<body>
<div class="preview-note">上：网盘工具栏，注入的「下载助手」在最右。<br />下：面板本体。数据取自夸克分享页的典型场景。</div>
${document.body.innerHTML}
</body>
</html>`;

	fs.writeFileSync(OUT, html, "utf8");
	console.log("已生成预览：" + OUT);
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
