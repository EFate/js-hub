// ==UserScript==
// @name         网盘直链下载助手
// @namespace    js-hub/netdisk-hub
// @version      1.5.13
// @description  百度网盘 / 夸克网盘 / UC 网盘直链获取与下载调度工具：勾选文件自动换取直链，支持 API 下载（直接下载 / 复制直链 / 推送 IDM）与 Aria2 下载（RPC 推送 / 命令行生成）双通道，配置极简、开箱即用。
// @author       EFate
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/netdisk-hub/netdisk-hub.user.js
// @downloadURL  https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/netdisk-hub/netdisk-hub.user.js
// @match        *://pan.baidu.com/*
// @match        *://yun.baidu.com/*
// @match        *://pan.quark.cn/*
// @match        *://drive.uc.cn/*
// @match        *://openapi.baidu.com/*
// @connect      *
// @connect      localhost
// @connect      127.0.0.1
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        window.close
// @run-at       document-start
// @noframes
// ==/UserScript==

/**
 * 网盘直链下载助手 · 百度网盘 / 夸克网盘 / UC 网盘
 *
 * 设计要点：
 * 1. 只做三家网盘，都把识别与换链做完整：**百度**（分享页签名换链 + 网盘内页静默授权
 *    换链）、**夸克**与 **UC**（列表页与分享页均直接换链，两家协议一致、接入信息各一套）。
 *    三家都不存在「识别得到、拿不到直链」的中间态。
 * 2. 文件识别**读页面框架状态**，不扫 DOM。网盘是 SPA，「有哪些文件」「勾选了哪些」
 *    都存放在 React / Vue 的内部状态里；从文件列表容器反查框架实例即可读出勾选项，
 *    再调网盘接口换成直链。文件夹换不出直链，会单独标出并从请求里剔除。
 * 3. **不拦截网络、不包装原生 API**。三家都有自动换链，靠 hook 页面请求「捡漏」
 *    没有收益，反而会把网盘自己的资源（客户端安装包之类）误当可下载文件收进来。
 *    因此脚本只做「换链」这一件事：您勾选什么，列表里就只有什么。
 * 4. 入口**注入宿主工具栏**，不做悬浮器件。等容器渲染出来再把按钮挂进去，与宿主原生
 *    按钮并排；同时始终保留脚本管理器菜单兜底。不注册任何全局快捷键。
 * 5. 下载出口层分两条独立通道：
 *    - API 下载通道：直接下载 / 复制直链 / 推送 IDM（可选）
 *    - Aria2 下载通道：JSON-RPC 推送 / 生成 aria2c 命令行 / 连通性测试
 *    另提供批量出口（复制全部直链、复制全部命令行、全部推送）。
 * 6. UI 遵循仓库统一的轻量设计规范：面板 + 分组卡片 + Toast，零第三方依赖。
 */
(function () {
	"use strict";

	const VERSION = "1.5.13";
	const KEY = {
		aria: "nd.aria",
		opt: "nd.opt",
		baidu: "nd.baidu",
		flag: "nd.installed"
	};

	/* ==========================================================================
	 * 1. 工具层
	 * ========================================================================== */

	const util = {
		type(o) {
			return Object.prototype.toString.call(o).replace(/^\[object (.+)\]$/, "$1").toLowerCase();
		},
		isStr(o) { return typeof o === "string"; },
		isFn(o) { return typeof o === "function"; },
		isObj(o) { return util.type(o) === "object"; },
		blank(o) { return o === null || o === undefined || o === ""; },

		/** 过滤文件系统非法字符，供下载器安全落盘 */
		fixFilename(name, fallback = "download") {
			const safe = String(name === undefined || name === null ? "" : name)
				.replace(/[!?&|`"'*\/:<>\\]/g, "_")
				.replace(/[\r\n\t]/g, " ")
				.trim();
			return safe || fallback;
		},

		/** UTF-8 安全的 base64（百度接口的 logid 参数用） */
		b64(str) {
			const s = String(str === undefined || str === null ? "" : str);
			try {
				if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(s)));
			} catch (e) { /* 落到 Buffer 分支 */ }
			try {
				if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
			} catch (e) { /* 忽略 */ }
			return "";
		},

		/** 取扩展名（大写，无扩展名返回空串） */
		ext(name) {
			const m = String(name || "").match(/\.([A-Za-z0-9]{1,8})$/);
			return m ? m[1].toUpperCase() : "";
		},

		/** 字节数 → 可读大小 */
		sizeFormat(bytes) {
			const v = Number(bytes);
			if (!isFinite(v) || v < 0) return "-";
			if (v < 1024) return v + " B";
			const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
			let n = v, i = -1;
			do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
			const fixed = n >= 100 ? 0 : n >= 10 ? 1 : 2;
			return n.toFixed(fixed) + " " + units[i];
		},

		/** 请求头归一化：支持对象或原始字符串，键名统一为驼峰 */
		standHeaders(headers) {
			const raw = {};
			if (util.isStr(headers)) {
				headers.split(/[\r\n]+/).forEach((line) => {
					const idx = line.indexOf(":");
					if (idx <= 0) return;
					const k = line.slice(0, idx).trim().toLowerCase();
					const v = line.slice(idx + 1).trim();
					if (k) raw[k] = v;
				});
			} else if (util.isObj(headers)) {
				for (const k in headers) {
					if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
					const v = headers[k];
					if (v === undefined || v === null) continue;
					raw[String(k).toLowerCase()] = util.isObj(v) ? JSON.stringify(v) : String(v);
				}
			}
			const out = {};
			for (const k in raw) {
				const camel = k.split("-").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join("-");
				out[camel] = raw[k];
			}
			return out;
		},

		/** 归一化请求头 → Aria2 的 header 数组：["Key: Value"] */
		headersToArray(headers) {
			const obj = util.standHeaders(headers);
			return Object.keys(obj).map((k) => `${k}: ${obj[k]}`);
		},

		/**
		 * 从 URL 猜文件名。
		 * 仅当路径末段**确实带扩展名**时才采用 —— 否则会把 usercode / report / detail
		 * 这类接口路径段误当文件名，在候选列表里刷出一堆无意义条目。
		 */
		nameFromUrl(url) {
			try {
				const path = new URL(url).pathname;
				const base = decodeURIComponent(path.split("/").filter(Boolean).pop() || "");
				return /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : "";
			} catch (e) {
				return "";
			}
		},

		/** 拼接 a 标签，避免 innerHTML 注入 */
		escapeHtml(s) {
			return String(s === undefined || s === null ? "" : s)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;");
		},

		sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },

		/** 生成短 id，用于列表项与任务标识 */
		uid() { return "nd" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
	};

	/* ==========================================================================
	 * 2. 存储层
	 * ========================================================================== */

	const DEFAULTS = {
		[KEY.aria]: {
			domain: "http://localhost",
			port: "6800",
			path: "/jsonrpc",
			token: "",
			dir: ""
		},
		[KEY.baidu]: {
			token: ""             // 百度开放平台 access_token（网盘内页换链用，静默授权后缓存）
		},
		[KEY.opt]: {
			showIdm: false,       // 是否在直链行上显示「IDM」出口（默认关闭）
			entryStyle: "auto",   // 入口按钮配色：auto 跟随宿主页面 | light 白色 | dark 暗色
			firstTip: true        // 首次安装提示
		}
	};

	const store = {
		_mem: {},
		raw(key) {
			try {
				if (typeof GM_getValue === "function") return GM_getValue(key, undefined);
			} catch (e) { /* 降级 */ }
			try {
				const s = localStorage.getItem(key);
				return s === null ? undefined : JSON.parse(s);
			} catch (e) {
				return store._mem[key];
			}
		},
		get(key) {
			const v = store.raw(key);
			if (v === undefined || v === null) {
				const def = DEFAULTS[key];
				return util.isObj(def) || Array.isArray(def) ? JSON.parse(JSON.stringify(def)) : def;
			}
			// 统一返回深拷贝：调用方就地修改不得污染存储
			return util.isObj(v) || Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v;
		},
		set(key, value) {
			try {
				if (typeof GM_setValue === "function") { GM_setValue(key, value); return; }
			} catch (e) { /* 降级 */ }
			store._mem[key] = value;
			try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 忽略 */ }
		},
		/** 局部更新一个对象型配置 */
		patch(key, partial) {
			const base = store.get(key);
			const next = Object.assign({}, util.isObj(base) ? base : {}, partial || {});
			store.set(key, next);
			return next;
		},
		aria() { return store.get(KEY.aria); },
		opt() { return store.get(KEY.opt); }
	};

	/* ==========================================================================
	 * 3. 网络层
	 * ========================================================================== */

	const net = {
		/** 原始 GM_xmlhttpRequest 封装 */
		raw(opt) {
			const gm = (typeof GM_xmlhttpRequest === "function")
				? GM_xmlhttpRequest
				: (typeof GM !== "undefined" && GM && util.isFn(GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM) : null);
			if (!gm) throw new Error("当前脚本管理器不提供 GM_xmlhttpRequest，无法发起跨域请求。");
			// withCredentials: 跨域随行登录 Cookie。**换链接口**（如百度 filemetas）
			// 需借此确认令牌对应账号的登录态，参考实现同样开启。
			// ⚠️ 注意区分：这里是「取链请求」，必须带 Cookie；
			// 而百度**直链的下载请求**恰恰相反 —— 不能带 Cookie/Referer（见 downloadHeaders）。
			return gm(Object.assign({ timeout: 30000, withCredentials: true }, opt));
		},

		/** POST JSON，用于 Aria2 JSON-RPC */
		rpc(url, payload) {
			return new Promise((resolve, reject) => {
				net.raw({
					method: "POST",
					url,
					headers: { "Content-Type": "application/json" },
					data: JSON.stringify(payload),
					responseType: "text",
					onload(res) {
						let data;
						try {
							data = JSON.parse(res.responseText);
						} catch (e) {
							return reject(new Error(`响应不是合法 JSON（HTTP ${res.status}）`));
						}
						if (data && data.error) {
							return reject(new Error(`RPC 返回错误 ${data.error.code}：${data.error.message}`));
						}
						resolve(data);
					},
					onerror() { reject(new Error("无法连接到 RPC 服务，请确认地址、端口与跨域设置。")); },
					ontimeout() { reject(new Error("RPC 请求超时，请检查服务是否在运行。")); }
				});
			});
		},

		/** POST JSON：用于调用网盘自身接口换取直链 */
		postJson(url, body, headers) {
			return new Promise((resolve, reject) => {
				net.raw({
					method: "POST",
					url,
					headers: util.standHeaders(headers),
					data: JSON.stringify(body || {}),
					responseType: "text",
					onload(res) {
						let data = null;
						try { data = JSON.parse(res.responseText); } catch (e) { data = null; }
						if (data === null) return reject(new Error("接口未返回合法 JSON（HTTP " + res.status + "）"));
						resolve(data);
					},
					onerror: () => reject(new Error("请求失败：" + url)),
					ontimeout: () => reject(new Error("请求超时：" + url))
				});
			});
		},

		/**
		 * POST 表单（返回原始响应）：百度授权页 authorize 需要表单提交，
		 * 但它响应的是 HTML 跳转页而非 JSON，postForm 的 JSON 解析会误判失败，
		 * 所以授权这一步走原样返回。sharedownload 等 JSON 接口仍走 postForm。
		 */
		postFormRaw(url, bodyText, headers) {
			return new Promise((resolve, reject) => {
				net.raw({
					method: "POST",
					url,
					headers: util.standHeaders(Object.assign({ "Content-Type": "application/x-www-form-urlencoded" }, headers || {})),
					data: String(bodyText || ""),
					responseType: "text",
					onload: (res) => resolve(res),
					onerror: () => reject(new Error("请求失败：" + url)),
					ontimeout: () => reject(new Error("请求超时：" + url))
				});
			});
		},

		/** POST 表单：百度 sharedownload 一类接口要求 x-www-form-urlencoded */
		postForm(url, bodyText, headers) {
			return new Promise((resolve, reject) => {
				net.raw({
					method: "POST",
					url,
					headers: util.standHeaders(Object.assign({ "Content-Type": "application/x-www-form-urlencoded" }, headers || {})),
					data: String(bodyText || ""),
					responseType: "text",
					onload(res) {
						let data = null;
						try { data = JSON.parse(res.responseText); } catch (e) { data = null; }
						if (data === null) return reject(new Error("接口未返回合法 JSON（HTTP " + res.status + "）"));
						resolve(data);
					},
					onerror: () => reject(new Error("请求失败：" + url)),
					ontimeout: () => reject(new Error("请求超时：" + url))
				});
			});
		},

		/** GET 文本 */
		async text(url, headers) {
			return new Promise((resolve, reject) => {
				net.raw({
					method: "GET",
					url,
					headers: util.standHeaders(headers),
					responseType: "text",
					onload: (res) => resolve(res),
					onerror: () => reject(new Error("请求失败：" + url)),
					ontimeout: () => reject(new Error("请求超时：" + url))
				});
			});
		},

		/**
		 * 追踪 30x 拿最终 URL。百度 OAuth 的令牌藏在重定向链末端：
		 * authorize → login → login_success#access_token=...，一次 XHR 只拿到中间跳转，
		 * 必须顺着 30x 逐跳递归（参考实现 getFinal 同款做法）。
		 * 最多 6 跳，防止重定向环把请求拖死。
		 */
		async getFinal(url, headers, depth) {
			const MAX = depth || 6;
			let current = url;
			const hdrs = util.standHeaders(headers);
			for (let i = 0; i < MAX; i++) {
				let res;
				try { res = await net.text(current, hdrs); } catch (e) { return current; }
				// GM_xmlhttpRequest 的 finalUrl 已经跟完了重定向链，多数情况下一次即终点
				const next = (res && res.finalUrl) || current;
				const status = res && res.status;
				if (next && next !== current) { current = next; continue; }   // 还有下一跳
				// finalUrl 与请求地址相同：仅在明确是 30x 时才值得再试一次
				if (typeof status === "number" && status >= 300 && status < 400 && i + 1 < MAX) continue;
				break;
			}
			return current;
		}
	};

	/* ==========================================================================
	 * 4. Aria2 通道（核心能力之一）
	 * ========================================================================== */

	const aria = {
		/** 由配置拼出 RPC 地址，容忍用户填写的各种写法 */
		rpcUrl(cfg) {
			let domain = String((cfg && cfg.domain) || "http://localhost").trim().replace(/\/+$/, "");
			if (!/^https?:\/\//i.test(domain)) domain = "http://" + domain;
			const port = util.blank(cfg && cfg.port) ? "" : ":" + String(cfg.port).trim().replace(/^:/, "");
			let path = String((cfg && cfg.path) || "/jsonrpc").trim();
			if (path && path.charAt(0) !== "/") path = "/" + path;
			return domain + port + path;
		},

		/** 把 domain + port 并成一行地址，供设置界面显示（省掉一个输入框） */
		addressOf(cfg) {
			const domain = String((cfg && cfg.domain) || "").trim().replace(/\/+$/, "");
			const port = util.blank(cfg && cfg.port) ? "" : String(cfg.port).trim().replace(/^:/, "");
			return domain + (port ? ":" + port : "");
		},

		/**
		 * 把界面上那一行地址拆回 domain + port。
		 * 容忍 `localhost:6800`、`http://localhost:6800`、`http://localhost:6800/` 等写法；
		 * 未写端口时 port 置空，由 rpcUrl 按原样拼接。
		 */
		parseAddress(text) {
			let s = String(text || "").trim().replace(/\/+$/, "");
			if (!s) return { domain: "", port: "" };
			const m = s.match(/^(https?):\/\//i);
			const proto = m ? m[1].toLowerCase() : "http";
			if (m) s = s.slice(m[0].length);
			s = s.split("/")[0];                       // 丢掉可能被粘贴进来的路径
			let host = s;
			let port = "";
			const i = s.lastIndexOf(":");
			if (i > 0 && /^\d+$/.test(s.slice(i + 1))) {
				host = s.slice(0, i);
				port = s.slice(i + 1);
			}
			return { domain: proto + "://" + host, port };
		},

		/** rpc-secret 参数：设置为空时不传 secret，兼容未启用密钥的 Aria2 */
		_secret(token) {
			return util.blank(token) ? null : "token:" + String(token).trim();
		},

		/** 构建 aria2.addUri 请求体 */
		buildAddUri(cfg, file) {
			const params = [];
			const secret = aria._secret(cfg && cfg.token);
			if (secret) params.push(secret);

			const options = {};
			if (cfg && !util.blank(cfg.dir)) options.dir = String(cfg.dir);
			if (file.out) options.out = util.fixFilename(file.out);
			const header = util.headersToArray(file.headers);
			if (header.length) options.header = header;

			params.push([file.url], options);
			return { id: Date.now(), jsonrpc: "2.0", method: "aria2.addUri", params };
		},

		/** 构建 aria2.getVersion 请求体，用于连通性测试 */
		buildVersion(cfg) {
			const params = [];
			const secret = aria._secret(cfg && cfg.token);
			if (secret) params.push(secret);
			return { id: Date.now(), jsonrpc: "2.0", method: "aria2.getVersion", params };
		},

		/** 推送单个链接到 Aria2 */
		async addUri(cfg, file) {
			const url = aria.rpcUrl(cfg);
			const data = await net.rpc(url, aria.buildAddUri(cfg, file));
			return data.result ? "success" : "fail";
		},

		/** 连通性测试：成功返回 { version, enabledFeatures } */
		async test(cfg) {
			const url = aria.rpcUrl(cfg);
			const data = await net.rpc(url, aria.buildVersion(cfg));
			return data.result || null;
		},

		/** 生成 aria2c 命令行，供未启用 RPC 的场景直接复制使用 */
		toCommand(file) {
			const parts = ["aria2c", `"${file.url}"`];
			if (file.out) parts.push(`--out "${util.fixFilename(file.out)}"`);
			util.headersToArray(file.headers).forEach((h) => parts.push(`--header="${h}"`));
			parts.push("--continue=true");
			parts.push("--max-connection-per-server=16");
			parts.push("--split=16");
			return parts.join(" ");
		}
	};

	/* ==========================================================================
	 * 5. IDM 推送通道
	 * ========================================================================== */

	const idm = {
		_seq: 0,
		/** 通过 IDM 本地捕获端口推送链接（需较新版本 IDM） */
		push(file) {
			return new Promise((resolve) => {
				const seq = ++idm._seq;
				const time = Date.now();
				const url = `http://127.0.0.1:1001/client/1?seq=${seq}`;
				const ext = util.ext(file.out);
				const headersText = util.headersToArray(file.headers).join("\n") + "\n";

				const field = (k, v) => {
					if (v === undefined || v === null) return "";
					const s = String(v);
					// IDM 按字节长度解析字段，必须用 Blob 计算
					let len = s.length;
					try { len = new Blob([s]).size; } catch (e) { /* 忽略 */ }
					return `${k}=${len}:${s}`;
				};

				const fields = [
					field(4, ext),
					field(6, file.url),
					field(7, location.origin),
					field(11, headersText),
					field(100, util.fixFilename(file.out))
				];

				const data = `MSG#${seq}#13#1#10241:${seq + 1000}:0:${time}:0:1:2:${file.size || 0}:0,${fields.join(",")};`;

				net.raw({
					method: "POST",
					url,
					data,
					responseType: "text",
					onload: (res) => resolve(String(res.responseText || "").endsWith(`${seq}:3;`) ? "success" : "fail"),
					onerror: () => resolve("fail"),
					ontimeout: () => resolve("fail")
				});
			});
		}
	};

	/* ==========================================================================
	 * 6. API 下载通道（核心能力之二）
	 * ========================================================================== */

	const outlet = {
		/** 直接下载：用隐藏 iframe 触发浏览器原生下载，避免新标签页被拦截 */
		direct(url) {
			const iframe = document.createElement("iframe");
			iframe.style.cssText = "display:none;width:0;height:0;border:0;position:absolute;left:-9999px";
			iframe.src = url;
			document.body.appendChild(iframe);
			setTimeout(() => { try { iframe.remove(); } catch (e) { /* 忽略 */ } }, 60000);
		},

		/** 复制到剪贴板，带降级方案 */
		copy(text) {
			const value = String(text === undefined || text === null ? "" : text);
			try {
				if (typeof GM_setClipboard === "function") { GM_setClipboard(value, "text"); return true; }
			} catch (e) { /* 降级 */ }
			try {
				const ta = document.createElement("textarea");
				ta.value = value;
				ta.style.cssText = "position:fixed;left:-9999px;top:0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				ta.remove();
				return true;
			} catch (e) {
				return false;
			}
		}
	};

	/* ==========================================================================
	 * 7. 网盘适配层（可插拔表，新增网盘只需追加一项）
	 * ========================================================================== */

	/**
	 * 每项字段说明：
	 *   id      唯一标识
	 *   name    展示名
	 *   match   宿主域名匹配
	 *   pages   页面类型识别：按 pathname 判定 home / share，逐网盘实测整理，
	 *           用于挑选合适的挂载点，避免在登录页等无关页面乱注入。
	 *   mount   工具栏挂载点，按页面类型分组：{ home: [...], share: [...] }。
	 *           必须指向宿主既有容器，且**不得使用 :has()** —— 旧内核会直接抛异常。
	 *   endpoint / ua  换链接口与它要求的客户端 UA
	 *   header  直链请求所需的静态请求头（Aria2 / 命令行 / IDM 均使用）
	 *   hint    未识别到文件时的提示
	 */
	/**
	 * 夸克与 UC 是两家不同的网盘：域名、换链接口、客户端 UA、分享页挂载点都不同，
	 * 但**页面结构与换链协议完全一致**（两份实现逐行相同）。因此采集与换链共用一份
	 * 逻辑，各家只提供自己的接入信息：
	 *   夸克  drive-pc.quark.cn · pr=ucpro    · quark-cloud-drive UA · 分享页 .share-btns
	 *   UC    pc-api.uc.cn      · pr=UCBrowser · uc-cloud-drive UA    · 分享页 .file-info-share-buttom
	 */
	const quarkLike = (cfg) => ({
		id: cfg.id,
		name: cfg.name,
		match: cfg.match,
		pages: { home: /^\/list/, share: /^\/(s|share)\// },
		mount: { home: [".btn-operate .btn-main"], share: cfg.shareMount },
		/** 换链必须走各自的客户端接口并带上客户端 UA，页面自身 UA 会被拒 */
		endpoint: cfg.endpoint,
		ua: cfg.ua,
		/** 直链需要 Referer 与 Cookie 才不被判为盗链 */
		credential: true,
		hint: "请在文件列表中勾选要下载的文件；文件夹无法取直链，请进入文件夹后再勾选其中的文件。",

		/** 读取当前勾选的文件：取数自 React 组件的 props，而非 DOM */
		collect() {
			const out = [];
			const dom = document.getElementsByClassName("file-list")[0];
			const props = pageState.propsOf(pageState.findReact(dom));
			if (!props) return out;
			const stoken = props.stoken || "";
			const files = props.list || [];
			const keys = props.selectedRowKeys || [];
			for (let i = 0; i < files.length; i++) {
				const f = files[i];
				if (keys.indexOf(f.fid) < 0) continue;
				out.push({
					fid: f.fid,
					name: f.file_name,
					size: f.size,
					dir: providerApi.isFolder(f),
					stoken,
					shareToken: f.share_fid_token
				});
			}
			return out;
		},

		/** 调网盘接口把勾选的文件换成直链（两家同一协议，只有端点与 UA 不同） */
		async resolve(files, page) {
			const API = this.endpoint;
			const BATCH = 15;

			// 文件夹没有直链可换，先剔除；一个文件都不剩时给出可操作的提示
			const list = (files || []).filter((f) => !f.dir);
			if (!list.length) throw new Error("勾选的都是文件夹 —— 文件夹无法取直链，请进入文件夹后勾选其中的文件。");

			let pwdId = "";
			let stoken = "";
			if (page === "share") {
				pwdId = providerApi.sharePwdId();
				if (!pwdId) throw new Error("无法从页面提取分享 ID，请刷新页面后重试。");
				stoken = (list[0] && list[0].stoken) || "";
			}

			// 直链会校验 Referer 与 Cookie，只带 UA 会被判为盗链
			const headers = providerApi.downloadHeaders(this);

			const out = [];
			for (let i = 0; i < list.length; i += BATCH) {
				const batch = list.slice(i, i + BATCH);
				const body = { fids: batch.map((f) => f.fid) };
				if (page === "share") {
					body.fids_token = batch.map((f) => f.shareToken);
					body.pwd_id = pwdId;
					body.stoken = stoken;
				}
				const res = await net.postJson(API, body, { "Content-Type": "application/json", "User-Agent": this.ua });
				if (res && res.code === 31001) throw new Error("请先在浏览器里登录网盘，再重试。");
				if (res && res.code === 23018) throw new Error("超出游客可获取的大小上限，请登录网盘后重试。");
				if (res && res.code !== 0) throw new Error("接口返回 code=" + res.code + (res.message ? "：" + res.message : ""));
				(res.data || []).forEach((d) => {
					if (d && d.download_url) out.push({ url: d.download_url, name: d.file_name || "", size: d.size, headers });
				});
				if (i + BATCH < list.length) await util.sleep(1000);   // 节流，避免触发风控
			}
			return out;
		}
	});

	const providers = [
		{
			id: "baidu",
			name: "百度网盘",
			match: /(^|\.)(pan|yun)\.baidu\.com$/i,
			pages: { home: /^\/(disk\/(home|main)|youth\/pan\/main)/, share: /^\/(s|share)\// },
			mount: {
				home: [".wp-s-agile-tool-bar__header"],
				share: [".module-share-top-bar .x-button-box"]
			},
			// 百度直链要求 UA 为 pan.baidu.com；**不带 Referer** ——
			// 开放平台口径下 Referer/Cookie 会把请求降级成网页端会话校验，
			// 与 access_token 冲突并回 31326。故此处只给 UA，credential 保持关闭。
			header: { "User-Agent": "pan.baidu.com" },
			hint: "百度网盘：请在文件列表中勾选目标文件，再点「获取直链」。",

			/** 读取勾选文件：取数自 Vue 实例（新旧两版页面各有一条通道） */
			collect() {
				const out = [];
				let list = [];
				const vue = pageState.findVue(document.querySelector(".file-list"));
				if (vue && Array.isArray(vue.allFileList)) {
					list = vue.allFileList.filter((it) => !!it.selected);
				}
				if (!list.length) {
					const wp = pageState.findVue(document.querySelector(".wp-s-core-pan"));
					if (wp && Array.isArray(wp.selectedList)) list = wp.selectedList;
				}
				if (!list.length) {
					// 最老版页面：勾选态在内部上下文里，不在 Vue 上
					try {
						const w = pageState.win();
						const ctx = (w && typeof w.require === "function") ? w.require("system-core:context/context.js") : null;
						const sel = ctx && ctx.instanceForSystem && ctx.instanceForSystem.list && ctx.instanceForSystem.list.getSelected();
						if (Array.isArray(sel) && sel.length) list = sel;
					} catch (e) { /* 老通道不可用则忽略 */ }
				}
				list.forEach((f) => {
					out.push({
						fid: f.fs_id || f.fid,
						name: f.server_filename || f.name || f.path,
						size: f.size,
						dir: providerApi.isFolder(f),
						path: f.path
					});
				});
				return out;
			},

			/** 分享页走签名换链；网盘内页走静默授权 + filemetas（均全自动） */
			async resolve(files, page) {
				if (page === "share") {
					return providerApi.baiduResolve(files, providerApi.baiduShareInfo());
				}
				let token = store.get(KEY.baidu).token;
				if (!token) token = await providerApi.baiduGetToken();
				if (!token) {
					throw new Error("百度授权未完成：请在弹出的百度授权页确认授权（若未弹出请检查是否被浏览器拦截），然后重新打开面板。");
				}
				return providerApi.baiduHomeResolve(files, token);
			}
		},
		quarkLike({
			id: "quark",
			name: "夸克网盘",
			match: /(^|\.)quark\.cn$/i,
			endpoint: "https://drive-pc.quark.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=ucpro",
			ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch",
			shareMount: [".share-btns"]
		}),
		quarkLike({
			id: "uc",
			name: "UC 网盘",
			match: /(^|\.)uc\.cn$/i,
			endpoint: "https://pc-api.uc.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=UCBrowser",
			ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch",
			shareMount: [".file-info-share-buttom"]
		})
	];

	const providerApi = {
		/** 当前页面命中的网盘适配器，未命中返回 null */
		current() {
			let host = "";
			try { host = location.hostname; } catch (e) { host = ""; }
			if (!host) return null;
			for (let i = 0; i < providers.length; i++) {
				if (providers[i].match.test(host)) return providers[i];
			}
			return null;
		},

		byId(id) {
			for (let i = 0; i < providers.length; i++) {
				if (providers[i].id === id) return providers[i];
			}
			return null;
		},

		/**
		 * 判定一个文件项是否为文件夹。两家的字段名不同：
		 * 夸克用 `file`（**false 表示文件夹**，页面里根本没有 dir 字段），百度用 `isdir`。
		 * 早年只判 `dir`，在夸克上恒为 false，于是文件夹被当成文件送进换链接口，
		 * 一条直链也换不回来 —— 这里统一收敛。
		 */
		isFolder(item) {
			const it = item || {};
			if (typeof it.file === "boolean") return !it.file;       // 夸克：file=false 即文件夹
			if (typeof it.isdir === "boolean") return it.isdir;      // 百度
			if (typeof it.dir === "boolean") return it.dir;           // 通用兜底
			return false;
		},

		/**
		 * 直链下载所需的请求头。
		 * provider.header 里的静态头（百度是 UA pan.baidu.com）先铺开，
		 * provider.ua 覆盖 User-Agent（夸克要求客户端 UA）……
		 *
		 * ⚠️ 百度**不能**带页面 Referer / Cookie：
		 * 开放平台（xpan）直链校验的是 UA + access_token 这一对，
		 * 一旦随行 pan.baidu.com 的 Referer 与登录 Cookie，服务器会把它当成
		 * 「网页端会话」去校验，与开放平台令牌口径冲突，直接回 31326 未授权。
		 * 参考实现下载百度直链时显式传 `{ Origin: "", Referer: "" }`（UA 仍是
		 * pan.baidu.com），正是这个原因。所以 credential 只对夸克 / UC 生效。
		 */
		downloadHeaders(provider) {
			const p = provider || providerApi.current();
			const out = {};
			if (!p) return out;
			if (p.header) {
				for (const k in p.header) {
					if (Object.prototype.hasOwnProperty.call(p.header, k)) out[k] = p.header[k];
				}
			}
			if (p.ua) out["User-Agent"] = p.ua;
			if (!p.credential) return out;
			try {
				if (typeof location !== "undefined" && location.origin && location.origin !== "null") {
					out.Referer = location.origin + "/";
				}
			} catch (e) { /* 忽略 */ }
			try {
				if (typeof document !== "undefined" && document.cookie) out.Cookie = document.cookie;
			} catch (e) { /* 忽略 */ }
			return out;
		},

		/**
		 * 夸克分享页的分享 ID。页面版本不同，参数所在位置也不同，
		 * 依次尝试：新版统计对象 → 旧版统计对象 → URL 路径。
		 */
		sharePwdId() {
			const w = pageState.win();
			const stat = (w && w.factStat) || {};
			const ut = stat.ut && stat.ut.baseParams && stat.ut.baseParams.pwd_id;
			if (ut) return ut;
			const wa = stat.wa && stat.wa.customStatParams && stat.wa.customStatParams.pwd_id;
			if (wa) return wa;
			try {
				const m = String(location.pathname).match(/^\/(?:s|share)\/([A-Za-z0-9]+)/);
				return m ? m[1] : "";
			} catch (e) {
				return "";
			}
		},

		/**
		 * 给 dlink 挂上 access_token。
		 * 参考实现的做法是 `new URL(dlink)` 后 `searchParams.set("access_token", tok)`
		 * —— **覆盖式写入**，而不是「没有才追加」。这一点很关键：
		 * filemetas 返回的 dlink 有时自带一个过期/无效的 access_token，
		 * 只做「不存在才追加」会把这个坏值原样带到下载请求里，
		 * 服务器照样回 31326。这里与参考实现对齐：只要拿到有效令牌就覆盖写。
		 * 无令牌时保持原链（分享页 dlink 不依赖开放平台令牌）。
		 */
		baiduDlink(url, token) {
			const u = String(url || "").trim();
			if (!/^https?:\/\//i.test(u)) return u;
			if (!token) return u;
			try {
				const parsed = new URL(u);
				parsed.searchParams.set("access_token", token);
				return parsed.href;
			} catch (e) {
				return u;
			}
		},

		/**
		 * 百度分享页的运行时参数。字段位置随页面版本不同，逐项兜底：
		 * uk / shareid / bdstoken 在 locals.dump()，jsToken 挂在 window，
		 * 带提取码的分享另有 sekey（验证后写入）。
		 */
		baiduShareInfo() {
			const w = pageState.win();
			const dump = (w && w.locals && typeof w.locals.dump === "function") ? w.locals.dump() : null;
			let surl = "";
			try { surl = (String(location.pathname).split("/").pop() || "").replace(/^1(.{22})$/, "$1"); } catch (e) { surl = ""; }
			let bid = "";
			try { bid = ((document.cookie || "").split("BAIDUID=")[1] || "").split(";")[0]; } catch (e) { bid = ""; }
			const cacheCfg = w && w.cache && w.cache.list && w.cache.list.config && w.cache.list.config.params;
			return {
				surl,
				baiduId: bid,
				uk: dump && dump.share_uk && dump.share_uk.value,
				shareId: dump && dump.shareid && dump.shareid.value,
				bdstoken: (dump && dump.bdstoken && dump.bdstoken.value) || "",
				jsToken: (w && w.jsToken) || "",
				sekey: (w && (w.currentSekey || (cacheCfg && cacheCfg.sekey))) || ""
			};
		},

		/**
		 * 百度分享页换链：tplconfig 取签名 → sharedownload 逐个换 dlink。
		 * 错误码直达文案：112 页面过期、9019 令牌过期；list 为字符串表示文件
		 * 超出分享直接下载的大小上限。换出的 dlink 下载时只需 UA pan.baidu.com
		 * （**不带 Referer / Cookie**，否则与开放平台令牌口径冲突回 31326）。
		 */
		async baiduResolve(files, info) {
			const enc = (v) => encodeURIComponent(String(v === undefined || v === null ? "" : v));
			if (!info || !info.uk || !info.shareId) {
				throw new Error("未能从页面读取分享参数（uk / shareid），请刷新分享页后重试。");
			}
			const logid = util.b64(info.baiduId);
			const signRes = await net.text(
				"https://pan.baidu.com/share/tplconfig?fields=sign,timestamp&channel=chunlei&web=1&app_id=250528&clienttype=0&view_mode=1"
				+ "&surl=1" + enc(info.surl) + "&bdstoken=" + enc(info.bdstoken) + "&logid=" + enc(logid)
			);
			let signData = null;
			try { signData = JSON.parse(signRes.responseText); } catch (e) { signData = null; }
			if (!signData || signData.errno !== 0 || !signData.data || !signData.data.sign) {
				throw new Error("获取分享签名失败（errno=" + (signData && signData.errno) + "），请刷新页面重试。");
			}

			const out = [];
			for (let i = 0; i < files.length; i++) {
				const f = files[i];
				if (f.dir) continue;
				let body = "encrypt=0&product=share&uk=" + enc(info.uk)
					+ "&primaryid=" + enc(info.shareId)
					+ "&fid_list=" + enc(JSON.stringify([f.fid]));
				if (info.sekey) body += "&extra=" + enc(JSON.stringify({ sekey: info.sekey }));
				const res = await net.postForm(
					"https://pan.baidu.com/api/sharedownload?channel=chunlei&clienttype=0&web=1&app_id=250528"
					+ "&sign=" + enc(signData.data.sign) + "&timestamp=" + enc(signData.data.timestamp)
					+ "&bdstoken=" + enc(info.bdstoken) + "&logid=" + enc(logid)
					+ "&jsToken=" + enc(info.jsToken),
					body,
					{ "User-Agent": "netdisk;" }
				);
				if (res.errno === 112) throw new Error("分享页面已过期，刷新页面后重试。（errno 112）");
				if (res.errno === 9019) throw new Error("访问令牌已过期，刷新页面后重试。（errno 9019）");
				if (res.errno === 0 && typeof res.list === "string") {
					throw new Error("该文件超出分享直接下载的大小上限，请先「保存到网盘」后再从网盘页下载。");
				}
				if (res.errno !== 0 || !Array.isArray(res.list) || !res.list.length) {
					throw new Error("换取直链失败（errno=" + (res.errno || "未知") + (res.errmsg ? "：" + res.errmsg : "") + "）。");
				}
				const it = res.list[0] || {};
				if (!it.dlink) throw new Error("接口未返回直链，请刷新页面重试。");
				// 对齐参考实现：分享页 dlink 同样经 searchParams.set("access_token")
				// 覆盖写入。分享链接在部分页面形态下会带一个失效的令牌，
				// 传下去会被判未授权（31326）；有有效令牌时统一覆盖最稳。
				out.push({
					url: providerApi.baiduDlink(it.dlink, store.get(KEY.baidu).token),
					name: f.name || it.server_filename || util.nameFromUrl(it.dlink),
					size: f.size || it.size || 0,
					headers: providerApi.downloadHeaders(providerApi.byId("baidu"))
				});
				if (i + 1 < files.length) await util.sleep(300);
			}
			return out;
		},

		/**
		 * 百度授权拿 access_token。流程逐项对齐参考实现（ref/提取网盘直链.js getToken）：
		 *
		 *   ① getFinal 追踪 authorize 的重定向链：
		 *      · 落地 URL 含 access_token → 已是授权态，直接取用（**且会顺路刷新过期令牌**，
		 *        这一步是 31326 的头号克星：修复前只读单次 finalUrl，重定向链没跟完就判定
		 *        「没拿到」，于是每次换链都带着空/旧令牌去请求，服务器一律回 31326）；
		 *      · 落地 URL 含 authorize → 尚未授权，进 ②；
		 *   ② GET authorize 页取 HTML 里的 bdstoken / client_id，POST 表单自动确认授权；
		 *   ③ 再 getFinal 一次取回 access_token；
		 *   ④ 都不成 → 开真实标签页走人工授权，由本篇的登录成功页捕获分支写缓存，
		 *      这里轮询等它（120 秒）。
		 *
		 * 取到即写入缓存；9019 / 31326 时由调用方清缓存触发重走本流程。
		 */
		async baiduGetToken() {
			const AUTH = "https://openapi.baidu.com/oauth/2.0/authorize?response_type=token&scope=basic,netdisk&client_id=omiOnr2tYnN9vSyDErcVFWpPU2mZA7YO&redirect_uri=oob&confirm_login=0";
			// 与参考脚本一致：授权请求带浏览器真实 UA（参考 standHeaders 默认注入
			// User-Agent: navigator.userAgent），Origin/Referer 留空避免被校验来源。
			const authHdr = () => {
				const h = { Origin: "", Referer: "" };
				try { if (typeof navigator !== "undefined" && navigator.userAgent) h["User-Agent"] = navigator.userAgent; } catch (e) { /* 忽略 */ }
				return h;
			};
			const pickToken = (u) => {
				const m = String(u || "").match(/access_token=([^&#]+)/);
				return m ? decodeURIComponent(m[1]) : "";
			};

			let token = "";
			// 静默路径：token 式授权会把令牌挂到重定向链末端，必须跟完 30x 才拿得到
			try {
				const authorize = await net.getFinal(AUTH, authHdr());
				if (authorize.includes("access_token=")) {
					token = pickToken(authorize);
				} else if (authorize.includes("authorize")) {
					// 尚未授权：从授权页表单里取自动确认所需参数
					const page = await net.text(AUTH, authHdr());
					const html = String((page && page.responseText) || "");
					const bdstoken = (html.match(/name="bdstoken"\s+value="([^"]+)"/) || [])[1] || "";
					const clientId = (html.match(/name="client_id"\s+value="([^"]+)"/) || [])[1] || "";
					if (bdstoken && clientId) {
						const body = "grant_permissions_arr=netdisk&bdstoken=" + encodeURIComponent(bdstoken)
							+ "&client_id=" + encodeURIComponent(clientId)
							+ "&response_type=token&display=page&grant_permissions=" + encodeURIComponent("basic,netdisk");
						await net.postFormRaw(AUTH, body, authHdr());
						token = pickToken(await net.getFinal(AUTH, authHdr()));
					}
				}
			} catch (e) { token = ""; }
			if (token) { store.patch(KEY.baidu, { token }); return token; }

			// 真实标签页授权：登录成功页由本脚本捕获令牌入库，这里轮询等它
			if (typeof GM_openInTab === "function") {
				try { GM_openInTab(AUTH, { active: true, insert: true, setParent: true }); }
				catch (e) { try { window.open(AUTH, "_blank"); } catch (e2) { /* 忽略 */ } }
			} else {
				try { window.open(AUTH, "_blank"); } catch (e) { /* 忽略 */ }
			}
			const t0 = Date.now();
			while (Date.now() - t0 < 120000) {
				const tok = store.get(KEY.baidu).token;
				if (tok) return tok;
				await util.sleep(1000);
			}
			return "";
		},

		/**
		 * 百度网盘内页换链：xpan/filemetas 按勾选的 fs_id 批量取 dlink（分批 50）。
		 * 9019 = 令牌过期，自动清缓存（下次换链会重新静默授权）；112 = 页面过期。
		 */
		/**
		 * 百度网盘内页换链：xpan/filemetas 按勾选的 fs_id 批量取 dlink（分批 50）。
		 *
		 * 令牌失效（9019 / 31326）时**自动重授权一次再重试**，而不是直接抛错让用户
		 * 手动刷新 —— 这是面板「点一次就成功」的关键。重试仍失败才清缓存并报错，
		 * 避免拿空令牌反复打接口。
		 */
		async baiduHomeResolve(files, token) {
			try {
				return await providerApi.baiduHomeMetas(files, token);
			} catch (e) {
				if (!e || !e.baiduAuthStale) throw e;
				// 缓存令牌已失效：清掉后走一次完整授权（含 30x 追踪 + 落地页兜底）
				store.patch(KEY.baidu, { token: "" });
				const fresh = await providerApi.baiduGetToken();
				if (!fresh) throw new Error("百度授权已失效且未能自动续期 —— 请在弹出的授权页确认授权后重试。");
				try {
					return await providerApi.baiduHomeMetas(files, fresh);
				} catch (e2) {
					if (e2 && e2.baiduAuthStale) {
						store.patch(KEY.baidu, { token: "" });
						throw new Error("百度授权已失效（31326 未授权），自动续期后仍被拒绝 —— 请重新打开面板再取一次。");
					}
					throw e2;
				}
			}
		},

		/** filemetas 实际请求（令牌失效时抛带 baiduAuthStale 标记的错误，交由上层续期重试） */
		async baiduHomeMetas(files, token) {
			const fsids = files.filter((f) => !f.dir).map((f) => f.fid);
			if (!fsids.length) throw new Error("没有可换链的文件。");
			// filemetas 按 fs_id 返回，对回勾选文件拿名字 ——
			// 它的字段名是 filename（server_filename 是 sharedownload 的字段），
			// 且 dlink 末段没有文件名，漏了这步会全是「未命名文件」
			const byFs = {};
			files.forEach((f) => { byFs[String(f.fid)] = f; });
			const BATCH = 50;
			const out = [];
			for (let i = 0; i < fsids.length; i += BATCH) {
				const batch = fsids.slice(i, i + BATCH);
				const res = await net.text(
					"https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1"
					+ "&fsids=" + encodeURIComponent(JSON.stringify(batch))
					+ "&access_token=" + token,
					// 参考脚本：filemetas 须带 pan.baidu.com UA，且开放平台校验来源，
					// 补上 Origin / Referer（与参考 standHeaders 默认头一致）。
					Object.assign({ "User-Agent": "pan.baidu.com" },
						(() => {
							const h = {};
							try { if (location.origin && location.origin !== "null") { h.Origin = location.origin; h.Referer = location.origin + "/"; } } catch (e) { /* 忽略 */ }
							return h;
						})()
					)
				);
				let data = null;
				try { data = JSON.parse(res.responseText); } catch (e) { data = null; }
				// 未授权的三种形态：9019（令牌失效）、31326（OAuth 层未授权）、
				// -6（开放平台 errmsg "no permission"）。统一抛标记错误触发自动续期。
				const stale = data && (data.errno === 9019 || data.error_code === 31326 || data.errno === -6);
				if (stale) {
					const err = new Error("百度令牌失效，正在自动续期…");
					err.baiduAuthStale = true;
					throw err;
				}
				if (data && data.errno === 112) throw new Error("页面已过期，刷新后重试。（errno 112）");
				if (!data || data.errno !== 0 || !Array.isArray(data.list)) {
					throw new Error("换取直链失败（errno=" + ((data && data.errno) || "未知") + "）。");
				}
				data.list.forEach((it) => {
					if (!it.dlink) return;
					const f = byFs[String(it.fs_id)] || {};
					// 开放平台 filemetas 直链必须随链带 access_token，否则下载被判为
					// 未授权（31326 / user is not authorized, hitcode:119）
					out.push({
						url: providerApi.baiduDlink(it.dlink, token),
						name: f.name || it.server_filename || it.filename || util.nameFromUrl(it.dlink),
						size: f.size || it.size || 0,
						headers: providerApi.downloadHeaders(providerApi.byId("baidu"))
					});
				});
				if (i + BATCH < fsids.length) await util.sleep(500);
			}
			return out;
		},

		/**
		 * 按 pathname 判定当前页面类型：home | share | ""（无法判定）。
		 * 用于挑选合适的挂载点，也决定百度走「分享页签名换链」还是「内页静默授权换链」。
		 */
		pageType(provider) {
			const p = provider || providerApi.current();
			if (!p || !p.pages) return "";
			let path = "";
			try { path = location.pathname; } catch (e) { path = ""; }
			if (!path) return "";
			if (p.pages.home && p.pages.home.test(path)) return "home";
			if (p.pages.share && p.pages.share.test(path)) return "share";
			return "";
		},
	};

	/* ==========================================================================
	 * 8. 引擎层：下载编排
	 * ========================================================================== */

	const engine = {
		/** 兜底请求头：补上浏览器 UA，避免部分 CDN 拒绝空 UA */
		mergeHeaders(headers) {
			const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
			const base = ua ? { "User-Agent": ua } : {};
			return Object.assign(base, util.standHeaders(headers));
		},

		/** 推送到 Aria2 */
		async pushAria(file) {
			const cfg = store.aria();
			const payload = {
				url: file.url,
				out: file.name,
				headers: engine.mergeHeaders(file.headers)
			};
			const res = await aria.addUri(cfg, payload);
			return res;
		},

		/** 批量推送到 Aria2 */
		async pushAriaBatch(files) {
			let ok = 0;
			for (let i = 0; i < files.length; i++) {
				try {
					if (await engine.pushAria(files[i]) === "success") ok++;
				} catch (e) { /* 单条失败不阻断其余 */ }
				await util.sleep(120);
			}
			return { ok, total: files.length };
		},

		/** 读取当前页面勾选的文件（各网盘自行实现 collect） */
		selected(provider) {
			const p = provider || providerApi.current();
			if (!p || !util.isFn(p.collect)) return [];
			try {
				return p.collect() || [];
			} catch (e) {
				return [];
			}
		},

		/** 勾选文件 → 调网盘接口换直链 → 入库候选池 */
		async resolveSelected(provider) {
			const p = provider || providerApi.current();
			if (!p) throw new Error("当前页面不在已内置的网盘范围内");
			const files = engine.selected(p);
			if (!files.length) throw new Error("请先在文件列表中勾选要下载的文件");

			// 文件夹换不出直链，提前说清楚，不把注定无结果的请求打到网盘
			const real = files.filter((f) => !f.dir);
			if (!real.length) throw new Error("勾选的都是文件夹 —— 文件夹无法取直链，请进入文件夹后勾选其中的文件。");

			if (!util.isFn(p.resolve)) {
				throw new Error(p.name + " 的自动换链尚未接入（勾选识别已就绪）。");
			}
			// 注意：局部变量不要叫 links —— 会遮蔽模块级的结果池
			const resolved = await p.resolve(files, providerApi.pageType(p));
			let added = 0;
			resolved.forEach((l) => {
				if (links.put(l.url, l.name, l.size, l.headers)) added++;
			});
			return { total: resolved.length, added, skipped: files.length - real.length };
		},

		/** 测试 Aria2 连通性 */
		async testAria(cfg) {
			return aria.test(cfg || store.aria());
		},

		/** 生成 aria2c 命令行文本 */
		commandOf(file) {
			return aria.toCommand({
				url: file.url,
				out: file.name,
				headers: engine.mergeHeaders(file.headers)
			});
		},

		/** 多文件按行拼接（\r\n），供批量复制使用 */
		joinLines(files, mapper) {
			return (files || []).map(mapper).filter(Boolean).join("\r\n");
		},

		/** 全部直链文本（每行一条） */
		allLinks(files) {
			return engine.joinLines(files, (f) => f.url);
		},

		/** 全部 aria2c 命令行文本（每行一条） */
		allCommands(files) {
			return engine.joinLines(files, (f) => engine.commandOf(f));
		}
	};

	/* ==========================================================================
	 * 9. 直链结果池：换链结果都落在这里，面板读它渲染列表
	 * ========================================================================== */

	/**
	 * 这里**只存结果，不做任何网络拦截**。
	 *
	 * 三家网盘都有完整的自动换链，靠 hook 页面请求「捡漏」没有收益，反而会引入噪声 ——
	 * 实际遇到过把网盘自己的客户端安装包当成可下载文件收进来的情况：用户一个文件都没勾，
	 * 「可用直链」里却多出一条（形如 xxx_release_signed.apk、大小未知 —— 捕获条目的 size 恒为 0）。
	 * 不包装原生 API 也顺带避免了影响网盘自身的「下载」按钮。
	 */
	const links = {
		/** 结果列表（新的在前，超出上限截断） */
		pool: [],
		MAX: 60,

		/**
		 * 入库：**同名合并**，而不是按 URL 去重 —— 网盘直链每次换取都带新签名，
		 * 按 URL 去重挡不住「重新获取」造成的重复（同名文件会越堆越多）。
		 * 同名即同一文件：覆盖为最新一条（签名与请求头随之更新）并置顶。
		 * 实在拿不到名字时退回按 URL 去重，避免所有无名条目挤成一条。
		 */
		put(url, name, size, headers) {
			const u = String(url || "").trim();
			if (!/^https?:\/\//i.test(u)) return false;
			const rawName = String(name || "").trim() || util.nameFromUrl(u);
			const label = util.fixFilename(rawName || "未命名文件");
			const key = rawName ? "name:" + label.toLowerCase() : "url:" + u;
			for (let i = 0; i < links.pool.length; i++) {
				const it = links.pool[i];
				if (it.url === u) return false;            // 完全相同，无事可做
				if (it.key !== key) continue;
				it.url = u;
				it.size = Number(size) || it.size;
				if (headers) it.headers = headers;
				it.time = Date.now();
				links.pool.splice(i, 1);
				links.pool.unshift(it);                    // 最新一条置顶
				return true;
			}
			links.pool.unshift({
				id: util.uid(),
				key,
				url: u,
				name: label,
				size: Number(size) || 0,
				headers: headers || null,
				time: Date.now()
			});
			if (links.pool.length > links.MAX) links.pool.length = links.MAX;
			return true;
		},

		clear() { links.pool.length = 0; }
	};

	/* ==========================================================================
	 * 10. 页面状态层：从页面框架内部读文件列表与勾选态
	 * ========================================================================== */

	/**
	 * 网盘页面是 SPA，文件列表与「勾选了哪些」都存放在框架（React / Vue）的内部状态里，
	 * 而不在 DOM 上 —— 这正是「扫 DOM 扫不到东西」的根本原因。
	 * 这里提供两条通用取数通道，各网盘按自身框架选用其一。
	 */
	const pageState = {
		/** 从 DOM 节点反查 React fiber，再逐级上探到组件实例 */
		findReact(dom, traverseUp) {
			if (!dom) return null;
			try {
				const key = Object.keys(dom).find((k) => k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0);
				if (!key) return null;
				const fiber = dom[key];
				if (!fiber) return null;

				const isHost = (f) => f && typeof f.type === "string";
				const upToComponent = (f) => {
					let cur = f;
					while (cur && isHost(cur)) cur = cur.return;
					return cur;
				};

				let comp = upToComponent(fiber);
				for (let i = 0; i < (traverseUp || 0); i++) {
					comp = upToComponent(comp && comp.return);
				}
				if (!comp) return null;
				return comp.stateNode || comp;
			} catch (e) {
				return null;
			}
		},

		/** 取 Vue 实例（兼容 Vue 2 的 __vue__ 与 Vue 3 的 __vueParentComponent） */
		findVue(dom) {
			if (!dom) return null;
			try {
				if (dom.__vue__) return dom.__vue__;
				let cur = dom;
				for (let i = 0; i < 5 && cur; i++) {
					if (cur.__vueParentComponent) return cur.__vueParentComponent;
					cur = cur.parentElement;
				}
			} catch (e) { /* 忽略 */ }
			return null;
		},

		/** 取组件 props（兼容多种 fiber 形态） */
		propsOf(reactObj) {
			if (!reactObj) return null;
			return reactObj.props || reactObj.pendingProps || reactObj.memoizedProps || null;
		},

		/** 安全取全局对象（油猴沙箱下优先 unsafeWindow） */
		win() {
			return (typeof unsafeWindow !== "undefined" && unsafeWindow) ? unsafeWindow : (typeof window !== "undefined" ? window : null);
		}
	};

	/* ==========================================================================
	 * 11. 页面注入层：把入口挂进宿主既有的工具栏容器
	 * ========================================================================== */

	const inject = {
		/** 入口标记 class：同时用于样式与防重复注入 */
		FLAG: "nd-entry",

		/** 精确选择器落空后，等多久再尝试模糊匹配（毫秒） */
		fallbackDelay: 3000,

		/**
		 * 按文案匹配动作按钮 —— 网盘改版会换类名，但「下载 / 保存到网盘 / 上传」
		 * 这些**用户可见文案**是稳定的，用它定位挂载点比类名可靠得多。
		 */
		ACTION_WORDS: /^(下载|批量下载|离线下载|保存到网盘|转存|保存|上传|新建|新建文件夹|分享|更多|排序|全选|删除|移动|复制)$/,

		/** 主匹配落空时的次级匹配（文案只要含这些词即可） */
		ACTION_LOOSE: /(保存到网盘|下载|转存|上传)/,

		/** 注入过程的现场记录：注入失败时靠它定位（面板「关于」页可一键复制） */
		report: {
			provider: "",
			pageType: "",
			url: "",
			tried: [],
			via: "",
			host: "",
			done: false,
			note: ""
		},

		/**
		 * 等待选择器命中元素后执行回调。
		 * 宿主是 SPA、工具栏异步渲染，因此用 MutationObserver 观察，而非轮询或 setTimeout 硬等。
		 */
		waitFor(selector, cb, opts) {
			const option = opts || {};
			const doc = option.doc || (typeof document !== "undefined" ? document : null);
			if (!doc) return;   // 无文档环境（Worker / 测试）直接跳过
			let fired = false;

			const attempt = () => {
				if (fired) return true;
				let el = null;
				try {
					el = doc.querySelector(selector);
				} catch (e) {
					return true;   // 选择器非法，放弃而不抛错
				}
				if (!el) return false;
				fired = true;
				try { cb(el); } catch (e) { /* 回调异常不得影响观察器 */ }
				return true;
			};

			if (attempt()) return;

			const root = doc.documentElement || doc.body;
			// 兼容受限宿主：MutationObserver 可能不作为裸全局暴露，只能从 window 上取
			const MO = (typeof MutationObserver === "function")
				? MutationObserver
				: (typeof window !== "undefined" && typeof window.MutationObserver === "function" ? window.MutationObserver : null);
			if (!root || !MO) return;

			const observer = new MO(() => {
				if (attempt()) observer.disconnect();
			});
			observer.observe(root, { childList: true, subtree: true });
			// 兜底：超时后停止观察，避免长期持有观察器
			setTimeout(() => observer.disconnect(), option.timeout || 30000);
		},

		/**
		 * SPA 守护心跳：定时驱动一次「入口还在不在」的检查。
		 * 网盘页面是单页应用，进入文件夹等路由切换会把工具栏整块重渲染，
		 * 注入的按钮随之被拆走 —— waitFor 命中一次就收工，覆盖不了这种场景。
		 * 不用 MutationObserver 常驻监听（长期持有观察器代价高），
		 * 用低频轮询：真实浏览器 1.5s 一拍，无布局环境（测试）300ms 一拍。
		 */
		watch(tick) {
			if (typeof document === "undefined" || typeof setInterval !== "function") return;
			if (inject.guardTimer) return;   // 守护只需一个，重复 mount 不叠加
			const timer = setInterval(() => {
				try { tick(); } catch (e) { /* 单拍异常不得中断守护 */ }
			}, inject.hasLayout() ? 1500 : 300);
			if (timer && typeof timer.unref === "function") timer.unref();   // 不阻塞测试进程退出
			inject.guardTimer = timer;
		},

		/**
		 * 确保入口样式已就位。
		 * 入口按钮在页面加载期就创建，而面板样式是懒挂载的 —— 若两者共用一份样式，
		 * 按钮会有一整段时间处于「无样式」状态（图标撑成巨块、没有边框与底色）。
		 * 所以入口样式必须独立、随注入即时生效。
		 */
		ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById("nd-entry-style")) return;
			const style = document.createElement("style");
			style.id = "nd-entry-style";
			style.textContent = ENTRY_CSS;
			(document.head || document.documentElement).appendChild(style);
		},

		/** 生成融入式入口按钮：描边 + 继承文字色，以适配深/浅两种宿主主题 */
		/**
		 * 给入口上色。auto = 按宿主页面背景亮度自动选白/暗；
		 * light / dark 由用户在偏好设置里指定。
		 */
		applyEntryStyle(el) {
			if (!el) return;
			const mode = store.opt().entryStyle || "auto";
			el.classList.toggle("nd-entry-dark", inject.hostTheme() === "dark" || mode === "dark");
		},

		/** 探测宿主页面明暗：按 body 背景色算亮度 */
		hostTheme() {
			try {
				const bg = getComputedStyle(document.body).backgroundColor;
				const m = bg.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
				if (m) {
					const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
					return lum < 128 ? "dark" : "light";
				}
			} catch (e) { /* 忽略 */ }
			return "light";
		},

		entry(provider) {
			inject.ensureStyle();
			const btn = document.createElement("div");
			btn.className = inject.FLAG;
			inject.applyEntryStyle(btn);
			btn.setAttribute("role", "button");
			btn.setAttribute("tabindex", "0");
			btn.title = (provider ? provider.name + " · " : "") + "打开下载助手";
			// 图标自带内联表现属性：即便样式尚未生效，也不会被填充成实心色块
			btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg><span>下载助手</span>';
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				ui.openSafe();
			});
			btn.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					ui.open();
				}
			});
			return btn;
		},

		/** 算出该网盘在当前页面应使用的挂载点候选 */
		selectorsFor(provider) {
			const mount = provider && provider.mount;
			if (!mount) return [];
			if (Array.isArray(mount)) return mount;   // 兼容旧的数组写法
			const page = providerApi.pageType(provider);
			if (page && Array.isArray(mount[page])) return mount[page];
			// 页面类型识别不出来时合并全部候选，尽量把入口注进去（宁多试，不漏掉）
			const all = [];
			Object.keys(mount).forEach((k) => {
				if (Array.isArray(mount[k])) all.push.apply(all, mount[k]);
			});
			return all;
		},

		/**
		 * 文案匹配：在页面里找一个可见的动作按钮（下载 / 保存到网盘 / 上传…），
		 * 返回它所在的那排按钮容器与自身位置 —— 网盘改版换类名时靠它兜底。
		 * 无布局环境（jsdom / 测试）不做可见性过滤，只按文案与结构匹配。
		 */
		actionHost() {
			if (typeof document === "undefined") return null;
			const layout = inject.hasLayout();
			const nodes = document.querySelectorAll("button, a, [role=button], span, div");
			const strict = [];
			const loose = [];
			for (let i = 0; i < nodes.length && i < 6000; i++) {
				const el = nodes[i];
				if (el.classList && el.classList.contains(inject.FLAG)) continue;
				// 只认「叶子文案」，避免把整页容器也算进来
				if (el.querySelector && el.querySelector("button, a, [role=button]")) continue;
				const text = (el.textContent || "").trim();
				if (!text || text.length > 12) continue;
				if (inject.ACTION_WORDS.test(text)) {
					if (!layout || inject.visible(el)) strict.push(el);
				} else if (inject.ACTION_LOOSE.test(text)) {
					if (!layout || inject.visible(el)) loose.push(el);
				}
			}
			const pick = strict[0] || loose[0] || null;
			if (!pick) return null;
			return { host: inject.rowOf(pick), anchor: pick };
		},

		/** 当前环境是否具备布局能力（jsdom 等测试环境没有，此时跳过可见性判断） */
		hasLayout() {
			try {
				if (typeof document === "undefined" || !document.body) return false;
				const r = document.body.getBoundingClientRect();
				return !!(r && (r.width > 0 || r.height > 0));
			} catch (e) {
				return false;
			}
		},

		/** 元素是否可见（尺寸与样式都要过） */
		visible(el) {
			try {
				const r = el.getBoundingClientRect();
				if (!r) return false;
				if (r.width === 0 && r.height === 0) return true;   // 无布局环境：不据尺寸否决
				if (r.width < 24 || r.height < 14) return false;
				const st = getComputedStyle(el);
				if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) < 0.2) return false;
				return true;
			} catch (e) {
				return true;
			}
		},

		/**
		 * 从按钮上探出「一排按钮」的容器（最多 3 级）——
		 * 注入到容器里才能与原生按钮并排，而不是塞进某个按钮内部。
		 */
		rowOf(el) {
			let host = el.parentElement;
			for (let up = 0; up < 3 && host && host.tagName !== "BODY"; up++) {
				const count = host.querySelectorAll("button, a, [role=button]").length;
				if (count >= 2) return host;
				host = host.parentElement;
			}
			return (el.parentElement && el.parentElement.tagName !== "BODY") ? el.parentElement : el;
		},

		/**
		 * 注入挂载：三级降级 ——
		 * ① 各网盘精确选择器（可出现即命中，MutationObserver 等待）
		 * ② 文案匹配（等待一档后仍无命中则执行，改版免疫）
		 * ③ 脚本管理器菜单（始终可用，属于兜底而非此处逻辑）
		 * 全过程记进 inject.report，面板「关于」页可查看/复制，便于定位。
		 */
		mount(provider) {
			if (!provider) return;
			inject.ensureStyle();
			const selectors = inject.selectorsFor(provider);
			inject.report = {
				provider: provider.id,
				pageType: providerApi.pageType(provider),
				url: (typeof location !== "undefined" ? location.href : ""),
				tried: selectors.slice(),
				via: "",
				host: "",
				done: false,
				note: ""
			};

		let settled = false;
		let placedBtn = null;   // 已放置的入口：SPA 重渲染拆走按钮后靠它发现
		const place = (host, via, anchor) => {
			if (settled || !host) return;
			settled = true;
			inject.report.via = via;
			inject.report.done = true;
			try {
				inject.report.host = host.tagName + (host.className ? "." + String(host.className).trim().split(/\s+/).slice(0, 2).join(".") : "");
			} catch (e) { /* 忽略 */ }
			const exist = host.querySelector("." + inject.FLAG);
			if (exist) { placedBtn = exist; return; }   // 防重复注入
			const btn = inject.entry(provider);
			placedBtn = btn;
			/**
			 * 位置：优先 append 到容器末尾 —— 入口落在工具栏最右侧，
			 * 与「保存到网盘 / 下载」等主操作同一排、且不打断原生排列。
			 * 仅当容器本身就是那个按钮时才插在它之后。
			 */
			if (anchor && host === anchor) {
				anchor.insertAdjacentElement("afterend", btn);
			} else {
				host.append(btn);
			}
		};

		selectors.forEach((selector) => {
			inject.waitFor(selector, (host) => place(host, "精确选择器 " + selector, null));
		});

		// ② 文案匹配兜底：精确选择器没能命中时，用页面上的动作按钮定位
		setTimeout(() => {
			if (settled) return;
			const hit = inject.actionHost();
			if (hit) {
				place(hit.host, "文案匹配「" + (hit.anchor.textContent || "").trim().slice(0, 8) + "」", hit.anchor);
			} else {
				inject.report.note = "精确选择器与文案匹配均未命中 —— 可用脚本管理器菜单打开面板";
			}
		}, inject.fallbackDelay);

		// ③ SPA 守护：进入文件夹等路由切换会把工具栏整块重渲染，按钮随之被拆走。
		// 定期检查入口是否还连在文档里；被拆走（或始终没挂上）就重新走一遍放置逻辑。
		const mountDoc = (typeof document !== "undefined") ? document : null;
		inject.watch(() => {
			if (!mountDoc) return;
			if (placedBtn && placedBtn.isConnected === false) {
				placedBtn = null;
				settled = false;
				inject.report.done = false;
			}
			if (settled) return;
			const sels = inject.selectorsFor(provider);
			for (let i = 0; i < sels.length; i++) {
				let host = null;
				try { host = mountDoc.querySelector(sels[i]); } catch (e) { continue; }
				if (host) { place(host, "精确选择器 " + sels[i], null); break; }
			}
			if (!settled) {
				const hit = inject.actionHost();
				if (hit) place(hit.host, "文案匹配「" + (hit.anchor.textContent || "").trim().slice(0, 8) + "」", hit.anchor);
			}
		});
	},

		/** 启动注入：仅在识别到网盘且其配置了挂载点时执行 */
		start() {
			const provider = providerApi.current();
			if (!provider) return null;
			inject.mount(provider);
			return provider;
		}
	};

	/* ==========================================================================
	 * 12. 样式：遵循仓库统一设计规范
	 * ========================================================================== */

	const CSS = `
html{--nd-accent:#2da44e;--nd-accent-2:#1a7f37;--nd-accent-fg:#fff;--nd-good:#2da44e;--nd-warn:#d29922;--nd-bad:#f85149;}
html[data-color-mode="light"]{--nd-accent:#1a7f37;--nd-accent-2:#116329;}
#nd-scope{
  --nd-bg:#0d1117;--nd-bg-2:#151b23;--nd-bg-3:#1c232b;
  --nd-bd:#2b323a;--nd-bd-2:#21272e;
  --nd-fg:#e6edf3;--nd-fg-2:#9aa4af;--nd-fg-3:#6e7681;
  --nd-shadow:0 18px 48px rgba(0,0,0,.55);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  color:var(--nd-fg);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;
}
#nd-scope.nd-light{
  --nd-bg:#fff;--nd-bg-2:#f6f8fa;--nd-bg-3:#eef1f4;
  --nd-bd:#d8dee4;--nd-bd-2:#e8ecf0;
  --nd-fg:#1f2328;--nd-fg-2:#59636e;--nd-fg-3:#818b98;
  --nd-shadow:0 18px 48px rgba(31,35,40,.18);
}
#nd-scope svg{width:1em;height:1em;fill:currentColor;flex:none;vertical-align:-.125em;}
#nd-scope .nd-ico{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;flex:none;}
#nd-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(1,4,9,.62);opacity:0;pointer-events:none;transition:opacity .2s;}
#nd-overlay.nd-open{opacity:1;pointer-events:auto;}
#nd-panel{position:fixed;left:50%;top:50%;z-index:2147483002;width:560px;max-width:calc(100vw - 32px);max-height:84vh;
  background:var(--nd-bg);border:1px solid var(--nd-bd);border-radius:14px;box-shadow:var(--nd-shadow);
  display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translate(-50%,-46%) scale(.97);pointer-events:none;
  transition:opacity .22s,transform .22s cubic-bezier(.4,0,.2,1);}
#nd-panel.nd-open{opacity:1;transform:translate(-50%,-50%) scale(1);pointer-events:auto;}
.nd-head{display:flex;align-items:center;gap:10px;padding:15px 16px;border-bottom:1px solid var(--nd-bd-2);flex:none;}
.nd-mark{width:26px;height:26px;border-radius:7px;background:var(--nd-accent);color:#fff;display:flex;align-items:center;justify-content:center;flex:none;}
.nd-mark .nd-ico{width:15px;height:15px;stroke-width:1.9;}
.nd-head h2{margin:0;font-size:15px;font-weight:600;color:var(--nd-fg);letter-spacing:.2px;}
.nd-ver{font-size:11px;color:var(--nd-fg-3);border:1px solid var(--nd-bd);border-radius:6px;padding:1px 7px;}
.nd-grow{flex:1;}
.nd-icon-btn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:none;border-radius:7px;
  background:transparent;color:var(--nd-fg-2);cursor:pointer;font-size:16px;line-height:1;transition:background .15s,color .15s;}
.nd-icon-btn:hover{background:var(--nd-bg-3);color:var(--nd-fg);}
.nd-tabs{display:flex;gap:2px;padding:0 8px;border-bottom:1px solid var(--nd-bd-2);flex:none;background:var(--nd-bg-2);}
.nd-tab{padding:11px 16px;border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:13px;
  color:var(--nd-fg-2);border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s,border-color .15s;}
.nd-tab:hover{color:var(--nd-fg);}
.nd-tab.nd-on{color:var(--nd-fg);font-weight:600;border-bottom-color:var(--nd-accent);}
.nd-body{flex:1;overflow-y:auto;min-height:200px;overscroll-behavior:contain;}
.nd-body::-webkit-scrollbar{width:10px;}
.nd-body::-webkit-scrollbar-thumb{background:var(--nd-bd);border-radius:5px;border:3px solid transparent;background-clip:content-box;}
.nd-body::-webkit-scrollbar-thumb:hover{background:var(--nd-fg-3);background-clip:content-box;}
.nd-page{display:none;padding:14px 16px 16px;}
.nd-page.nd-on{display:block;}
#nd-scope [hidden]{display:none !important;}
.nd-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:30px;padding:0 12px;
  border:1px solid var(--nd-bd);border-radius:7px;background:var(--nd-bg-3);color:var(--nd-fg);
  font-family:inherit;font-size:12px;cursor:pointer;white-space:nowrap;
  transition:background .15s,border-color .15s,opacity .15s,transform .1s;}
.nd-btn:hover{background:var(--nd-bd);border-color:var(--nd-fg-3);}
.nd-btn:active{transform:translateY(1px);}
.nd-btn[disabled]{opacity:.45;pointer-events:none;}
.nd-btn.nd-primary{background:var(--nd-accent);border-color:var(--nd-accent);color:var(--nd-accent-fg);font-weight:500;}
.nd-btn.nd-primary:hover{background:var(--nd-accent-2);border-color:var(--nd-accent-2);}
.nd-btn.nd-ghost{background:transparent;border-color:transparent;color:var(--nd-fg-2);}
.nd-btn.nd-ghost:hover{background:var(--nd-bg-3);border-color:var(--nd-bd);color:var(--nd-fg);}
.nd-btn.nd-danger:hover{background:var(--nd-bad);border-color:var(--nd-bad);color:#fff;}
.nd-btn.nd-block{width:100%;}
.nd-actions{display:flex;flex-wrap:wrap;gap:8px;padding:2px 0 10px;}
.nd-actions:last-child{padding-bottom:0;}
.nd-bar-acts{display:flex;flex-wrap:wrap;gap:2px;margin:0 0 12px;}
.nd-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--nd-bd-2);}
.nd-row:last-child{border-bottom:none;}
.nd-row-main{flex:1;min-width:0;}
.nd-row-name{font-size:13px;color:var(--nd-fg);word-break:break-all;line-height:1.45;}
.nd-row-meta{font-size:11px;color:var(--nd-fg-3);margin-top:1px;}
.nd-row-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:none;}
.nd-card{border:1px solid var(--nd-bd);border-radius:12px;background:var(--nd-bg-2);margin:0 0 12px;overflow:hidden;}
.nd-card:last-child{margin-bottom:0;}
.nd-card-head{padding:12px 14px 10px;border-bottom:1px solid var(--nd-bd-2);}
.nd-card-head h3{margin:0;font-size:13px;font-weight:600;color:var(--nd-fg);}
.nd-card-head p{margin:5px 0 0;font-size:12px;color:var(--nd-fg-3);line-height:1.6;}
.nd-card-body{padding:10px 14px 12px;}
.nd-card-head h3 .nd-badge{display:inline-block;min-width:18px;padding:0 6px;margin-left:6px;border-radius:9px;
  background:var(--nd-bg-3);color:var(--nd-fg-2);font-size:11px;font-weight:400;line-height:17px;text-align:center;vertical-align:1px;}
.nd-empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:22px 12px;
  color:var(--nd-fg-3);font-size:12px;text-align:center;line-height:1.6;}
.nd-empty .nd-ico{width:22px;height:22px;opacity:.5;}
.nd-empty span{max-width:420px;}
.nd-field{display:flex;align-items:center;gap:10px;padding:9px 0;}
.nd-field + .nd-field{border-top:1px solid var(--nd-bd-2);}
.nd-field-label{width:76px;flex:none;font-size:12px;color:var(--nd-fg-2);text-align:right;}
.nd-field-desc{flex:1;min-width:0;font-size:12px;color:var(--nd-fg-3);}
.nd-field-hint{flex:1;min-width:0;font-size:11px;color:var(--nd-fg-3);}
.nd-stack{display:flex;flex-direction:column;gap:8px;padding:2px 0 10px;}
.nd-input{flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--nd-bd);border-radius:7px;background:var(--nd-bg);
  color:var(--nd-fg);font-family:inherit;font-size:13px;transition:border-color .15s,background .15s;}
.nd-input::placeholder{color:var(--nd-fg-3);}
.nd-input:hover{border-color:var(--nd-fg-3);}
.nd-input:focus{outline:none;border-color:var(--nd-accent);background:var(--nd-bg);}
.nd-switch{position:relative;width:40px;height:22px;flex:none;cursor:pointer;}
.nd-seg{display:flex;flex:none;border:1px solid var(--nd-bd);border-radius:7px;overflow:hidden;}
.nd-seg button{padding:5px 11px;border:none;background:transparent;color:var(--nd-fg-2);cursor:pointer;
  font-family:inherit;font-size:12px;border-right:1px solid var(--nd-bd);transition:background .15s,color .15s;}
.nd-seg button:last-child{border-right:none;}
.nd-seg button:hover{color:var(--nd-fg);}
.nd-seg button.nd-on{background:var(--nd-accent);color:var(--nd-accent-fg);}
.nd-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1;}
.nd-switch i{display:block;width:40px;height:22px;border-radius:6px;background:var(--nd-bd);transition:background .22s;position:relative;}
.nd-switch i::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:4px;background:#fff;
  transition:transform .22s cubic-bezier(.4,0,.2,1);}
.nd-switch input:checked + i{background:var(--nd-accent);}
.nd-switch input:checked + i::after{transform:translateX(18px);}
.nd-about p{margin:0 0 10px;color:var(--nd-fg-2);font-size:13px;}
.nd-about b{color:var(--nd-fg);font-weight:600;}
#nd-toasts{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483004;display:flex;
  flex-direction:column;gap:8px;align-items:center;pointer-events:none;}
.nd-toast{display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 32px));padding:9px 14px;
  border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:13px;color:#fff;
  box-shadow:0 6px 20px rgba(0,0,0,.35);opacity:0;transform:translateY(12px);transition:opacity .22s,transform .22s;}
.nd-toast.nd-show{opacity:1;transform:none;}
.nd-toast.nd-info{background:#1f6feb;}
.nd-toast.nd-ok{background:#2da44e;}
.nd-toast.nd-warn{background:#9e6a03;}
.nd-toast.nd-err{background:#b62324;}

`;

	/**
	 * 入口样式独立成表：它作用于 #nd-scope 之外，且必须随注入即时生效，
	 * 不能等面板首次打开时才随主样式一起注入。
	 */
	const ENTRY_CSS = `
/* 入口按钮：默认白色（多数网盘工具栏是浅色），可切换暗色或跟随宿主页面明暗 */
.nd-entry{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;margin:0 0 0 10px;
  border:1px solid rgba(0,0,0,.14);border-radius:6px;background:#fff;color:#1f2328;
  font-family:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;flex:none;vertical-align:middle;
  box-shadow:0 1px 2px rgba(0,0,0,.06);
  transition:background .15s,border-color .15s,box-shadow .15s,transform .1s;}
.nd-entry:hover{background:#f5f6f7;border-color:rgba(0,0,0,.24);}
.nd-entry:active{transform:translateY(1px);}
.nd-entry:focus-visible{outline:2px solid #4c8bf5;outline-offset:2px;}
.nd-entry.nd-entry-dark{background:#252b33;border-color:#3a4048;color:#e6edf3;box-shadow:0 1px 2px rgba(0,0,0,.3);}
.nd-entry.nd-entry-dark:hover{background:#2f363f;border-color:#4a525c;}
.nd-entry svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none;}
`;

	/**
	 * 面板图标。统一内联表现属性（fill/stroke/线帽），
	 * 即使样式表尚未生效也不会退化成黑色色块。
	 */
	const ICON = {
		download: '<svg class="nd-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.4v7.8"/><path d="M4.8 7.1 8 10.3l3.2-3.2"/><path d="M2.8 13.6h10.4"/></svg>',
		empty: '<svg class="nd-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 14.1a3.5 3.5 0 0 0 5 .4l2.4-2.4a3.5 3.5 0 0 0-5-5l-1.3 1.4"/><path d="M13.7 9.9a3.5 3.5 0 0 0-5-.4l-2.4 2.4a3.5 3.5 0 0 0 5 5l1.3-1.4"/></svg>'
	};

	/* ==========================================================================
	 * 13. UI 层
	 * ========================================================================== */

	const ui = {
		root: null,
		panel: null,
		overlay: null,
		toasts: null,
		state: { files: [], provider: null, page: "dl", busy: false, phase: "", error: "" },
		/** 最近一次已换链的勾选签名，避免同一批勾选反复请求网盘 */
		_resolvedSig: "",

		/* ---------- 基础 ---------- */

		ensure() {
			if (ui.root) return;

			const style = document.createElement("style");
			style.id = "nd-style";
			style.textContent = CSS;
			(document.head || document.documentElement).appendChild(style);

			const scope = document.createElement("div");
			scope.id = "nd-scope";
			if (document.documentElement.getAttribute("data-color-mode") === "light") scope.classList.add("nd-light");
			scope.innerHTML = ui.template();
			document.body.appendChild(scope);

			ui.root = scope;
			ui.panel = scope.querySelector("#nd-panel");
			ui.overlay = scope.querySelector("#nd-overlay");
			ui.toasts = scope.querySelector("#nd-toasts");
			ui.bind();
		},

		template() {
			return `
<div id="nd-overlay"></div>
<div id="nd-panel" role="dialog" aria-label="网盘直链下载助手">
  <div class="nd-head">
    <div class="nd-mark">${ICON.download}</div>
    <h2>网盘直链下载助手</h2>
    <span class="nd-ver">v${VERSION}</span>
    <span class="nd-grow"></span>
    <button class="nd-icon-btn" data-act="close" title="关闭">✕</button>
  </div>
  <div class="nd-tabs">
    <button class="nd-tab nd-on" data-tab="dl">下载</button>
    <button class="nd-tab" data-tab="cfg">设置</button>
    <button class="nd-tab" data-tab="about">关于</button>
  </div>
  <div class="nd-body">
    <div class="nd-page nd-on" data-page="dl">
      <div class="nd-card">
        <div class="nd-card-head">
          <h3>可用直链 <span class="nd-badge" data-el="caught-count">0</span></h3>
        </div>
        <div class="nd-card-body">
          <div class="nd-actions" data-el="batch-bar" hidden>
            <button class="nd-btn nd-primary" data-act="push-caught">全部推送 Aria2</button>
            <button class="nd-btn" data-act="copy-caught">复制全部</button>
            <button class="nd-btn nd-ghost" data-act="copy-all-cmds">复制命令行</button>
            <button class="nd-btn nd-ghost" data-act="clear-caught">清空</button>
          </div>
          <div data-el="caught-list"></div>
        </div>
      </div>

      <div class="nd-bar-acts">
        <button class="nd-btn nd-ghost" data-act="resolve" data-el="resolve-btn" hidden>重新获取直链</button>
      </div>
    </div>

    <div class="nd-page" data-page="cfg">
      <div class="nd-card">
        <div class="nd-card-head">
          <h3>Aria2 服务器</h3>
        </div>
        <div class="nd-card-body">
          <div class="nd-field"><span class="nd-field-label">服务器地址</span>
            <input class="nd-input" data-cfg="address" placeholder="http://localhost:6800" /></div>
          <div class="nd-field"><span class="nd-field-label">密钥</span>
            <input class="nd-input" data-cfg="token" placeholder="留空表示未设置 rpc-secret" /></div>
          <div class="nd-field"><span class="nd-field-label">保存目录</span>
            <input class="nd-input" data-cfg="dir" placeholder="留空使用 Aria2 默认目录" /></div>
          <div class="nd-field"><span class="nd-field-label">接口路径</span>
            <input class="nd-input" data-cfg="path" placeholder="/jsonrpc" /></div>
          <div class="nd-field">
            <button class="nd-btn nd-primary" data-act="test-aria">测试连接</button>
            <button class="nd-btn" data-act="save-aria">保存</button>
            <span class="nd-field-hint" data-el="aria-status"></span>
          </div>
        </div>
      </div>

      <div class="nd-card">
        <div class="nd-card-head">
          <h3>偏好设置</h3>
        </div>
        <div class="nd-card-body">
          <div class="nd-field">
            <span class="nd-field-label">入口样式</span>
            <div class="nd-seg" data-el="entry-seg">
              <button type="button" data-entry="auto">跟随主题</button>
              <button type="button" data-entry="light">白色</button>
              <button type="button" data-entry="dark">暗色</button>
            </div>
            <span class="nd-field-desc">网盘页里「下载助手」按钮的配色</span>
          </div>
          <div class="nd-field">
            <span class="nd-field-label">IDM 出口</span>
            <div class="nd-switch"><input type="checkbox" data-opt="showIdm" /><i></i></div>
            <span class="nd-field-desc">在每条直链上显示「IDM」按钮</span>
          </div>
          <div class="nd-field">
            <span class="nd-field-label">首次提示</span>
            <div class="nd-switch"><input type="checkbox" data-opt="firstTip" /><i></i></div>
            <span class="nd-field-desc">装好后提示一次入口位置</span>
          </div>
        </div>
      </div>
    </div>

    <div class="nd-page nd-about" data-page="about">
      <p><b>网盘直链下载助手 v${VERSION}</b></p>
      <p><b>用法</b>：在网盘里勾选要下载的文件，打开本面板即自动换取直链。文件夹取不到直链，请进入文件夹后再勾选。</p>
      <p><b>入口</b>：网盘工具栏上的「下载助手」按钮；若未出现，可用脚本管理器菜单中的「打开下载助手」。</p>
      <p><b>出口</b>：推送 Aria2 · 浏览器下载 · 复制直链。</p>
      <p><b>注入状态</b>：<span data-el="inject-report">—</span>
        <button class="nd-btn nd-ghost" data-act="copy-report" style="margin-left:6px">复制诊断</button></p>
    </div>
  </div>
</div>
<div id="nd-toasts"></div>`;
		},

		/* ---------- 交互绑定 ---------- */

		bind() {
			ui.overlay.addEventListener("click", ui.close);
			ui.root.addEventListener("click", ui.onClick);
			ui.root.addEventListener("change", ui.onChange);
			document.addEventListener("keydown", (e) => {
				if (e.key === "Escape" && ui.isOpen()) ui.close();
			});
		},

		onClick(e) {
			const tab = e.target.closest("[data-tab]");
			if (tab) return ui.switchTab(tab.getAttribute("data-tab"));

			const es = e.target.closest("[data-entry]");
			if (es) return ui.pickEntryStyle(es.getAttribute("data-entry"));

			const act = e.target.closest("[data-act]");
			if (!act) return;
			const name = act.getAttribute("data-act");
			const id = act.getAttribute("data-id") || act.getAttribute("data-cid");

			switch (name) {
				case "close": return ui.close();
				case "resolve": return ui.resolveLinks(act);
				case "push-caught": return ui.pushCaught();
				case "copy-caught": return ui.copyAll("link");
				case "copy-all-cmds": return ui.copyAll("cmd");
				case "clear-caught": return ui.clearCaught();
				case "caught-aria": return ui.caughtAria(id, act);
				case "caught-direct": return ui.caughtDirect(id);
				case "caught-copy": return ui.caughtCopy(id, act);
				case "caught-idm": return ui.caughtIdm(id, act);
				case "test-aria": return ui.testAria(act);
				case "save-aria": return ui.saveAria(act);
				case "copy-report": return ui.copyReport();
				default: return undefined;
			}
		},

		onChange(e) {
			const opt = e.target.getAttribute("data-opt");
			if (!opt) return;
			store.patch(KEY.opt, { [opt]: e.target.checked });
			if (opt === "showIdm") ui.renderCaught();
		},

		/* ---------- 面板开关 ---------- */

		isOpen() { return ui.panel && ui.panel.classList.contains("nd-open"); },

		open() {
			ui.ensure();
			ui.syncConfigForm();
			ui.overlay.classList.add("nd-open");
			ui.panel.classList.add("nd-open");
			ui.renderCaught();
			ui.scan();
			ui.autoResolve();
		},

		/**
		 * 打开面板即自动换链 —— 用户勾好文件、打开面板，直链就该直接在那里，
		 * 而不是再要求他点一次按钮。同一批勾选只换一次，避免反复打网盘接口。
		 */
		async autoResolve() {
			const provider = ui.state.provider;
			if (!provider || !util.isFn(provider.resolve)) return;
			const real = (ui.state.files || []).filter((f) => !f.dir);
			if (!real.length) return;
			const sig = provider.id + "|" + real.map((f) => f.fid).join(",");
			if (ui._resolvedSig === sig) return;
			ui._resolvedSig = sig;
			await ui.resolveLinks(ui.root.querySelector('[data-el="resolve-btn"]'));
		},

		/**
		 * 打开面板（所有入口统一走这里）。
		 * 包一层错误可见化：真出问题时用户看到的是提示而不是「点了没反应」。
		 */
		openSafe() {
			try {
				ui.open();
			} catch (e) {
				try { console.error("[netdisk-hub] 面板打开失败：", e); } catch (e2) { /* 忽略 */ }
				try { ui.toast("面板打开失败：" + e.message, "err", 5000); } catch (e3) { /* 忽略 */ }
			}
		},

		close() {
			if (!ui.panel) return;
			ui.panel.classList.remove("nd-open");
			ui.overlay.classList.remove("nd-open");
		},

		switchTab(page) {
			ui.state.page = page;
			ui.root.querySelectorAll(".nd-tab").forEach((t) => {
				t.classList.toggle("nd-on", t.getAttribute("data-tab") === page);
			});
			ui.root.querySelectorAll(".nd-page").forEach((p) => {
				p.classList.toggle("nd-on", p.getAttribute("data-page") === page);
			});
			if (page === "about") ui.syncReport();
		},

		/** 注入现场回显：入口没出现时，用户能在这里看到卡在哪一步 */
		syncReport() {
			const el = ui.root && ui.root.querySelector('[data-el="inject-report"]');
			if (!el) return;
			const r = inject.report || {};
			if (!r.provider) {
				el.textContent = "当前页面不在已内置的网盘范围内 —— 请用脚本管理器菜单打开面板。";
				return;
			}
			const status = r.done ? "已注入" : "未注入";
			const how = r.via || r.note || "等待中";
			el.textContent = status + "（" + how + "）；网盘 " + r.provider + " · 页面 " + (r.pageType || "未识别");
		},

		/** 复制注入诊断（含试过的选择器），便于反馈问题 */
		copyReport() {
			const r = inject.report || {};
			const lines = [
				"网盘: " + (r.provider || "-"),
				"页面: " + (r.pageType || "-"),
				"URL: " + (r.url || "-"),
				"结果: " + (r.done ? "已注入" : "未注入") + " · " + (r.via || r.note || "-"),
				"宿主: " + (r.host || "-"),
				"试过: " + ((r.tried || []).join(" | ") || "-")
			];
			const ok = outlet.copy(lines.join("\n"));
			ui.toast(ok ? "诊断信息已复制。" : "复制失败。", ok ? "ok" : "err");
		},

		/* ---------- Toast ---------- */

		toast(text, kind = "info", ms = 2600) {
			ui.ensure();
			const el = document.createElement("div");
			el.className = "nd-toast nd-" + kind;
			el.textContent = text;
			ui.toasts.appendChild(el);
			requestAnimationFrame(() => el.classList.add("nd-show"));
			setTimeout(() => {
				el.classList.remove("nd-show");
				setTimeout(() => { try { el.remove(); } catch (e) { /* 忽略 */ } }, 300);
			}, ms);
		},

		/* ---------- 可用直链 ---------- */

		/**
		 * 没有直链时的一句提示。
		 * 只说「现在该做什么」—— 勾选了几项、几个文件几个文件夹这类统计一律不展示。
		 * 换链失败的原因也写在这里（比弹窗好：一直可见，直到下一次操作）。
		 */
		noticeText() {
			if (ui.state.error) return ui.state.error;
			const provider = ui.state.provider;
			const files = ui.state.files || [];
			if (!provider) return "这里会列出可下载的直链。打开网盘文件页并勾选文件，直链会自动出现在这里。";
			if (!files.length) return `请在${provider.name}里勾选要下载的文件，直链会自动出现在这里。`;
			if (!files.filter((f) => !f.dir).length) return "勾选的都是文件夹 —— 文件夹取不到直链，请进入文件夹后再勾选其中的文件。";
			if (ui.state.phase === "resolving") return "正在获取直链…";
			return util.isFn(provider.resolve) ? "接口没有返回可用的直链，请重新勾选后再试一次。" : provider.name + " 的自动换链尚未接入（勾选识别已就绪）。";
		},

		renderCaught() {
			const count = ui.root.querySelector('[data-el="caught-count"]');
			const box = ui.root.querySelector('[data-el="caught-list"]');
			const bar = ui.root.querySelector('[data-el="batch-bar"]');
			const pool = links.pool;
			const opt = store.opt();

			if (count) count.textContent = String(pool.length);
			if (bar) bar.hidden = pool.length === 0;   // 没有条目就不显示批量按钮
			if (!box) return;

			if (!pool.length) {
				box.innerHTML = `<div class="nd-empty">${ICON.empty}<span>${util.escapeHtml(ui.noticeText())}</span></div>`;
				return;
			}

			// IDM 属可选出口，默认关闭，避免每条直链堆一排按钮
			const idmBtn = (id) =>
				(opt.showIdm ? `<button class="nd-btn nd-ghost" data-act="caught-idm" data-cid="${id}">IDM</button>` : "");

			box.innerHTML = pool.map((f) => `
<div class="nd-row">
  <div class="nd-row-main">
    <div class="nd-row-name">${util.escapeHtml(f.name)}</div>
    <div class="nd-row-meta">${f.size ? util.sizeFormat(f.size) : "大小未知"}</div>
  </div>
  <div class="nd-row-acts">
    <button class="nd-btn nd-primary" data-act="caught-aria" data-cid="${f.id}">Aria2</button>
    <button class="nd-btn" data-act="caught-direct" data-cid="${f.id}">下载</button>
    <button class="nd-btn nd-ghost" data-act="caught-copy" data-cid="${f.id}">复制</button>${idmBtn(f.id)}
  </div>
</div>`).join("");
		},


		findCaught(id) {
			const pool = links.pool;
			for (let i = 0; i < pool.length; i++) {
				if (pool[i].id === id) return pool[i];
			}
			return null;
		},

		/** 把一条候选转成引擎所需的文件结构（保留换链时带下来的请求头） */
		_caughtFile(f) {
			return { url: f.url, name: f.name, size: f.size, headers: f.headers || {} };
		},

		async pushCaught() {
			const pool = links.pool;
			const res = await engine.pushAriaBatch(pool.map(ui._caughtFile));
			// 推送结果在面板里看不到（队列在 Aria2 / Motrix 那边），所以要提示
			if (res.ok === res.total) ui.toast(`已推送 ${res.total} 条到 Aria2 队列。`, "ok");
			else ui.toast(`推送完成：成功 ${res.ok} / ${res.total}，失败请检查 Aria2 配置。`, "err", 4600);
		},

		/** 批量复制：kind = "link" | "cmd" */
		copyAll(kind) {
			const pool = links.pool;
			if (!pool.length) return;
			const text = kind === "cmd" ? engine.allCommands(pool) : engine.allLinks(pool);
			const label = kind === "cmd" ? "命令行" : "直链";
			// 剪贴板内容看不见，需要确认
			if (outlet.copy(text)) ui.toast(`已复制 ${pool.length} 条${label}。`, "ok");
			else ui.toast("复制失败，请手动选择文本复制。", "err", 4600);
		},

		clearCaught() {
			links.clear();
			ui.renderCaught();
		},

		async caughtAria(id, btn) {
			const f = ui.findCaught(id);
			if (!f) return;
			ui.busy(btn, true, "推送中…");
			try {
				const res = await engine.pushAria(ui._caughtFile(f));
				ui.busy(btn, false);
				// 队列在 Aria2 / Motrix 那边，面板里看不到，需要确认
				if (res === "success") ui.toast(`已推送到 Aria2：${f.name}`, "ok");
				else ui.toast("推送失败，请检查设置中的 Aria2 配置。", "err", 4600);
			} catch (e) {
				ui.busy(btn, false);
				ui.toast("推送失败：" + e.message, "err", 4600);
			}
		},

		caughtDirect(id) {
			const f = ui.findCaught(id);
			if (!f) return;
			outlet.direct(f.url);
		},

		caughtCopy(id, btn) {
			const f = ui.findCaught(id);
			if (!f) return;
			if (!outlet.copy(f.url)) ui.toast("复制失败。", "err", 4600);
			ui.busy(btn, true, "已复制");
			setTimeout(() => ui.busy(btn, false), 1200);
		},

		/* ---------- 下载页 ---------- */

		scan() {
			const provider = providerApi.current();
			ui.state.provider = provider;
			let files = [];
			try {
				files = engine.selected(provider);
			} catch (e) {
				files = [];
			}
			ui.state.files = files;
			ui.state.phase = "";
			ui.syncActions();
			ui.renderCaught();
		},

		/**
		 * 同步动作入口。面板只保留「可用直链」一张主卡，
		 * 所以这里只管一件事：该不该出现「重新获取直链」。
		 */
		syncActions() {
			const provider = ui.state.provider;
			const real = (ui.state.files || []).filter((f) => !f.dir).length;
			const btn = ui.root.querySelector('[data-el="resolve-btn"]');
			if (btn) btn.hidden = !(provider && util.isFn(provider.resolve) && real > 0);
		},

		/** 勾选文件 → 换取直链 → 入库候选池 */
		async resolveLinks(btn) {
			const provider = ui.state.provider;
			if (!provider) return;
			ui.state.error = "";
			ui.state.phase = "resolving";
			ui.renderCaught();
			ui.busy(btn, true, "获取中…");
			try {
				await engine.resolveSelected(provider);
				ui.state.phase = "done";
			} catch (e) {
				// 失败原因写进卡片的提示位，一直可见，不用弹窗。
				// 同时清掉已解析标记，让用户重新打开面板即可重试（31326 清 token 后尤其需要）。
				ui._resolvedSig = "";
				ui.state.error = e.message;
				ui.state.phase = "done";
			}
			ui.busy(btn, false);
			ui.syncActions();
			ui.renderCaught();
		},

		busy(btn, on, label) {
			if (!btn) return;
			if (on) {
				btn.setAttribute("data-label", btn.textContent);
				btn.setAttribute("disabled", "disabled");
				btn.textContent = label || "处理中…";
			} else {
				btn.removeAttribute("disabled");
				const old = btn.getAttribute("data-label");
				if (old) btn.textContent = old;
			}
		},

		/** 可选出口：推送到 IDM（设置里打开后才会出现在直链行上） */
		async caughtIdm(id, btn) {
			const f = ui.findCaught(id);
			if (!f) return;
			const file = ui._caughtFile(f);
			ui.busy(btn, true, "推送中…");
			try {
				const res = await idm.push({
					url: file.url,
					out: file.name,
					size: file.size,
					headers: engine.mergeHeaders(file.headers)
				});
				ui.busy(btn, false);
				ui.toast(res === "success" ? "已推送到 IDM。" : "推送 IDM 失败，请确认已安装较新版本的 IDM。", res === "success" ? "ok" : "err");
			} catch (e) {
				ui.busy(btn, false);
				ui.toast("推送 IDM 失败：" + e.message, "err");
			}
		},
		/* ---------- 设置页 ---------- */

		syncConfigForm() {
			const cfg = store.aria();
			ui.root.querySelectorAll("[data-cfg]").forEach((el) => {
				const k = el.getAttribute("data-cfg");
				if (k === "address") {
					el.value = aria.addressOf(cfg);
					return;
				}
				el.value = cfg[k] === undefined || cfg[k] === null ? "" : cfg[k];
			});
			const opt = store.opt();
			ui.root.querySelectorAll("[data-opt]").forEach((el) => {
				el.checked = !!opt[el.getAttribute("data-opt")];
			});
			ui.syncEntrySeg();
		},

		/** 入口样式的三段选择器：同步高亮 */
		syncEntrySeg() {
			const mode = store.opt().entryStyle || "auto";
			ui.root.querySelectorAll("[data-entry]").forEach((el) => {
				el.classList.toggle("nd-on", el.getAttribute("data-entry") === mode);
			});
		},

		/** 切换入口配色，并让页面上已注入的按钮立即换装 */
		pickEntryStyle(mode) {
			store.patch(KEY.opt, { entryStyle: mode });
			ui.syncEntrySeg();   // 分段按钮高亮本身就是反馈
			try {
				document.querySelectorAll(".nd-entry").forEach((el) => inject.applyEntryStyle(el));
			} catch (e) { /* 忽略 */ }
		},

		/** 读取表单。注意 address 是拼接展示用的，需拆回 domain + port 再入库 */
		readConfigForm() {
			const out = {};
			ui.root.querySelectorAll("[data-cfg]").forEach((el) => {
				const k = el.getAttribute("data-cfg");
				if (k === "address") {
					const raw = el.value.trim();
					if (raw) {
						const parts = aria.parseAddress(raw);
						out.domain = parts.domain;
						out.port = parts.port;
					}
					return;
				}
				out[k] = el.value.trim();
			});
			return out;
		},

		saveAria(btn) {
			store.patch(KEY.aria, ui.readConfigForm());
			ui.busy(btn, true, "已保存");   // 按钮文字本身就是反馈，不再弹窗
			setTimeout(() => ui.busy(btn, false), 1200);
		},

		async testAria(btn) {
			const cfg = Object.assign({}, store.aria(), ui.readConfigForm());
			const status = ui.root.querySelector('[data-el="aria-status"]');
			ui.busy(btn, true, "测试中…");
			status.textContent = "";
			try {
				const info = await engine.testAria(cfg);
				// 结果直接回显在按钮旁，不再弹窗
				status.textContent = info && info.version
					? `连接成功：Aria2 ${info.version}`
					: "连接成功但返回数据异常";
			} catch (e) {
				status.textContent = "连接失败：" + e.message;
			} finally {
				ui.busy(btn, false);
			}
		}
	};

	/* ==========================================================================
	 * 14. 启动
	 * ========================================================================== */

	function boot() {
		if (typeof document === "undefined" || typeof window === "undefined") return;
		if (document.getElementById("nd-style")) return; // 重复注入保护

		// --- 百度 OAuth 落地页（@match openapi.baidu.com 时脚本也在此运行）---
		// 授权成功后 Baidu 把 access_token 放进 location.href 的片段（#access_token=…）。
		// 片段只存在于真实标签页，XHR 的 finalUrl 会剥掉它 —— 所以**必须开真实标签页**
		// 才能可靠拿到令牌，这也是纯静默 XHR 反复 31326 的根因之一。
		if (/^https:\/\/openapi\.baidu\.com\//.test(location.href)) {
			try {
				const href = location.href;
				const AUTH_APP = "omiOnr2tYnN9vSyDErcVFWpPU2mZA7YO";
				// 1) 授权确认页：自动点「授权」按钮（与参考脚本一致）
				if (/\/oauth\/2\.0\/authorize/.test(href)
					&& href.indexOf(AUTH_APP) >= 0
					&& /response_type=token/.test(href)) {
					let tried = 0;
					const poll = setInterval(() => {
						try {
							const allow = document.getElementById("auth-allow");
							if (allow) { allow.click(); clearInterval(poll); return; }
						} catch (e) { /* 忽略 */ }
						if (++tried > 50) clearInterval(poll);
					}, 300);
				}
				// 2) 授权落地页：轮询 location.href 直到拿到 access_token 再入库。
				//    参考脚本只认 login_success 页，但 Baidu 各版本落地路径不一
				//    （login_success / oob / 带 fragment 的任意路径），因此这里放宽到
				//    「任意 openapi 页出现 access_token 即捕获」，覆盖老新版行为。
				const grab = () => {
					const m = location.href.match(/[?#&_]access_token=([^&#]+)/);
					if (!m) return false;
					store.patch(KEY.baidu, { token: decodeURIComponent(m[1]) });
					try { setTimeout(() => { try { window.close(); } catch (e) { /* 忽略 */ } }, 2000); } catch (e) { /* 忽略 */ }
					return true;
				};
				if (!grab()) {
					let cnt = 0;
					const iv = setInterval(() => {
						if (grab() || ++cnt > 120) clearInterval(iv);
					}, 500);
				}
			} catch (e) { /* 忽略 */ }
			return; // openapi 页只做授权捕获，不注入面板
		}


		// 其余工作等 DOM 就绪再跑（@run-at document-start 时 body 还不存在）
		const ready = () => {
			const menu = (typeof GM_registerMenuCommand === "function") ? GM_registerMenuCommand : null;
			if (menu) {
				try { menu("打开下载助手", ui.openSafe, "o"); } catch (e) { /* 某些管理器不支持第三参数 */ try { menu("打开下载助手", ui.openSafe); } catch (e2) { /* 忽略 */ } }
				try { menu("Aria2 设置", () => { ui.openSafe(); ui.switchTab("cfg"); }); } catch (e) { /* 忽略 */ }
			}

			// 入口点击的双保险：在捕获阶段统一接住 .nd-entry 的点击。
			// 部分网盘（如百度新版分享页）会重渲染工具栏或在容器上拦截冒泡，
			// 按钮自身的监听可能收不到事件 —— 捕获阶段先于一切，最稳。
			document.addEventListener("click", (e) => {
				const t = e.target && e.target.closest ? e.target.closest(".nd-entry") : null;
				if (!t) return;
				e.preventDefault();
				e.stopPropagation();
				ui.openSafe();
			}, true);

			// 页面注入：把入口挂进宿主工具栏（仅在识别到网盘时执行）
			const injected = inject.start();

			const opt = store.opt();
			if (opt.firstTip && store.raw(KEY.flag) !== true) {
				store.set(KEY.flag, true);
				// 延迟到页面稳定后再提示，避免与宿主首屏争抢
				setTimeout(() => {
					ui.toast(injected
						? "下载助手已就绪：网盘工具栏上的「下载助手」按钮，或脚本管理器菜单均可打开"
						: "下载助手已就绪：点击脚本管理器图标 → 菜单中的「打开下载助手」", "info", 5000);
				}, 1500);
			}
		};

		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", ready, { once: true });
		} else {
			ready();
		}
	}

	boot();

	/* ==========================================================================
	 * 15. 导出（供 Node 环境直测真实代码）
	 * ========================================================================== */

	if (typeof module !== "undefined" && module.exports) {
		module.exports = { VERSION, KEY, DEFAULTS, util, store, net, aria, idm, outlet, providers, providerApi, pageState, engine, links, inject, ui };
	}
})();
