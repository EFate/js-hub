// ==UserScript==
// @name         链接直跳助手
// @namespace    js-hub/jump-hub
// @version      1.3.1
// @description  点一次链接就直接到目标网站：跳过「安全提示 / 即将离开 / 确认跳转」这类中转页，网盘链接自动带上旁边写着的提取码直达并解锁，统一在新标签页打开。全自动、全程零提示，不用选文字、不用点第二次、不用手输提取码。
// @author       EFate
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/jump-hub/jump-hub.user.js
// @downloadURL  https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/jump-hub/jump-hub.user.js
// @match        *://*/*
// @exclude      *://localhost:*/*
// @exclude      *://127.0.0.1:*/*
// @exclude      *://0.0.0.0*
// @exclude      *://192.168.*
// @exclude      *://10.*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/**
 * 链接直跳助手 · jump-hub
 *
 * 解决的问题：点一个链接，先落到「安全提示 / 即将离开 / 确认跳转」的中转页，
 * 还得再点一次「继续访问」，到了网盘还要手工复制粘贴提取码。本脚本把这几步
 * 全消掉 —— **只做一件事：点一次，到地方。**
 *
 * 使用方式就是「什么都不用做」。没有选文字识别、没有弹窗确认、没有快捷键，
 * 也不用先复制提取码：点链接的时候脚本自己去页面上找。
 *
 * 「无感」的三条硬要求（改这个脚本前先读）：
 *   · 成功不提示 —— 人已经到地方了，结果自己会说话。提示只留给「首次安装」
 *     与「面板里的主动操作」。
 *   · 只做决定，不做开关 —— 设置项只留「用户真的会想关掉它」的，实现细节
 *     （改写还是拦截、要不要预解析）一律不做开关。同类能力合并成一个开关。
 *   · 新标签打开 —— 拦截后统一在新标签页打开，原页面留着，不打断用户原来的位置。
 *
 * 设计要点（对应架构图 architecture-diagram-svg/jump-hub-architecture.svg）：
 *
 * 1. 解析层是纯函数核心，不碰 DOM。resolveTarget() 对同一输入幂等 —— 已经
 *    是目标地址的链接再解析一次还是它自己。这条性质让「改写」与「点击拦截」
 *    可以共用同一段逻辑而不会互相打架。
 * 2. 解析优先走站点规则表（一个站一套选择器 / 属性 / 参数名）；规则没覆盖的
 *    站点走通用跳转参数表（STRONG_PARAMS / WEAK_PARAMS），所以「没适配过的
 *    站点」也能大概率免中转。
 * 3. 判定层负责「该不该跳」：同主机、同注册域一律不动（百度搜索里指向
 *    baike.baidu.com 的结果不认为是外链），只放行真正跨站的地址。
 * 4. 执行层四条出口层层兜底：优先改写 href（保留原生右键 / 中键 / 状态栏），
 *    改不到的在点击捕获阶段直接接管（不产生中转页请求），已经落在中转页的
 *    自动 replace 走人，网盘链接额外拼上提取码。
 * 5. 网盘层的提取码是**自动就地取材**：点网盘链接时从链接旁边的文本块里找
 *    （找不到才退到「整页只有一个码」），拼成 ?pwd= 再跳。落在分享页后脚本
 *    读回自己写的参数自动填码 —— 所以不依赖各家网盘认不认这个参数名。
 *    只做「带码 + 填码」，不碰下载、不碰网盘接口、不发任何网络请求。
 * 6. 入口遵守仓库 UI 规范：不悬浮、不占快捷键；能注入宿主工具栏就注入，
 *    管理器菜单永远兜底。
 * 7. 提示只出现在两处：首次安装一次（否则无法确认脚本是否生效）、面板里的
 *    主动操作反馈。脚本的所有自动行为一律零提示。
 */

(function () {
	"use strict";

	const VERSION = "1.3.1";
	const ATTR = "data-jh";
	const KEY = {
		opt: "jh.opt",
		stat: "jh.stat",
		log: "jh.log",
		flag: "jh.installed"
	};

	const HOST = (typeof location !== "undefined" && location.hostname) || "";
	const IS_TOP = (() => {
		try {
			return window.self === window.top;
		} catch (e) {
			return false;
		}
	})();

	/* ==========================================================================
	 * 1. 工具层
	 * ======================================================================== */

	const LOG_TAG = "%c[链接直跳]";

	function log(...args) {
		try {
			console.log(LOG_TAG, "color:#2da44e;font-weight:600", ...args);
		} catch (e) {
			/* 忽略 */
		}
	}

	/** 统一的脚本管理器能力封装：缺失时静默降级，便于在 Node / jsdom 里直测 */
	const gm = {
		get(key, def) {
			try {
				if (typeof GM_getValue === "function") {
					const v = GM_getValue(key, undefined);
					return v === undefined ? def : v;
				}
			} catch (e) {
				/* 落到 localStorage */
			}
			try {
				const raw = localStorage.getItem(key);
				return raw === null ? def : JSON.parse(raw);
			} catch (e) {
				return def;
			}
		},
		set(key, val) {
			try {
				if (typeof GM_setValue === "function") {
					GM_setValue(key, val);
					return;
				}
			} catch (e) {
				/* 落到 localStorage */
			}
			try {
				localStorage.setItem(key, JSON.stringify(val));
			} catch (e) {
				/* 存不下就算了 */
			}
		},
		menu(label, fn) {
			try {
				if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand(label, fn);
			} catch (e) {
				/* 忽略 */
			}
		},
		info() {
			try {
				return typeof GM_info === "object" && GM_info ? GM_info : null;
			} catch (e) {
				return null;
			}
		}
	};

	const isString = (v) => typeof v === "string";
	const isFn = (v) => typeof v === "function";

	function qsa(sel, root) {
		try {
			return Array.prototype.slice.call((root || document).querySelectorAll(sel));
		} catch (e) {
			return [];
		}
	}

	function qs(sel, root) {
		try {
			return (root || document).querySelector(sel);
		} catch (e) {
			return null;
		}
	}

	function firstOf(list, root) {
		for (const sel of list) {
			const el = qs(sel, root);
			if (el) return el;
		}
		return null;
	}

	/**
	 * 这个环境有没有布局引擎？
	 *
	 * 没有布局引擎时（jsdom 等）元素几何恒为 0，用 offsetParent 判断可见性会把
	 * 页面上所有元素都判成不可见。所以先探一次，之后走两套判据。
	 */
	let noLayout = null;

	function hasLayout() {
		if (noLayout !== null) return !noLayout;
		try {
			const probe = document.createElement("div");
			probe.style.cssText = "position:absolute;width:10px;height:10px;";
			(document.documentElement || document.body).appendChild(probe);
			const r = probe.getBoundingClientRect ? probe.getBoundingClientRect() : null;
			const laidOut = probe.offsetHeight > 0 || !!(r && (r.width > 0 || r.height > 0));
			if (probe.parentNode) probe.parentNode.removeChild(probe);
			noLayout = !laidOut;
		} catch (e) {
			noLayout = false;
		}
		return !noLayout;
	}

	function isVisible(el) {
		if (!el) return false;
		try {
			// 无布局引擎：只要还挂在文档上就算「可见」
			if (!hasLayout()) return !!(el.ownerDocument && el.ownerDocument.contains(el));
			if (el.offsetParent) return true;
			// fixed 定位元素的 offsetParent 也是 null，用 rect 兜一下
			if (isFn(el.getClientRects) && el.getClientRects().length) return true;
			return false;
		} catch (e) {
			return true;
		}
	}

	/** 等宿主容器出现再注入，不做轮询硬等 */
	function waitFor(target, cb, timeout) {
		const sels = Array.isArray(target) ? target : [target];
		const found = firstOf(sels);
		if (found) {
			cb(found);
			return;
		}
		const root = document.documentElement;
		if (!root) return;
		const ob = new MutationObserver(() => {
			const hit = firstOf(sels);
			if (hit) {
				ob.disconnect();
				cb(hit);
			}
		});
		ob.observe(root, { childList: true, subtree: true });
		setTimeout(() => ob.disconnect(), timeout || 15000);
	}

	/* ==========================================================================
	 * 2. URL 解析层（纯函数，不依赖 DOM —— 冒烟测试的主战场）
	 * ======================================================================== */

	/**
	 * 高置信跳转参数名：单个出现在链接里就认为是在搬运外链。
	 * 只收「语义就是跳转」的名字 —— 它们不会出现在 OAuth / 登录 / 回调链里。
	 */
	const STRONG_PARAMS = [
		"url", "target", "to", "goto", "jump", "link", "redirect", "redir",
		"dest", "destination", "surl", "href", "gourl", "u", "q",
		// 已知站点在 URL 里用的私有参数名
		"mu", "ext", "pcurl"
	];

	/**
	 * 低置信参数：要么语义太泛（?r= / ?s= / ?src=），要么是**接口语义而非页面跳转**。
	 *
	 * 后者尤其重要：redirect_uri / return_url / back_url 这类是 OAuth 授权参数，
	 * 把 `...oauth2/auth?redirect_uri=https://app.com/cb` 改写成 `https://app.com/cb`
	 * 会直接把登录流程打断。所以它们只在「页面本身就是跳转页」（路径像 /go /link
	 * /jump /redirect）时才采信。
	 */
	const WEAK_PARAMS = [
		"r", "s", "src", "source", "ref", "refurl", "ref_url", "next", "go", "out", "relay", "external", "uri",
		"urls", "jumpurl", "jump_url", "linkurl", "link_url", "redirect_url", "redirect_uri",
		"desturl", "dest_url", "outurl", "out_url", "tourl", "to_url", "wapurl", "weburl",
		"realurl", "real_url", "originurl", "origin_url", "backurl", "back_url",
		"returnurl", "return_url"
	];

	/** 宽松解码：多轮 percent-decode + 全角点号归一 + 去零宽字符 */
	function decodeLoose(input) {
		if (!isString(input)) return "";
		let out = input.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/[。．｡]/g, ".");
		for (let i = 0; i < 3; i++) {
			if (!/%[0-9a-fA-F]{2}/.test(out)) break;
			try {
				const next = decodeURIComponent(out);
				if (next === out) break;
				out = next;
			} catch (e) {
				// 非法转义：只解合法片段
				try {
					out = out.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => {
						try {
							return decodeURIComponent(m);
						} catch (e2) {
							return m;
						}
					});
				} catch (e3) {
					/* 放弃 */
				}
				break;
			}
		}
		return out;
	}

	function b64decode(body) {
		const s = String(body || "");
		try {
			if (typeof atob === "function") {
				const bin = atob(s);
				try {
					return decodeURIComponent(escape(bin));
				} catch (e) {
					return bin;
				}
			}
			if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("binary");
		} catch (e) {
			/* 不是合法 base64 */
		}
		return "";
	}

	/**
	 * 尝试把一段看起来像 base64 的串解成 URL。
	 * 兼容 URL-safe 变体（- _）与前端常见的 a1 前缀（Bing 的 u=a1xxxx）。
	 */
	function tryDecodeBase64(input) {
		if (!isString(input)) return "";
		let s = input.trim();
		const variants = [s];
		if (/^a1[A-Za-z0-9+/=_-]{8,}$/.test(s)) variants.push(s.slice(2));
		for (const v of variants) {
			if (!/^[A-Za-z0-9+/=_-]{12,}$/.test(v)) continue;
			let body = v.replace(/-/g, "+").replace(/_/g, "/");
			const pad = body.length % 4;
			if (pad) body += "=".repeat(4 - pad);
			const out = b64decode(body);
			if (out && /^https?:\/\//i.test(out.trim())) return out.trim();
		}
		return "";
	}

	function safeUrl(raw, base) {
		if (!isString(raw)) return null;
		const s = raw.trim();
		if (!s) return null;
		try {
			return new URL(s, base || (typeof location !== "undefined" ? location.href : undefined));
		} catch (e) {
			return null;
		}
	}

	/** 把 `//host/path`、`http:/host` 之类的残缺写法补全成合法 URL */
	function normalizeCandidate(raw) {
		let s = String(raw || "").trim();
		if (!s) return "";
		s = s.replace(/^[./]+(?=\/\/)/, "");
		if (/^\/\/[^/]/.test(s)) s = "https:" + s;
		if (/^https?:\/\/{2,}/i.test(s)) s = s.replace(/\/{3,}/g, "//");
		return s;
	}

	function isHttpUrl(s) {
		return /^https?:\/\/[^\s]+$/i.test(String(s || "").trim());
	}

	function normHost(h) {
		return String(h || "").toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
	}

	function isSameHost(a, b) {
		return !!a && !!b && normHost(a) === normHost(b);
	}

	/** 取「注册域」近似值（后两段）。baike.baidu.com 与 www.baidu.com 同域。 */
	function registrable(host) {
		const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
		if (parts.length <= 2) return parts.join(".");
		return parts.slice(-2).join(".");
	}

	function sameRegistry(a, b) {
		return !!a && !!b && registrable(a) === registrable(b);
	}

	/** 按 `&` 拆 query（保留原始值，不做 URLSearchParams 的规范化） */
	function queryPairs(search) {
		const out = [];
		const s = String(search || "").replace(/^\?/, "");
		if (!s) return out;
		for (const seg of s.split("&")) {
			if (!seg) continue;
			const i = seg.indexOf("=");
			if (i <= 0) continue;
			out.push({ k: decodeLoose(seg.slice(0, i)), v: seg.slice(i + 1) });
		}
		return out;
	}

	function pickRedirectParam(search, names) {
		const pairs = queryPairs(search);
		for (const name of names) {
			const hit = pairs.find((p) => p.k.toLowerCase() === name);
			if (hit && hit.v) return { name, value: decodeLoose(hit.v) };
		}
		return null;
	}

	/** 路径像不像「跳转中转页」 */
	const JUMP_PATH = /\/(go|goto|jump|jumpurl|link|linkfilter|linkout|redirect|redir|out|outlink|transfer|forward|sinaurl|middlepage|checkurl|safecheck|readtemplate|exit|away|track|url|r)\d{0,3}(?![a-z])/i;

	function isJumpPath(pathname) {
		return JUMP_PATH.test(String(pathname || ""));
	}

	/**
	 * URL 里直接拼着的内层地址。
	 *
	 * 只认两种形态：
	 *   - 带 key 的 `?url=<内层>`（delimiter 为 `=`）—— 仅当本页路径像跳转页时才采信；
	 *   - 不带 key 的 `/transfer?<内层>`（delimiter 为 `?` / `&`）—— 天然就是跳转页。
	 *
	 * 这个门控是必须的：`https://idp.com/login?return_url=https://app.com/cb` 这种
	 * 授权 / 登录链，一旦被当外链改写，整个流程就断了。
	 */
	function rawInnerUrl(href, allowKeyed) {
		const s = String(href || "");
		const head = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(s);
		const rest = head ? s.slice(head[0].length) : s;
		const re = allowKeyed ? /[?=&](https?%3a%2f%2f|https?:\/\/)/i : /[?&](https?%3a%2f%2f|https?:\/\/)/i;
		const m = re.exec(rest);
		if (!m) return "";
		return normToUrl(rest.slice(m.index + 1));
	}

	function normToUrl(s) {
		let out = decodeLoose(normalizeCandidate(s));
		out = out.replace(/[)\]}>，。；;、]+$/, "");
		return out;
	}

	/** 一次尝试：从 URL 里剥一层跳转壳 */
	function stepOnce(url, opts) {
		const o = opts || {};
		const weakOK = o.allowWeak !== false && isJumpPath(url.pathname);
		const names = weakOK ? STRONG_PARAMS.concat(WEAK_PARAMS) : STRONG_PARAMS;
		const candidates = [];

		// ① query 里的跳转参数（按参数名优先级顺序）
		const pairs = queryPairs(url.search);
		for (const name of names) {
			const hit = pairs.find((p) => p.k.toLowerCase() === name);
			if (hit && hit.v) candidates.push(hit.v);
		}
		// ② hash 里可能也塞了一份（#url=xxx / #/redirect?url=xxx / 纯 URL）
		const hash = String(url.hash || "").replace(/^#/, "");
		if (hash) {
			const hp = queryPairs(hash);
			for (const name of names) {
				const hit = hp.find((p) => p.k.toLowerCase() === name);
				if (hit && hit.v) candidates.push(hit.v);
			}
			if (/^https?:\/\//i.test(hash) || /^https?%3a%2f%2f/i.test(hash)) candidates.push(hash);
		}
		// ③ 无 key 的裸拼（/transfer?https://...），带 key 时只在跳转路径上采信
		const raw = rawInnerUrl(url.href, weakOK);
		if (raw) candidates.push(raw);

		for (const c of candidates) {
			const tried = [
				normToUrl(c),
				normToUrl(tryDecodeBase64(decodeLoose(c))),
				normToUrl(tryDecodeBase64(c))
			];
			for (const t of tried) {
				if (!isHttpUrl(t)) continue;
				const u = safeUrl(t);
				if (u && /^https?:$/.test(u.protocol) && u.href !== url.href) return u;
			}
		}
		return null;
	}

	/**
	 * 核心：把任意一个链接解析成「真实目标地址」。
	 * 幂等 —— 输入已经是目标地址时原样返回。最多回溯 3 层嵌套（短链套短链）。
	 */
	function resolveTarget(rawHref, baseHref, opts) {
		const first = safeUrl(rawHref, baseHref);
		if (!first || !/^https?:$/.test(first.protocol)) return isString(rawHref) ? rawHref : "";
		let cur = first;
		for (let depth = 0; depth < 3; depth++) {
			const next = stepOnce(cur, opts);
			if (!next) break;
			cur = next;
		}
		return cur.href;
	}

	/**
	 * 判定层：这个目标地址值不值得跳。
	 * 同主机 / 同注册域一律不动 —— 百度搜索结果里的 baike.baidu.com 不算外链。
	 */
	function shouldJump(fromHref, toHref, pageHref) {
		if (!isHttpUrl(toHref)) return false;
		const to = safeUrl(toHref);
		if (!to || !/^https?:$/.test(to.protocol)) return false;
		const page = safeUrl(pageHref || (typeof location !== "undefined" ? location.href : "https://example.com/"));
		const pageHost = page ? page.hostname : "";
		if (to.href === fromHref) return false;
		if (isSameHost(to.hostname, pageHost)) return false;
		if (sameRegistry(to.hostname, pageHost)) return false;
		return true;
	}

	/**
	 * 中转页评分：分数 ≥ 60 才自动跳，避免在正常页面上乱跳。
	 * 只有「参数里确实带了一个跨站地址」或者「站点规则显式声明」时才可能达线。
	 */
	function scoreInterstitial(ctx) {
		const c = ctx || {};
		let score = 0;
		if (c.ruleHit) score += 70; // 站点规则显式命中，直接达线
		if (c.target && !isSameHost(c.targetHost, c.pageHost) && !sameRegistry(c.targetHost, c.pageHost)) score += 25;
		if (c.jumpPath) score += 40;
		if (/即将(离开|跳转)|正在跳转|跳转中|安全检测|安全提示|继续访问|点击继续|外部链接|外链|不受信任|已离开|will be redirected|redirecting|redirect notice/i.test(c.text || "")) score += 35;
		if (c.hasCountdown) score += 10;
		if ((c.text || "").length > 0 && String(c.text).length < 260) score += 5;
		return score;
	}

	const INTERSTITIAL_THRESHOLD = 60;

	/* ==========================================================================
	 * 3. 站点规则层
	 *
	 * rewrite —— 页面内的跳转链接：怎么找到它、真实地址在哪、改哪些 href
	 *   selector  要处理的元素（链接本身或它的容器）
	 *   from      容器内去哪取真实地址（缺省 = 元素自身）
	 *   attr      取该属性作为真实地址
	 *   param     取 query 里的哪个参数（数组按顺序试）
	 *   sep       用分隔符切分 href 取值（如 "go?to="、"transfer?"）
	 *   pick      容器内最终要改 href 的链接（缺省 = 元素自身）
	 *   strip     需要摘掉的属性（站点用 onclick 拦截点击时）
	 *   absorb    点击时直接接管（站点自有处理器会抢走点击的场景）
	 *   custom    完全自定义：接收节点，返回真实地址字符串；返回 false 表示这条不处理
	 * jump —— 已经落在中转页时怎么走人
	 *   path      路径（字符串包含 / 正则）；不填 = 本规则命中即认为是中转页
	 *   param/sep/attr/custom 取值方式，不填 = 走通用解析
	 *   click     优先点击这个按钮（比 location.replace 更贴合站点逻辑）
	 *
	 * 匹配规则：host 对 location.hostname 做正则测试，一律写成 (^|\.)xxx\.com$ 的
	 * 宽容形式。**顺序敏感** —— 更具体的子域规则必须排在它的父域规则前面，
	 * 例如 tieba.baidu.com 要排在 baidu.com 之前。
	 * ======================================================================== */

	const S = (name, host, rules) => Object.assign({ name, host }, rules);

	const SITES = [
		/* ---- 搜索引擎 ---- */
		S("百度贴吧（安全检测页）", /^jump2?\.bdimg\.com$/, {
			jump: { path: "/safecheck/index", param: "url", click: "a.btn.btn-next[href]" }
		}),
		S("百度贴吧", /(^|\.)tieba\.baidu\.com$/, {
			jump: { path: "/mo/q/checkurl", param: "url", click: ".btns span.j_next" }
		}),
		S("百度搜索", /(^|\.)baidu\.com$/, {
			rewrite: { selector: "#content_left > [mu]", attr: "mu", pick: 'div[has-tts] a[href*="baidu.com/link?url="]' }
		}),
		S("Bing 搜索", /(^|\.)bing\.com$/, {
			rewrite: {
				selector: '#b_results a[target="_blank"][href*="www.bing.com/ck/a"][href*="&u=a1"]',
				custom: (a) => {
					const u = safeUrl(a.href);
					if (!u) return false;
					const real = normToUrl(tryDecodeBase64(u.searchParams.get("u") || ""));
					return isHttpUrl(real) ? real : false;
				}
			}
		}),
		S("Google 搜索 / 重定向页", /(^|\.)google\.(com|com?\.[a-z]{2}|co\.[a-z]{2}|[a-z]{2})$/, {
			rewrite: {
				selector: ["a[jsname][href][data-jsarwt]", "a[jsname][href][ping]", "[data-rw][data-al]"].join(","),
				custom: (a) => {
					a.setAttribute("data-jrwt", "1");
					a.removeAttribute("ping");
					a.removeAttribute("data-rw");
					const m = (a.getAttribute("href") || "").match(/\?(.*)/);
					if (!m) return false;
					const u = safeUrl(a.href);
					const real = normToUrl((u && u.searchParams.get("url")) || "");
					return isHttpUrl(real) ? real : false;
				}
			},
			jump: { path: "/url", param: "q" }
		}),
		S("360 搜索", /(^|\.)so\.com$/, {
			rewrite: { selector: 'a[href*="so.com/link?"][data-mdurl]', attr: "data-mdurl" }
		}),
		S("搜狗搜索", /(^|\.)sogou\.com$/, {
			rewrite: { selector: ".results .vrwrap", from: "[data-url]", attr: "data-url", pick: 'a[href*="/link?url="]' },
			jump: { path: "./id=" }
		}),

		/* ---- 社区 / 博客 / 内容站 ---- */
		S("知乎 / 知乎专栏", /(^|\.)zhihu\.com$/, {
			rewrite: { selector: '[href*="link.zhihu.com/?target="]', param: "target" },
			jump: { param: "target" }
		}),
		S("掘金", /(^|\.)juejin\.cn$/, {
			rewrite: { selector: '[href*="link.juejin.cn?target="]', param: "target" },
			jump: { param: "target" }
		}),
		S("CSDN", /(^|\.)csdn\.net$/, {
			rewrite: { selector: '[href*="link.csdn.net?target="]', param: "target" },
			jump: { param: "target" }
		}),
		S("GitCode", /(^|\.)gitcode\.(com|net)$/, {
			rewrite: { selector: '[href*="link.gitcode.com/?target="]', param: "target" },
			jump: { param: "target" }
		}),
		S("码云", /(^|\.)gitee\.com$/, {
			rewrite: { selector: '[href*="/link?target="]', param: "target" },
			jump: { path: "/link", param: "target" }
		}),
		S("开源中国", /(^|\.)oschina\.net$/, {
			rewrite: { selector: '[href*="oschina.net/action/GoToLink?url="]', sep: "GoToLink?url=" },
			jump: { path: "/action/GoToLink", param: "url" }
		}),
		S("博客园", /(^|\.)cnblogs\.com$/, {
			rewrite: { selector: '[href*="link.cnblogs.com/?url="]', param: "url" }
		}),
		S("简书", /(^|\.)jianshu\.com$/, {
			rewrite: { selector: '[href*="links.jianshu.com/go?to="]', sep: "go?to=" },
			jump: { path: "/go-wild", param: "url" }
		}),
		S("豆瓣", /(^|\.)douban\.com$/, {
			jump: { path: "/link2/", param: "url" }
		}),
		S("少数派", /(^|\.)sspai\.com$/, {
			rewrite: { selector: '[href*="sspai.com/link?target="]', param: "target" },
			jump: { path: "/link", param: "target" }
		}),
		S("InfoQ", /(^|\.)infoq\.cn$/, {
			jump: { path: "/link", param: "target" }
		}),
		S("51CTO 博客", /(^|\.)51cto\.com$/, {
			rewrite: { selector: '[href*="51cto.com/transfer?"]', sep: "transfer?" },
			jump: { path: "/transfer" }
		}),
		S("链滴", /(^|\.)ld246\.com$/, {
			rewrite: { selector: '[href*="/forward?goto="]', param: "goto" },
			jump: { path: "/forward", param: "goto", click: ".text a[href]" }
		}),
		S("LINUX DO", /(^|\.)linux\.do$/, {
			rewrite: { selector: 'a.external-link-icon, a[rel*="nofollow"]', absorb: true }
		}),
		S("NodeSeek", /(^|\.)nodeseek\.com$/, {
			rewrite: { selector: 'a[href^="/jump?to="]', param: "to" },
			jump: { path: "/jump", param: "to" }
		}),
		S("NGA 玩家社区", /(^|\.)(nga\.cn|ngabbs\.com)$/, {
			rewrite: {
				selector: 'a[target="_blank"][onclick*="showUrlAlert"]',
				strip: ["onclick", "onmouseover", "onmouseout"]
			}
		}),
		S("牛客网", /(^|\.)nowcoder\.com$/, {
			rewrite: {
				selector: [
					'[href*="gw-c.nowcoder.com/api/sparta/jump/link?link="]',
					'[href*="hd.nowcoder.com/link.html?target="]'
				].join(",")
			},
			jump: {}
		}),
		S("酷安", /(^|\.)coolapk\.com$/, {
			jump: { path: "/link", param: "url" }
		}),
		S("力扣", /(^|\.)leetcode\.(cn|com)$/, {
			rewrite: { selector: '[href*="/link/?target="]', param: "target" },
			jump: { path: "/link/", param: "target" }
		}),
		S("Steam 社区", /(^|\.)steamcommunity\.com$/, {
			jump: { path: "/linkfilter/", param: "u" }
		}),
		S("哔哩哔哩游戏 WIKI", /(^|\.)game\.bilibili\.com$/, {
			jump: { path: "/linkfilter/", param: "url" }
		}),
		S("ACG 盒子", /(^|\.)acgbox\.link$/, {
			rewrite: { selector: 'a[href*="/go/?url"]', param: "url" },
			jump: { path: "/go/", click: "a.loading-btn" }
		}),
		S("书签地球", /(^|\.)bookmarkearth\.cn$/, {
			rewrite: { selector: 'a[href*="/view/"][data-ext]', attr: "data-ext" },
			jump: {
				path: /^\/view\//,
				click: ".jump-target-url",
				custom: () => {
					const el = qs(".jump-target-url");
					const u = el && el.getAttribute("data-url");
					return isHttpUrl(u) ? u : false;
				}
			}
		}),
		S("花瓣网", /(^|\.)huaban\.com$/, {
			jump: { path: "/go", click: ".wrapper button.ant-btn" }
		}),
		S("爱发电", /(^|\.)afdian\.(com|net)$/, {
			rewrite: { selector: '[href*="afdian.com/link?target="]', param: "target" },
			jump: { path: "/link", param: "target" }
		}),
		S("pixiv", /(^|\.)pixiv\.net$/, {
			rewrite: { selector: '[href*="/jump.php?"]', sep: "?" },
			jump: { path: "/jump.php", sep: "?", click: "a[href]" }
		}),
		S("腾讯云开发者社区", /(^|\.)cloud\.tencent\.com$/, {
			rewrite: { selector: '[href*="/developer/tools/blog-entry?target="]', param: "target" },
			jump: { path: "/developer/tools/blog-entry", param: "target" }
		}),
		S("腾讯兔小巢", /^(txc|support)\.qq\.com$/, {
			rewrite: { selector: 'a[href*="/link-jump?jump="]', param: "jump" },
			jump: { path: "/link-jump", param: "jump" }
		}),
		S("语雀", /(^|\.)yuque\.com$/, {
			jump: { path: "/r/goto", param: "url" }
		}),
		S("金山文档", /(^|\.)kdocs\.cn$/, {
			jump: { path: "/office/link" }
		}),
		S("腾讯文档", /^docs\.qq\.com$/, {
			jump: { path: "/scenario/link.html", param: "url" }
		}),
		S("石墨文档", /(^|\.)shimo\.im$/, {
			jump: { path: "/outlink/gray", param: "url" }
		}),

		/* ---- 社交 / 海外 ---- */
		S("微博", /(^|\.)weibo\.(com|cn)$/, {
			rewrite: { selector: '[href*="weibo.cn/sinaurl?u="]', param: "u" },
			jump: { path: "/sinaurl", param: "u" }
		}),
		S("微博短链接", /(^|\.)t\.cn$/, {
			jump: {
				click: ".open-url a",
				custom: () => {
					const el = qs("#textline");
					const t = el && el.innerText ? el.innerText.trim() : "";
					return isHttpUrl(t) ? t : false;
				}
			}
		}),
		S("微信", /(^|\.)weixin110\.qq\.com$/, {
			jump: {
				path: "/cgi-bin/mmspamsupport-bin/newredirectconfirmcgi",
				click: "a.weui-btn.weui-btn_default",
				custom: () => {
					const el = qs(".weui-msg p.weui-msg__desc");
					const t = el && el.textContent ? el.textContent.trim() : "";
					return isHttpUrl(t) ? t : false;
				}
			}
		}),
		S("微信开放社区", /(^|\.)developers\.weixin\.qq\.com$/, {
			rewrite: { selector: '[href*="/community/middlepage/href?href="]', param: "href" },
			jump: { path: "/community/middlepage/href", param: "href" }
		}),
		S("QQ 邮箱", /(^|\.)mail\.qq\.com$/, {
			jump: { path: "/cgi-bin/readtemplate", param: ["gourl", "url"], click: "div.c-footer a.c-footer-a1" }
		}),
		S("PC 版 QQ", /(^|\.)c\.pc\.qq\.com$/, {
			jump: { path: /^\/[a-z]+\.html$/, param: ["pfurl", "url"] }
		}),
		S("Twitter / X", /(^|\.)(twitter|x)\.com$/, {
			rewrite: {
				selector: 'a[href*="://t.co/"]',
				custom: (a) => {
					const t = String(a.innerText || "").replace(/[\u2026…]/g, "").trim();
					return isHttpUrl(t) ? t : false;
				}
			}
		}),
		S("Facebook", /(^|\.)(facebook|fb)\.com$/, {
			rewrite: { selector: 'a[href*="l.facebook.com/l.php"]', param: "u" },
			jump: { param: "u" }
		}),
		S("Instagram", /(^|\.)instagram\.com$/, {
			rewrite: { selector: '[href*="l.instagram.com/?u="]', param: "u" },
			jump: { param: "u" }
		}),
		S("YouTube", /(^|\.)youtube\.com$/, {
			rewrite: { selector: '[href*="youtube.com/redirect?event="]', param: "q" },
			jump: { path: "/redirect", param: "q" }
		})
	];

	/* ==========================================================================
	 * 4. 网盘层
	 * ======================================================================== */

	const pans = (list) => list.map((p) => Object.assign({ pwdParam: "pwd" }, p));

	const PANS = pans([
		{
			id: "baidu", name: "百度网盘",
			host: /(^|\.)(pan|yun|eyun)\.baidu\.com$/,
			input: ["#accessCode", ".share-access-code", "input[name=pwd]", "#pwd", ".share-access-code input"],
			button: ["#submitBtn", ".share-access .g-button", "#sub", ".passwddiv-btn", ".share-access-code ~ button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "quark", name: "夸克网盘",
			host: /(^|\.)pan\.quark\.cn$/,
			input: [".ant-input", "input[type=text]", "input[type=password]"],
			button: [".ant-btn-primary", "button[type=submit]"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "uc", name: "UC 网盘",
			host: /(^|\.)(drive|fast)\.uc\.cn$/,
			input: ['input[class*="ShareReceivePC--input"]', ".input-wrap input", "input[type=text]"],
			button: ['button[class*="ShareReceivePC--submit-btn"]', ".input-wrap button", "button[type=submit]"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "aliyun", name: "阿里云盘",
			host: /(^|\.)(aliyundrive|alipan)\.com$|^alywp\.net$/,
			input: ["form .ant-input", "form input[type=text]", "input[name=pwd]"],
			button: ["form .button--fep7l", "form button[type=submit]"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "weiyun", name: "腾讯微云",
			host: /(^|\.)share\.weiyun\.com$/,
			input: [".mod-card-s input[type=password]", "input.pw-input", "input[type=password]"],
			button: [".mod-card-s .btn-main", ".pw-btn-wrap button.btn"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "lanzou", name: "蓝奏云",
			host: /(^|\.)(lanzou[a-z]?|lanzn|ilanzou)\.com$/,
			input: ["#pwd", "input[type=password]"],
			button: [".passwddiv-btn", "#sub", "button[type=submit]"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "123pan", name: "123 云盘",
			host: /(^|\.)123pan\.(com|cn)$|(^|\.)\d{6}\.(com|cn)$/,
			input: [".ca-fot input", ".appinput input", "input[type=password]", "input[type=text]"],
			button: [".ca-fot button", ".appinput button", "button[type=submit]"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "4275", name: "4275 极速云",
			host: /(^|\.)4275\.com$/,
			input: [".ca-fot input", ".appinput input", "input[type=password]", "input[type=text]"],
			button: [".ca-fot button", ".appinput button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "cmcc", name: "中国移动云盘",
			host: /(^|\.)(caiyun|yun)\.139\.com$/,
			input: [".token-form input[type=text]", "input[type=password]"],
			button: [".token-form .btn-token", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "cucc", name: "中国联通云盘",
			host: /(^|\.)(pan\.wo\.cn|panservice\.mail\.wo\.cn)$/,
			input: ["input.el-input__inner", ".van-field__control", "input[type=password]"],
			button: [".s-button", ".share-code button", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "ctcc", name: "天翼云盘",
			host: /(^|\.)cloud\.189\.cn$/,
			input: [".access-code-item #code_txt", "input.access-code-input", "input[type=password]", "input[type=text]"],
			button: [".access-code-item .visit", ".button", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "xunlei", name: "迅雷云盘",
			host: /(^|\.)pan\.xunlei\.com$/,
			input: [".pass-input-wrap .td-input__inner", "input[type=password]", "input[type=text]"],
			button: [".pass-input-wrap .td-button", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "115", name: "115 网盘",
			host: /(^|\.)115(cdn)?\.com$/,
			input: [".form-decode input", "input[type=password]", "input[type=text]"],
			button: [".form-decode .submit a", ".form-decode button", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "360ai", name: "360 云盘",
			host: /(^|\.)yunpan\.(com|360\.cn)$/,
			input: [".pwd-input", "input[type=password]"],
			button: [".submit-btn", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "cowtransfer", name: "奶牛快传",
			host: /(^|\.)cowtransfer\.com$/,
			input: [".receive-code-input input", "input[type=text]"],
			button: [".open-button", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "ctfile", name: "城通网盘",
			host: /(^|\.)(ctfile|545c|062)\.(com|net)$/,
			input: ["#passcode", "input[type=text]", "input[type=password]"],
			button: [".card-body button", "button[type=submit]"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "wenshushu", name: "文叔叔",
			host: /(^|\.)(wenshushu|wss)\.cn$/,
			input: [".pwd-inp .ivu-input", "input[type=password]", "input[type=text]"],
			button: [".pwd-inp .ivu-btn", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "vdisk", name: "微盘",
			host: /(^|\.)vdisk\.weibo\.com$/,
			input: ["#keypass", "#access_code", "input[type=password]", "input[type=text]"],
			button: [".search_btn_wrap a", "#linkcommon_btn", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "jianguoyun", name: "坚果云",
			host: /(^|\.)jianguoyun\.com$/,
			input: ["input[type=password]", ".share-form input"],
			button: [".ok-button", ".confirm-button", "button"],
			hint: /提取码|访问码|密码/
		},
		{
			id: "mega", name: "MEGA",
			host: /(^|\.)mega\.(nz|co\.nz)$/,
			input: [".dlkey-dialog input", "input[type=password]"],
			button: [".dlkey-dialog button", "button"],
			hint: /key|password|密码/
		},
		{
			id: "flowus", name: "FlowUs 息流",
			host: /(^|\.)flowus\.cn$/,
			input: ["input[type=password]", "input[type=text]"],
			button: ["button"],
			hint: /提取码|访问码|密码/
		}
	]);

	/** 按域名找网盘（先精确后宽松，长域名优先） */
	function panOf(host) {
		const h = normHost(host);
		if (!h) return null;
		return PANS.find((p) => p.host.test(h)) || null;
	}

	/** 从 URL 里取提取码。只认本脚本自己写的 pwd 与明确的密码类参数 */
	const PWD_PARAM_NAMES = ["pwd", "pwd_code", "password", "passwd", "extract", "extract_code", "access_code", "accesscode"];

	function readPwdFromUrl(href) {
		const u = safeUrl(href || (typeof location !== "undefined" ? location.href : ""));
		if (!u) return "";
		for (const k of PWD_PARAM_NAMES) {
			const v = u.searchParams.get(k);
			if (v && /^[A-Za-z0-9]{3,8}$/.test(v)) return v;
		}
		const h = String(u.hash || "").replace(/^#/, "");
		if (/^[A-Za-z0-9]{3,8}$/.test(h)) return h;
		const m = /^(?:pwd|password|passwd|extract)=([A-Za-z0-9]{3,8})$/i.exec(h);
		return m ? m[1] : "";
	}

	/**
	 * 提取码标签。分两类，因为两类语言的歧义程度完全不同：
	 *
	 * - **中文标签**（提取码 / 访问码 / 密码…）中文语境里这几个词专指提取码，
	 *   允许不带分隔符（「访问码 7w3q」就是这么写的）。
	 * - **拉丁标签**（password / pwd / passcode）在英文正文里随处可见，
	 *   必须带 `:` 或 `=` 才认 —— 否则 "password below" 会被当成密码 below。
	 *
	 * 有意不收 `key`：它的误报率远高于收益（MEGA 的密钥本来也不是 3~8 位）。
	 */
	const PWD_PATTERNS = [
		/(?:提取码|提取碼|访问码|訪問碼|访问密码|訪問密碼|密码|密碼|解压码|解壓碼|提货码|口令)\s*[:：=]?\s*([A-Za-z0-9]{3,8})/,
		/(?:passcode|password|passwd|pwd)\s*[:：=]\s*([A-Za-z0-9]{3,8})/i,
		/(?:^|[^A-Za-z0-9])(?:pwd|password)\s*=\s*([A-Za-z0-9]{3,8})/i
	];

	function parsePwd(text) {
		const s = String(text || "").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/[：:]\s*$/, "");
		if (!s) return "";
		for (const re of PWD_PATTERNS) {
			const m = re.exec(s);
			if (m && m[1]) return m[1];
		}
		return "";
	}

	/** 一段文本里出现的所有提取码（去重、保序），用于「整页只有一个码」这种高置信判断 */
	function parsePwdAll(text) {
		const s = String(text || "").replace(/[\u200b-\u200d\ufeff]/g, "");
		if (!s) return [];
		const out = [];
		for (const re of PWD_PATTERNS) {
			const g = new RegExp(re.source, re.flags.indexOf("g") < 0 ? re.flags + "g" : re.flags);
			let m;
			while ((m = g.exec(s))) {
				if (m[1] && out.indexOf(m[1]) < 0) out.push(m[1]);
			}
		}
		return out;
	}

	/** 给链接带上提取码。只加 query 参数，不动 hash —— 部分网盘用 hash 做路由 */
	function withPwd(link, pwd) {
		const u = safeUrl(link);
		if (!u || !pwd) return link;
		u.searchParams.set("pwd", pwd);
		return u.href;
	}

	function textOfNode(el) {
		try {
			return String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
		} catch (e) {
			return "";
		}
	}

	/** 整页提取码集合（缓存；DOM 变动时由扫描器失效，避免每次点击都重扫全文） */
	let pagePwdCache = null;

	function pagePwds() {
		if (pagePwdCache) return pagePwdCache;
		pagePwdCache = parsePwdAll(textOfNode(document.body || document.documentElement));
		return pagePwdCache;
	}

	function invalidatePagePwd() {
		pagePwdCache = null;
	}

	/**
	 * 找某个链接旁边的提取码。
	 *
	 * ① **就近**：从链接往上最多 4 层，取一个文本量合适的块来解析 —— 一个帖子里
	 *    多个网盘链接各带各的码时，靠这条分清谁是谁。
	 * ② **整页唯一**：全页只有一个码时直接采信。
	 *
	 * 页面里有多个**不同**的码、而就近又找不到时**不做猜测** —— 猜错比不填更糟。
	 * 先用整页缓存做闸门：页面上压根没有码的（绝大多数页面）直接返回，
	 * 不必为每个链接白跑一遍祖先链。
	 *
	 * **归属判定（关键）**：往上爬时一旦容器里出现了**别的网盘分享链接**，
	 * 就必须立刻停下 —— 说明已经越过了「这条链接自己的块」，进到了多条链接
	 * 共用的段落 / 卡片列表。此时再解析出来的码属于别人，拼上去就是张冠李戴
	 * （实测：一个帖子并列三条链接、只有第二条带码，另两条被错加上它的码）。
	 */
	function findNearbyPwd(anchor) {
		const page = pagePwds();
		if (!page.length) return null;

		let el = anchor;
		for (let i = 0; i < 4 && el && el.tagName !== "BODY"; i++) {
			if (i > 0 && hasSiblingPanLink(el, anchor)) break; // 进入了公共容器，停止
			const txt = textOfNode(el);
			if (txt && txt.length <= 900) {
				const code = parsePwd(txt);
				if (code) return { code, from: "near" };
				if (txt.length > 420) break; // 容器已经太大，再往上只会捞到别人的码
			}
			el = el.parentElement;
		}
		return page.length === 1 ? { code: page[0], from: "page" } : null;
	}

	/**
	 * 这个容器里除了 `self` 之外还有别的网盘分享链接吗？
	 *
	 * 有 → 它是「多条链接的公共祖先」，里面的码不专属某一条，不能采信。
	 * 只认网盘链接（不是所有外链）—— 卡片里放一个「官方教程」链接不该影响判断。
	 */
	function hasSiblingPanLink(container, self) {
		let list;
		try {
			list = container.querySelectorAll("a[href]");
		} catch (e) {
			return false;
		}
		for (const a of list) {
			if (a === self) continue;
			if (isPanShare(a, a.href)) return true;
		}
		return false;
	}

	/**
	 * 网盘链接的「点击直达」。
	 *
	 * 指向网盘分享页、URL 里还没带码，而页面上（就链接旁边）能找到提取码 ——
	 * 就把码拼上去，一次点击直达，不用再手动复制粘贴。
	 *
	 * 已经带码的返回 null：地址本来就是最终地址，不需要改写。
	 * （「有没有被处理过」由 resolveLink 的 `isPanShare` 分支落标记负责，
	 *   别把这两件事混在一起 —— 混在一起会让已带码的链接拿不到标记。）
	 */
	function netdiskTarget(anchor, targetUrl) {
		if (!opt.on || !opt.panAuto) return null;
		const u = safeUrl(targetUrl || (anchor && anchor.href));
		if (!u || !/^https?:$/.test(u.protocol)) return null;
		const pan = panOf(u.hostname);
		if (!pan) return null;
		if (u.pathname === "/" || u.pathname === "") return null; // 网盘首页不值得加参数
		if (readPwdFromUrl(u.href)) return null; // 已经带码
		const hit = findNearbyPwd(anchor);
		if (!hit) return null;
		return { to: withPwd(u.href, hit.code), code: hit.code, pan, from: hit.from };
	}

	/* ==========================================================================
	 * 5. 设置 / 统计 / 日志
	 * ======================================================================== */

	/**
	 * 设置项。
	 *
	 * 设计原则：**只留「用户真的会想关掉它」的开关**。
	 *
	 * 实现细节一律不做开关 —— 「改写 href 还是拦截点击」「要不要空闲预解析」
	 * 是脚本内部的事，用户只要「点一下就到」这个结果，多一个开关只是多一份困惑。
	 *
	 * 同类能力合并成一个开关，因为它们是同一次意图：
	 *   - guard   = 点击接管 + window.open 接管（都是「别让站点抢走这次点击」）
	 *   - panAuto = 带码 + 填码 + 提交（是「提取码这件事」的三个步骤）
	 */
	const DEFAULT_OPT = {
		on: true,        // 总开关：唯一的逃生闸
		newTab: true,    // 拦截后在新标签页打开（原页面留着）
		autoJump: true,  // 已落在中转页时自动跳走
		guard: true,     // 压掉站点拦截：点击接管 + window.open 接管
		panAuto: true,   // 网盘自动带提取码：链接旁取码 + 落地填入 + 自动提交
		entry: "auto",   // 页面入口按钮：auto / light / dark / off（off = 永不注入）
		skipHosts: [],   // 不处理的站点（命中则本页直接跳过）
		mute: []         // 被单独停用的站点规则名
	};

	/** v1.2.0 之前的旧键：读一次做迁移，然后丢弃 */
	const LEGACY_OPT_KEYS = ["rewrite", "deepScan", "takeover", "openHook", "panCode", "panFill", "panSubmit", "toast"];

	let opt = Object.assign({}, DEFAULT_OPT);

	const stat = { skip: 0, resolve: 0, fill: 0 };
	let eventLog = [];

	/**
	 * **本页**被处理过的链接数（仅当前页面，不落盘）。
	 *
	 * 与 `stat.resolve` 的区别：那个是全局累计（存 GM 存储，跨页面跨会话），
	 * 拿它判断「本页有没有干活」会恒为真。入口注入要靠这个按页计数。
	 */
	let pageHits = 0;

	/** 把 v1.1.x 的 10 个开关映射到 v1.2.0 的 5 个 */
	function migrateOpt(saved) {
		const out = Object.assign({}, DEFAULT_OPT, saved);
		if (saved.takeover === false || saved.openHook === false) out.guard = false;
		if (saved.panCode === false || saved.panFill === false) out.panAuto = false;
		for (const k of LEGACY_OPT_KEYS) delete out[k];
		return out;
	}

	function loadStore() {
		try {
			const saved = gm.get(KEY.opt, null);
			if (saved && typeof saved === "object") opt = migrateOpt(saved);
			if (!Array.isArray(opt.mute)) opt.mute = [];
			if (!Array.isArray(opt.skipHosts)) opt.skipHosts = [];
		} catch (e) {
			opt = Object.assign({}, DEFAULT_OPT);
		}
		try {
			const s = gm.get(KEY.stat, null);
			if (s && typeof s === "object") {
				stat.skip = +s.skip || 0;
				stat.resolve = +s.resolve || 0;
				stat.fill = +s.fill || 0;
			}
		} catch (e) {
			/* 用默认值 */
		}
		try {
			const l = gm.get(KEY.log, null);
			if (Array.isArray(l)) eventLog = l.slice(0, 20);
		} catch (e) {
			eventLog = [];
		}
	}

	function saveOpt() {
		gm.set(KEY.opt, opt);
	}

	function saveStat() {
		gm.set(KEY.stat, { skip: stat.skip, resolve: stat.resolve, fill: stat.fill });
	}

	function pushEvent(kind, from, to) {
		eventLog.unshift({ t: Date.now(), k: kind, from: String(from || "").slice(0, 300), to: String(to || "").slice(0, 300) });
		if (eventLog.length > 20) eventLog.length = 20;
		gm.set(KEY.log, eventLog);
	}

	function bump(kind) {
		if (kind === "skip") stat.skip++;
		else if (kind === "resolve") stat.resolve++;
		else if (kind === "fill") stat.fill++;
		saveStat();
	}

	/** 当前页面命中的站点规则（含停用过滤） */
	function currentRule() {
		if (!HOST) return null;
		const hit = SITES.find((s) => s.host.test(HOST));
		if (!hit) return null;
		if (opt.mute.indexOf(hit.name) >= 0) return null;
		return hit;
	}

	function isSkippedSite() {
		if (!HOST || !opt.skipHosts.length) return false;
		return opt.skipHosts.some((h) => {
			const s = String(h || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
			if (!s) return false;
			return HOST === s || HOST.endsWith("." + s) || normHost(HOST) === normHost(s);
		});
	}

	/* ==========================================================================
	 * 6. 执行层
	 * ======================================================================== */

	const win = (() => {
		try {
			if (typeof unsafeWindow !== "undefined" && unsafeWindow) return unsafeWindow;
		} catch (e) {
			/* 没有 unsafeWindow 就用沙箱 window */
		}
		try {
			return window;
		} catch (e) {
			// Node 里没有 window：给个空壳，方便 require 直测纯函数
			return {};
		}
	})();

	const rawOpen = win.open && win.open.bind(win);

	/** 从一个链接元素解析出真实目标。返回 null 表示「不是跳转链接」 */
	function resolveAnchor(a) {
		if (!a || a.tagName !== "A") return null;
		const href = a.href;
		if (!href || !/^https?:/i.test(href)) return null;
		const rule = currentRule();
		const rw = rule && rule.rewrite;

		// 已由站点规则自定义解析过
		if (a.getAttribute(ATTR + "-to")) {
			const marked = a.getAttribute(ATTR + "-to");
			if (isHttpUrl(marked) && marked !== href) return { to: marked, rule, why: "marked" };
		}

		// 站点规则：显式 absorb（站点自己的处理器会抢走点击）
		if (rw && rw.absorb) {
			try {
				if (a.matches(rw.selector)) return { to: resolveTarget(href, location.href) || href, rule, why: "absorb" };
			} catch (e) {
				/* 选择器不合法就跳过 */
			}
		}

		const to = resolveTarget(href, location.href);
		if (!to || to === href) return null;
		if (!shouldJump(href, to, location.href)) return null;
		return { to, rule, why: "resolve" };
	}

	/** 单条 rewrite 规则 → 真实地址 */
	function applyRewrite(rule, node) {
		const rw = rule.rewrite;
		let real = "";

		if (isFn(rw.custom)) {
			const r = rw.custom(node);
			if (isString(r) && isHttpUrl(r)) real = r;
			else if (r === false) return false;
		}

		if (!real && rw.attr) {
			const fromEl = rw.from ? qs(rw.from, node) : node;
			const v = fromEl && fromEl.getAttribute ? fromEl.getAttribute(rw.attr) : "";
			if (isString(v) && v) real = normToUrl(v);
		}

		if (!real && rw.sep) {
			const href = node.href || "";
			if (href.indexOf(rw.sep) >= 0) real = normToUrl(href.split(rw.sep)[1] || "");
		}

		if (!real) {
			const href = node.href || "";
			const u = safeUrl(href);
			const names = rw.param ? [].concat(rw.param) : STRONG_PARAMS;
			if (u) {
				const hit = pickRedirectParam(u.search, names);
				if (hit) real = normToUrl(hit.value);
			}
			if (!real) real = resolveTarget(href, location.href);
		}

		if (!isHttpUrl(real)) return false;

		// 该改哪个链接：容器规则改容器内的链接，否则改元素自身
		const targets = rw.pick ? qsa(rw.pick, node) : (node.tagName === "A" ? [node] : []);
		if (!targets.length) return false;

		let changed = false;
		for (const a of targets) {
			if (!a.tagName || a.tagName !== "A") continue;
			if (!shouldJump(a.href || "", real, location.href)) continue;
			if (rw.strip) rw.strip.forEach((attr) => a.removeAttribute(attr));
			const already = a.getAttribute(ATTR + "-to");
			if (already === real) continue;
			a.setAttribute(ATTR, "1");
			a.setAttribute(ATTR + "-to", real);
			a.href = real;
			changed = true;
		}
		return changed;
	}

	/** 扫描并改写页面里的跳转链接 */
	function scan(root) {
		if (!opt.on) return 0;
		const rule = currentRule();
		if (!rule || !rule.rewrite) return 0;
		let n = 0;
		for (const node of qsa(rule.rewrite.selector, root || document)) {
			try {
				if (applyRewrite(rule, node)) n++;
			} catch (e) {
				/* 单条失败不影响其它 */
			}
		}
		return n;
	}

	/**
	 * 处理**一条**链接：能解析成跨站目标就落标记 + 改写 href。
	 *
	 * 这是「通用识别」的单一入口 —— 与站点规则无关，任何站点都走这条。
	 * deepScan（首屏全量）与 scanRoot（异步增量）共用它。
	 *
	 * 三类结果：
	 *   ① 解析出跨站目标 → 改写（免中转）
	 *   ② 本身就是网盘分享页且旁边有码 → 带码改写
	 *   ③ 都不成立 → 不动（宁可不动，不可错动）
	 */
	function resolveLink(a) {
		if (!a || a.tagName !== "A") return false;
		if (a.getAttribute(ATTR + "-to")) return false;
		const href = a.href || "";
		if (!/^https?:/i.test(href)) return false;

		let to = "";
		if (href.length >= 24 && href.indexOf("=") >= 0) {
			const real = resolveTarget(href, location.href);
			if (real && real !== href && shouldJump(href, real, location.href)) to = real;
		}
		if (!to && opt.panAuto) {
			const nd = netdiskTarget(a, href);
			if (nd) to = nd.to;
		}
		// 已经是网盘分享页（无需换链、无需补码）也要落标记 ——
		// 否则点击层无法判断「这条已经处理过」，站点处理器就有机会把它拉回中转页。
		if (!to && isPanShare(a, href)) to = href;
		if (!to) return false;
		if (to === a.getAttribute(ATTR + "-to")) return false;

		a.setAttribute(ATTR, "1");
		a.setAttribute(ATTR + "-to", to);
		a.href = to;
		// 只把「地址真的变了」计入本页可见工作量：单纯落标记的网盘直链
		// 用户看不出任何差别，不值得据此让入口按钮露脸
		if (to !== href) pageHits++;
		return true;
	}

	/** 这个链接是不是「网盘分享页」（用于落标记，不改内容） */
	function isPanShare(a, href) {
		const u = safeUrl(href);
		if (!u || !/^https?:$/.test(u.protocol)) return false;
		if (u.pathname === "/" || u.pathname === "") return false;
		return !!panOf(u.hostname);
	}

	/**
	 * 深度预扫描：给页面里所有 a[href] 做一次解析。
	 * 目的不只是「好看」—— 中键新标签、右键「在新标签页打开」都绕开 click，
	 * 只有把 href 改对了这些路径才同样免中转。
	 *
	 * 闸门：整页没有提取码时（绝大多数页面），网盘补码那一段整段跳过。
	 */
	function deepScan() {
		if (!opt.on) return;
		let list;
		try {
			list = Array.prototype.slice.call(document.links || []);
		} catch (e) {
			return;
		}
		if (list.length > 2000) list = list.slice(0, 2000);
		let i = 0;
		let n = 0;
		const step = () => {
			const end = Math.min(i + 60, list.length);
			for (; i < end; i++) {
				try {
					if (resolveLink(list[i])) n++;
				} catch (e) {
					/* 跳过坏链接 */
				}
			}
			if (i < list.length) schedule(step);
			else {
				if (n) {
					bump("resolve");
					log(`深度预解析完成，共改写 ${n} 条链接`);
				}
				// 扫完一轮才知道本页有没有活干，再决定要不要露脸
				maybeInjectEntry();
			}
		};
		schedule(step);
	}

	/**
	 * 让出一帧再跑，避免长列表阻塞首屏。
	 *
	 * 执行前校验文档没被换掉 —— 延迟回调是异步的，跑起来时页面可能已经
	 * 不是当初那个了（重导航、或宿主替换了 document）。此时再按老上下文
	 * 去操作新文档，就会改错别人的链接。
	 */
	function schedule(fn) {
		const doc = document;
		const run = () => {
			if (document !== doc) return; // 环境已失效，这次调度作废
			fn();
		};
		try {
			if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 500 });
			else setTimeout(run, 32);
		} catch (e) {
			setTimeout(run, 32);
		}
	}

	/* ---- 点击接管 ---- */

	function anchorFromEvent(e) {
		try {
			if (isFn(e.composedPath)) {
				for (const n of e.composedPath()) {
					if (n && n.tagName === "A" && n.href) return n;
				}
			}
		} catch (err) {
			/* 落到下面的父链查找 */
		}
		let el = e.target;
		while (el && el.tagName !== "A") el = el.parentElement;
		return el && el.tagName === "A" ? el : null;
	}

	/**
	 * 新标签打开。
	 *
	 * 优先 window.open；它被拦或返回 null 时，退到「合成一个 <a target=_blank>
	 * 再点它」—— 真实链接点击不会被弹窗拦截器挡掉，而且能带上 rel=noopener
	 * 不给目标页 opener 权限。合成的链接打标记让点击守卫放行，免得自己拦截自己。
	 */
	function openInNewTab(to) {
		try {
			const a = document.createElement("a");
			a.href = to;
			a.target = "_blank";
			a.rel = "noopener";
			a.setAttribute(ATTR + "-bypass", "1");
			a.style.display = "none";
			(document.body || document.documentElement).appendChild(a);
			a.click();
			if (a.parentNode) a.parentNode.removeChild(a);
			return true;
		} catch (e) {
			return false;
		}
	}

	function navigate(to, newTab) {
		if (newTab) {
			try {
				const w = rawOpen ? rawOpen(to, "_blank") : win.open(to, "_blank");
				if (w) return;
			} catch (e) {
				/* 落到合成链接 */
			}
			if (openInNewTab(to)) return;
		}
		try {
			location.assign(to);
		} catch (e) {
			win.location.href = to;
		}
	}

	/** 记一次「免中转」—— 只计数与留痕，不弹提示（结果看得见，提示是噪音） */
	function noteSkip(to, why) {
		bump("skip");
		pushEvent("skip", location.href, to);
		if (why) log("免中转跳转 →", to, why);
	}

	function hostOf(u) {
		const x = safeUrl(u);
		return x ? x.hostname : String(u).slice(0, 40);
	}

	function onClick(e) {
		if (!opt.on) return;
		if (typeof e.button === "number" && e.button !== 0) return;
		const a = anchorFromEvent(e);
		if (!a) return;
		if (a.getAttribute(ATTR + "-bypass") === "1") return; // 我们自己合成的导航链接

		// 注意：这里**不**因 e.defaultPrevented 提前返回。
		// React / Vue 这类框架会在自己的根容器上先跑一遍处理器（可能已经
		// preventDefault 掉），但那往往正是「站点在拦这次点击」的表现 ——
		// 我们要接管它，而不是让出去。真正的「自己人」由 bypass 标记挡掉。
		const hit = resolveAnchor(a);
		let to = hit ? hit.to : "";
		let why = hit ? hit.why : "";

		if (!to && opt.guard && a.getAttribute(ATTR) === "1") {
			// href 已经被我们处理过，但站点自己的 click 处理器可能再把它拉回中转页。
			// 接管掉，让这一次点击只做「去目标站」这一件事。
			const marked = a.getAttribute(ATTR + "-to");
			to = isHttpUrl(marked) ? marked : a.href;
			why = "takeover";
		}

		// 网盘分享页：把页面上（就链接旁边）的提取码拼上，让这一次点击直接到内容
		if (opt.panAuto) {
			if (!to && !netdiskCandidate(a)) return;
			const nd = netdiskTarget(a, to || a.href);
			if (nd) to = nd.to;
		}
		if (!to) return;

		const newTab = opt.newTab || e.ctrlKey || e.metaKey || e.shiftKey || (a.target && a.target !== "_self");

		e.preventDefault();
		e.stopPropagation();

		// 只要**终点**是带码的网盘链接，就按「已带提取码」记 —— 不管码是点击时现拼的
		// 还是预解析先拼好的，用户感知到的都是「点一下就到、码已经在了」。
		const u = safeUrl(to);
		const pan = opt.panAuto && u && panOf(u.hostname);
		const code = pan && readPwdFromUrl(u.href);
		if (pan && code) {
			bump("fill");
			pushEvent("fill", pan.name, code);
		} else {
			noteSkip(to, why);
		}
		// 成功一律不提示：人已经到地方了，结果自己会说话
		navigate(to, newTab);
	}

	/** 便宜的预筛：这个链接有没有可能是网盘分享页？（避免为一个普通链接去跑 ancestry 遍历） */
	function netdiskCandidate(a) {
		const href = a && a.href;
		if (!href) return false;
		const u = safeUrl(href);
		if (!u || !/^https?:$/.test(u.protocol)) return false;
		if (u.pathname === "/" || u.pathname === "") return false;
		return !!panOf(u.hostname);
	}

	/** window.open：站点用脚本开中转页时同样直接换掉 */
	function hookOpen() {
		if (!opt.on || !opt.guard || !win || !isFn(win.open)) return;
		if (win.__jhOpenHooked) return;
		const original = win.open;
		const wrapped = function (url, target, features) {
			try {
				if (opt.on && isString(url)) {
					const to = resolveTarget(url, location.href);
					if (to && to !== url && shouldJump(url, to, location.href)) {
						log("window.open 免中转 →", to);
						return original.call(this, to, target, features);
					}
				}
			} catch (e) {
				/* 出错就走原路 */
			}
			return original.call(this, url, target, features);
		};
		try {
			Object.defineProperty(wrapped, "name", { value: "open" });
			Object.defineProperty(wrapped, "toString", { value: () => original.toString() });
		} catch (e) {
			/* 部分环境不允许改，忽略 */
		}
		try {
			win.open = wrapped;
			win.__jhOpenHooked = true;
		} catch (e) {
			/* 改不动就算了，点击接管仍然生效 */
		}
	}

	/* ---- 落地中转页自动跳 ---- */

	function pageText() {
		try {
			const body = document.body;
			if (!body) return "";
			return String(body.innerText || body.textContent || "").slice(0, 1200);
		} catch (e) {
			return "";
		}
	}

	function tryAutoJump() {
		if (!opt.on || !opt.autoJump) return;
		const here = location.href;
		const rule = currentRule();

		// ① 站点规则显式声明是中转页
		if (rule && rule.jump) {
			const j = rule.jump;
			let matched = false;
			if (j.path) matched = j.path instanceof RegExp ? j.path.test(location.pathname) : location.pathname.indexOf(j.path) >= 0;
			else matched = true;
			if (matched) {
				let target = "";
				if (isFn(j.custom)) {
					const r = j.custom();
					if (isString(r) && isHttpUrl(r)) target = r;
				}
				if (!target && j.attr) {
					const el = j.from ? qs(j.from) : document.body;
					const v = el && el.getAttribute ? el.getAttribute(j.attr) : "";
					if (isHttpUrl(v)) target = normToUrl(v);
				}
				if (!target && j.sep) {
					const part = here.split(j.sep)[1];
					if (part) target = normToUrl(part);
				}
				if (!target && j.param) {
					const u = safeUrl(here);
					const hit = u && pickRedirectParam(u.search, [].concat(j.param));
					if (hit) target = normToUrl(hit.value);
				}
				if (!target) target = resolveTarget(here, here);

				if (target && isHttpUrl(target) && target !== here && !isSameHost(hostOf(target), HOST)) {
					// 有明确按钮就先点按钮（贴合站点自己的跳转逻辑），否则直接 replace
					if (j.click) {
						const btn = qs(j.click);
						if (btn) {
							noteSkip(target, "规则点击");
							try {
								btn.click();
							} catch (e) {
								navigate(target, false);
							}
							return;
						}
					}
					noteSkip(target, "规则自跳");
					navigate(target, false);
					return;
				}
			}
		}

		// ② 通用评分：路径像中转页 + 参数里带跨站地址 + 页面上写着「即将跳转」
		const text = pageText();
		const target = resolveTarget(here, here);
		const u = safeUrl(here);
		const score = scoreInterstitial({
			ruleHit: false,
			target: target && target !== here ? target : "",
			targetHost: target && target !== here ? hostOf(target) : "",
			pageHost: HOST,
			jumpPath: !!u && isJumpPath(u.pathname),
			text,
			hasCountdown: /\b\d+\s*(?:秒|s)\s*(?:后|之后)?\s*(?:自动)?(?:跳转|离开)/i.test(text) || /setTimeout|countdown/i.test(text.slice(0, 200))
		});
		if (score >= INTERSTITIAL_THRESHOLD && target && target !== here && !isSameHost(hostOf(target), HOST) && !sameRegistry(hostOf(target), HOST)) {
			noteSkip(target, "评分 " + score);
			navigate(target, false);
		}
	}

	/* ==========================================================================
	 * 7. 网盘：分享页自动填码
	 * ======================================================================== */

	function setNativeValue(el, val) {
		const prev = el.value;
		try {
			el.focus();
		} catch (e) {
			/* 忽略 */
		}
		el.value = val;
		try {
			const tracker = el._valueTracker;
			if (tracker && isFn(tracker.setValue)) tracker.setValue(prev);
		} catch (e) {
			/* 忽略 */
		}
		try {
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
			el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
		} catch (e) {
			/* 忽略 */
		}
	}

	const isInput = (el) => !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName || "");

	/** 逐个选择器试，避免一条写错的选择器把整个列表带崩 */
	function firstMatching(selectors, accept) {
		for (const sel of selectors) {
			for (const el of qsa(sel)) {
				if (accept(el)) return el;
			}
		}
		return null;
	}

	function panInputOf(pan) {
		const direct = firstMatching(pan.input, (el) => isInput(el) && isVisible(el));
		if (direct) return direct;
		// 兜底：页面上确实写着「提取码 / 访问码 / 密码」时才认通用输入框，
		// 免得在网盘首页把搜索框 / 登录框当提取码框填了。
		if (!pan.hint.test(pageText())) return null;
		const generic = qsa('input[type="password"], input[type="text"]').filter((el) => isInput(el) && isVisible(el));
		return generic.length === 1 ? generic[0] : null;
	}

	function panButtonOf(pan) {
		return firstMatching(pan.button, (el) => isVisible(el)) || firstMatching(pan.button, () => true);
	}

	function autoFill() {
		if (!opt.on || !opt.panAuto) return;
		const pan = panOf(HOST);
		if (!pan) return;
		const pwd = readPwdFromUrl(location.href);
		if (!pwd) return;

		let tries = 0;
		const timer = setInterval(() => {
			tries++;
			const input = panInputOf(pan);
			if (input) {
				clearInterval(timer);
				if (input.value === pwd) return;
				setNativeValue(input, pwd);
				bump("fill");
				pushEvent("fill", pan.name, pwd);
				log(`已为「${pan.name}」自动填入提取码`);
				// 填完就提交 —— 用户此刻可能在别的标签页，多一次手动确认就白自动化了
				setTimeout(() => {
					const btn = panButtonOf(pan);
					if (btn && isVisible(btn)) {
						try {
							btn.click();
						} catch (e) {
							/* 忽略 */
						}
					}
				}, 600);
				return;
			}
			if (tries >= 25) clearInterval(timer);
		}, 400);
	}

	/* ==========================================================================
	 * 8. UI 层（jh- 前缀，遵循仓库 UI 规范）
	 * ======================================================================== */

	const CSS = `
html{
  --jh-accent:#2da44e; --jh-accent-2:#1a7f37; --jh-accent-fg:#ffffff;
  --jh-good:#2da44e; --jh-warn:#d29922; --jh-bad:#f85149;
}
.jh-scope{
  --jh-bg:#0d1117; --jh-bg-2:#161b22; --jh-bg-3:#21262d;
  --jh-bd:#30363d; --jh-bd-2:#21262d;
  --jh-fg:#e6edf3; --jh-fg-2:#8b949e; --jh-fg-3:#6e7681;
  --jh-shadow:0 16px 44px rgba(0,0,0,.5);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  color:var(--jh-fg); font-size:13px; line-height:1.5;
}
.jh-scope.jh-light{
  --jh-bg:#ffffff; --jh-bg-2:#f6f8fa; --jh-bg-3:#eaeef2;
  --jh-bd:#d0d7de; --jh-bd-2:#d8dee4;
  --jh-fg:#1f2328; --jh-fg-2:#59636e; --jh-fg-3:#818b98;
  --jh-shadow:0 16px 44px rgba(31,35,40,.16);
}
.jh-scope svg{width:1em;height:1em;fill:currentColor;flex:none;vertical-align:-.125em;}

#jh-overlay{position:fixed; inset:0; z-index:2147483001; background:rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .2s;}
#jh-overlay.jh-open{opacity:1; pointer-events:auto;}
#jh-panel{position:fixed; left:50%; top:50%; z-index:2147483002; width:460px; max-width:calc(100vw - 32px); max-height:84vh;
  background:var(--jh-bg); border:1px solid var(--jh-bd); border-radius:14px; box-shadow:var(--jh-shadow);
  display:flex; flex-direction:column; overflow:hidden; opacity:0; transform:translate(-50%,-46%) scale(.97); pointer-events:none;
  transition:opacity .22s, transform .22s cubic-bezier(.4,0,.2,1);}
#jh-panel.jh-open{opacity:1; transform:translate(-50%,-50%) scale(1); pointer-events:auto;}

.jh-head{display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid var(--jh-bd-2); flex:none;}
.jh-head h2{margin:0; font-size:15px; font-weight:600; color:var(--jh-fg);}
.jh-head .jh-ver{font-size:11px; color:var(--jh-fg-2); border:1px solid var(--jh-bd); border-radius:999px; padding:1px 7px;}
.jh-spacer{flex:1;}
.jh-tabs{display:flex; border-bottom:1px solid var(--jh-bd-2); flex:none; background:var(--jh-bg-2);}
.jh-tab{flex:1; padding:10px 0; border:none; background:transparent; cursor:pointer; font-family:inherit; font-size:13px;
  color:var(--jh-fg-2); border-bottom:2px solid transparent; transition:color .15s, background .15s;}
.jh-tab:hover{color:var(--jh-fg); background:var(--jh-bg-3);}
.jh-tab.jh-on{color:var(--jh-fg); font-weight:600; border-bottom-color:var(--jh-accent);}
.jh-body{flex:1; overflow-y:auto; min-height:200px;}
.jh-body::-webkit-scrollbar{width:8px;}
.jh-body::-webkit-scrollbar-thumb{background:var(--jh-bd); border-radius:4px;}
.jh-page{display:none; padding:14px 16px 16px;} .jh-page.jh-on{display:block;}

.jh-card{background:var(--jh-bg-2); border:1px solid var(--jh-bd-2); border-radius:10px; padding:12px; margin-bottom:12px;}
.jh-card h3{margin:0 0 10px; font-size:12px; font-weight:600; color:var(--jh-fg-2); letter-spacing:.02em;}
.jh-stats{display:flex; gap:10px;}
.jh-stat{flex:1; background:var(--jh-bg-3); border-radius:8px; padding:10px 12px; text-align:center;}
.jh-stat b{display:block; font-size:20px; font-weight:600; color:var(--jh-fg); line-height:1.2;}
.jh-stat span{font-size:11px; color:var(--jh-fg-2);}

.jh-btn{display:inline-flex; align-items:center; gap:5px; padding:5px 10px; border:1px solid var(--jh-bd); border-radius:6px;
  background:var(--jh-bg-3); color:var(--jh-fg); font-family:inherit; font-size:12px; cursor:pointer; white-space:nowrap;
  transition:background .15s, border-color .15s, opacity .15s;}
.jh-btn:hover{background:var(--jh-bd); border-color:var(--jh-fg-3);}
.jh-btn[disabled]{opacity:.5; pointer-events:none;}
.jh-btn.jh-primary{background:var(--jh-accent); border-color:var(--jh-accent); color:var(--jh-accent-fg);}
.jh-btn.jh-primary:hover{background:var(--jh-accent-2);}
.jh-btn.jh-danger:hover{background:var(--jh-bad); border-color:var(--jh-bad); color:#fff;}
.jh-icon-btn{width:28px; height:28px; display:flex; align-items:center; justify-content:center; border:none; border-radius:6px;
  background:transparent; color:var(--jh-fg-2); cursor:pointer; font-size:16px; transition:background .15s, color .15s;}
.jh-icon-btn:hover{background:var(--jh-bg-3); color:var(--jh-fg);}

.jh-switch{position:relative; width:40px; height:22px; flex:none; cursor:pointer;}
.jh-switch input{position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; z-index:1;}
.jh-switch i{display:block; width:40px; height:22px; border-radius:11px; background:var(--jh-bd); transition:background .22s; position:relative;}
.jh-switch i::after{content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff;
  transition:transform .22s cubic-bezier(.4,0,.2,1);}
.jh-switch input:checked + i{background:var(--jh-accent);}
.jh-switch input:checked + i::after{transform:translateX(18px);}

.jh-field{display:flex; align-items:center; gap:10px; padding:7px 0;}
.jh-field + .jh-field{border-top:1px solid var(--jh-bd-2);}
.jh-field .jh-name{font-size:13px; color:var(--jh-fg); flex:none;}
.jh-field .jh-desc{font-size:11px; color:var(--jh-fg-2); flex:1;}
.jh-tag{display:inline-block; font-size:11px; padding:2px 7px; margin:0 6px 6px 0; border-radius:999px;
  border:1px solid var(--jh-bd); color:var(--jh-fg-2); cursor:pointer; transition:all .15s;}
.jh-tag:hover{border-color:var(--jh-fg-3); color:var(--jh-fg);}
.jh-tag.jh-off{opacity:.42; text-decoration:line-through;}
.jh-row{display:flex; align-items:center; gap:8px; padding:7px 0;}
.jh-row + .jh-row{border-top:1px solid var(--jh-bd-2);}
.jh-row .jh-k{font-size:11px; color:var(--jh-fg-2); flex:none;}
.jh-row .jh-v{font-size:12px; color:var(--jh-fg); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.jh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px;}
.jh-empty{font-size:12px; color:var(--jh-fg-2); padding:6px 0;}
.jh-note{font-size:11px; color:var(--jh-fg-3); line-height:1.6;}
.jh-pill{font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--jh-bd); color:var(--jh-fg-2);}
.jh-pill.jh-ok{color:var(--jh-good); border-color:var(--jh-good);}
.jh-pill.jh-warn{color:var(--jh-warn); border-color:var(--jh-warn);}
.jh-btns{display:flex; gap:8px; flex-wrap:wrap;}

/* 入口：注入宿主既有容器，不悬浮 */
.jh-entry{display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 10px; margin-left:8px;
  border:1px solid var(--jh-bd); border-radius:6px; background:var(--jh-bg-3); color:var(--jh-fg);
  font-family:inherit; font-size:12px; cursor:pointer; vertical-align:middle; transition:background .15s, border-color .15s;}
.jh-entry:hover{background:var(--jh-bd);}
.jh-entry.jh-entry--light{--jh-bg-3:#ffffff; --jh-bd:#d0d7de; --jh-fg:#1f2328; --jh-fg-2:#59636e;}
.jh-entry.jh-entry--dark{--jh-bg-3:#21262d; --jh-bd:#30363d; --jh-fg:#e6edf3; --jh-fg-2:#8b949e;}

#jh-toasts{position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:2147483004; display:flex;
  flex-direction:column; gap:8px; align-items:center; pointer-events:none;}
.jh-toast{display:flex; align-items:center; gap:8px; max-width:min(560px, calc(100vw - 32px)); padding:9px 14px;
  border-radius:8px; font-family:inherit; font-size:13px; color:#fff; box-shadow:0 6px 20px rgba(0,0,0,.35);
  opacity:0; transform:translateY(12px); transition:opacity .22s, transform .22s;}
.jh-toast.jh-show{opacity:1; transform:none;}
.jh-toast.jh-info{background:#1f6feb;} .jh-toast.jh-ok{background:var(--jh-good);}
.jh-toast.jh-warn{background:#9e6a03;} .jh-toast.jh-err{background:#b62324;}
`;

	const ICON = {
		link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z"/></svg>',
		close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>'
	};

	let uiRoot = null;
	let uiLight = false;

	/** 宿主是深色还是浅色（按 body 背景亮度判断） */
	function hostTheme() {
		try {
			const probe = document.body || document.documentElement;
			const bg = getComputedStyle(probe).backgroundColor || "";
			const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(bg);
			if (!m) return "auto";
			const lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
			return lum > 150 ? "light" : "dark";
		} catch (e) {
			return "auto";
		}
	}

	/**
	 * 轻提示。
	 *
	 * 只在两个地方出现：**首次安装那一次**（否则用户没法确认脚本是否生效），
	 * 以及**面板里的操作反馈**（用户主动点的，理应有回应）。
	 * 脚本的自动行为（免中转 / 带提取码 / 填码）一律不调用它。
	 */
	function toast(msg, kind) {
		try {
			let box = document.getElementById("jh-toasts");
			if (!box) {
				box = document.createElement("div");
				box.id = "jh-toasts";
				(document.body || document.documentElement).appendChild(box);
			}
			const el = document.createElement("div");
			el.className = "jh-toast jh-" + (kind || "info");
			el.textContent = msg;
			box.appendChild(el);
			requestAnimationFrame(() => el.classList.add("jh-show"));
			setTimeout(() => {
				el.classList.remove("jh-show");
				setTimeout(() => el.remove(), 260);
			}, 2600);
		} catch (e) {
			/* 忽略 */
		}
	}

	function addStyle(id, css) {
		if (document.getElementById(id)) return;
		const el = document.createElement("style");
		el.id = id;
		el.textContent = css;
		(document.head || document.documentElement).appendChild(el);
	}

	/* ---- 面板 ---- */

	function esc(s) {
		return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
	}

	function shortLink(u) {
		const s = String(u || "");
		return s.length > 52 ? s.slice(0, 30) + "…" + s.slice(-18) : s;
	}

	function fmtTime(t) {
		const d = new Date(t);
		const p = (n) => String(n).padStart(2, "0");
		return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	}

	const KIND_LABEL = { skip: "免中转", resolve: "预解析", fill: "带提取码" };

	function overviewHTML() {
		const rule = currentRule();
		const pan = panOf(HOST);
		const hostTip = rule
			? `<span class="jh-pill jh-ok">已适配</span>`
			: `<span class="jh-pill">未适配 · 走通用参数兜底</span>`;
		const jumpReady = rule && rule.jump;
		const events = eventLog.length
			? eventLog.slice(0, 8).map((e) => `
				<div class="jh-row">
					<span class="jh-k">${fmtTime(e.t)}</span>
					<span class="jh-pill">${esc(KIND_LABEL[e.k] || e.k)}</span>
					<span class="jh-v jh-mono" title="${esc(e.to)}">${esc(shortLink(e.to))}</span>
				</div>`).join("")
			: `<div class="jh-empty">还没有记录。点一个站外链接试试。</div>`;
		return `
		<div class="jh-card">
			<h3>当前页面</h3>
			<div class="jh-row"><span class="jh-k">站点</span><span class="jh-v jh-mono">${esc(HOST || "-")}</span>${hostTip}</div>
			<div class="jh-row"><span class="jh-k">规则</span><span class="jh-v">${esc(rule ? rule.name : "无站点规则")}</span>
				<span class="jh-pill ${jumpReady ? "jh-ok" : ""}">${jumpReady ? "含中转页自跳" : "仅链接改写"}</span></div>
			<div class="jh-row"><span class="jh-k">网盘</span><span class="jh-v">${esc(pan ? pan.name : "当前页面不是网盘分享页")}</span></div>
			<div class="jh-btns" style="margin-top:10px;">
				<button class="jh-btn" data-act="rescan" title="页面链接是分批加载的，必要时手动补一次">重新扫描本页</button>
			</div>
		</div>
		<div class="jh-card">
			<h3>统计</h3>
			<div class="jh-stats">
				<div class="jh-stat"><b>${stat.skip}</b><span>已免中转</span></div>
				<div class="jh-stat"><b>${stat.resolve}</b><span>已预解析链接</span></div>
				<div class="jh-stat"><b>${stat.fill}</b><span>已带提取码</span></div>
			</div>
		</div>
		<div class="jh-card">
			<h3>怎么用</h3>
			<p class="jh-note">不用做任何操作 —— <b>直接点链接就行</b>：<br>
			· 站外链接：跳过「安全提示 / 即将离开 / 确认跳转」这类中转页<br>
			· 网盘链接：自动把写在链接旁边的提取码拼上，落地后自动填入并提交<br>
			· 统一在新标签页打开，原页面留着；中键 / 右键同样生效<br>
			· <b>过程里不会有任何弹窗或提示</b>。这里只是用来看状态和改设置的地方。</p>
		</div>
		<div class="jh-card">
			<h3>最近事件</h3>
			${events}
		</div>`;
	}

	/**
	 * 设置分组。
	 *
	 * 分组依据是「用户会在什么场景下想动它」，不是实现模块：
	 *   主开关 —— 临时不想用它
	 *   跳转行为 —— 想改变「跳到哪儿 / 怎么跳」
	 *   网盘 —— 提取码抓错时整体关掉
	 *   站点 —— 某个站不能动
	 */
	const OPT_GROUPS = [
		{
			title: "主开关",
			note: "关掉后所有功能停用，管理器菜单仍然保留，方便再打开。",
			fields: [["on", "总开关", "全部功能的总闸"]]
		},
		{
			title: "跳转行为",
			fields: [
				["newTab", "在新标签页打开", "原页面留着，不被打断"],
				["autoJump", "落地中转页自动跳走", "不用再点「继续访问」"],
				["guard", "压掉站点拦截", "站点自己的跳转 / 统计 / 弹窗处理器抢不走这次点击"]
			]
		},
		{
			title: "网盘",
			note: "带码、填码、提交是一件事的三个步骤，所以合成一个开关。抓错码就整体关掉，免中转部分不受影响。",
			fields: [["panAuto", "自动带提取码", "点网盘链接时取链接旁的码拼上，落地后填入并提交"]]
		}
	];

	function optHTML() {
		const cards = OPT_GROUPS.map((g) => `
		<div class="jh-card">
			<h3>${esc(g.title)}</h3>
			${(g.fields || [])
				.map(
					([k, name, desc]) => `
			<div class="jh-field">
				<span class="jh-name">${esc(name)}</span>
				<span class="jh-desc">${esc(desc)}</span>
				<label class="jh-switch"><input type="checkbox" data-opt="${k}" ${opt[k] ? "checked" : ""}><i></i></label>
			</div>`
				)
				.join("")}
			${g.note ? `<p class="jh-note" style="margin:8px 0 0;">${esc(g.note)}</p>` : ""}
		</div>`).join("");

		const skipped = isSkippedSite();
		const skipTags = opt.skipHosts.length
			? opt.skipHosts.map((h) => `<span class="jh-tag" data-unskip="${esc(h)}" title="点击移除">${esc(h)}</span>`).join("")
			: `<div class="jh-empty">还没有不处理的站点。</div>`;

		const ruleTags = SITES.map((s) => {
			const off = opt.mute.indexOf(s.name) >= 0;
			return `<span class="jh-tag ${off ? "jh-off" : ""}" data-mute="${esc(s.name)}" title="${esc(String(s.host))}">${esc(s.name)}</span>`;
		}).join("");

		return `
		${cards}
		<div class="jh-card">
			<h3>站点</h3>
			<div class="jh-field">
				<span class="jh-name">本站不处理</span>
				<span class="jh-desc">${esc(HOST || "-")}　命中后本页完全跳过</span>
				<label class="jh-switch"><input type="checkbox" data-skip-here ${skipped ? "checked" : ""}><i></i></label>
			</div>
			<div style="margin-top:10px;">
				<p class="jh-note" style="margin:0 0 6px;">不处理名单（点一下移除）：</p>
				${skipTags}
			</div>
		</div>
		<div class="jh-card">
			<h3>站点规则 · ${SITES.length} 条（点标签停用单条）</h3>
			<div>${ruleTags}</div>
			<div class="jh-btns" style="margin-top:10px;">
				<button class="jh-btn" data-act="all-on">全部启用</button>
				<button class="jh-btn" data-act="reset">恢复默认设置</button>
			</div>
		</div>
		<div class="jh-card">
			<h3>入口按钮</h3>
			<div class="jh-field" style="border:none; padding-top:0;">
				<span class="jh-name">页面入口按钮</span>
				<span class="jh-desc">跳转本身全自动，按钮只是查看入口：仅当本页有链接被接管、且找到宿主页头工具栏时才出现，网盘分享页不出现</span>
				<div class="jh-btns">
					${[["auto", "跟随宿主"], ["light", "浅色"], ["dark", "暗色"], ["off", "不显示"]]
						.map(([k, label]) => `<button class="jh-btn${opt.entry === k ? " jh-primary" : ""}" data-act="entry" data-entry="${k}">${label}</button>`)
						.join("")}
				</div>
			</div>
		</div>
		<div class="jh-card">
			<h3>数据</h3>
			<div class="jh-row"><span class="jh-k">存储键</span><span class="jh-v jh-mono">${KEY.opt} · ${KEY.stat} · ${KEY.log}</span></div>
			<div class="jh-row"><span class="jh-k">读取</span><span class="jh-v">提取码从 URL 的 pwd 参数读取，不发任何网络请求</span></div>
			<div class="jh-btns" style="margin-top:10px;">
				<button class="jh-btn jh-danger" data-act="reset-stat">重置统计与日志</button>
			</div>
		</div>`;
	}

	function panelHTML() {
		return `
		<div id="jh-overlay"></div>
		<div id="jh-panel" class="jh-scope ${uiLight ? "jh-light" : ""}" role="dialog" aria-label="链接直跳助手">
			<div class="jh-head">
				${ICON.link}
				<h2>链接直跳</h2>
				<span class="jh-ver">v${VERSION}</span>
				<span class="jh-spacer"></span>
				<button class="jh-icon-btn" data-act="close" title="关闭">${ICON.close}</button>
			</div>
			<div class="jh-tabs">
				<button class="jh-tab jh-on" data-tab="overview">概览</button>
				<button class="jh-tab" data-tab="opt">设置</button>
			</div>
			<div class="jh-body">
				<div class="jh-page jh-on" data-page="overview">${overviewHTML()}</div>
				<div class="jh-page" data-page="opt">${optHTML()}</div>
			</div>
		</div>`;
	}

	let currentTab = "overview";

	function renderPages() {
		if (!uiRoot) return;
		const map = { overview: overviewHTML, opt: optHTML };
		for (const key of Object.keys(map)) {
			const host = uiRoot.querySelector(`.jh-page[data-page="${key}"]`);
			if (host) host.innerHTML = map[key]();
		}
	}

	function openPanel(tab) {
		if (!opt.on) {
			toast("脚本已被关闭，可先到设置里打开总开关", "warn");
		}
		if (!uiRoot) {
			addStyle("jh-style", CSS);
			const wrap = document.createElement("div");
			wrap.innerHTML = panelHTML();
			(document.body || document.documentElement).appendChild(wrap);
			uiRoot = document;
			bindPanel();
		}
		if (tab) switchTab(tab);
		else renderPages();
		const ov = document.getElementById("jh-overlay");
		const pn = document.getElementById("jh-panel");
		if (ov) ov.classList.add("jh-open");
		if (pn) pn.classList.add("jh-open");
	}

	function closePanel() {
		const ov = document.getElementById("jh-overlay");
		const pn = document.getElementById("jh-panel");
		if (ov) ov.classList.remove("jh-open");
		if (pn) pn.classList.remove("jh-open");
	}

	function switchTab(tab) {
		currentTab = tab;
		if (!uiRoot) return;
		qsa(".jh-tab").forEach((b) => b.classList.toggle("jh-on", b.getAttribute("data-tab") === tab));
		qsa(".jh-page").forEach((p) => p.classList.toggle("jh-on", p.getAttribute("data-page") === tab));
		renderPages();
	}

	function bindPanel() {
		document.addEventListener("click", (e) => {
			const t = e.target;
			if (!t || !t.closest) return;
			const tabBtn = t.closest(".jh-tab");
			if (tabBtn && tabBtn.closest("#jh-panel")) {
				switchTab(tabBtn.getAttribute("data-tab"));
				return;
			}
			if (t.id === "jh-overlay") {
				closePanel();
				return;
			}
			const unskip = t.closest("[data-unskip]");
			if (unskip && unskip.closest("#jh-panel")) {
				removeSkipHost(unskip.getAttribute("data-unskip"));
				return;
			}
			const tag = t.closest(".jh-tag");
			if (tag && tag.closest("#jh-panel")) {
				toggleMute(tag.getAttribute("data-mute"));
				return;
			}
			const act = t.closest("[data-act]");
			if (act && act.closest("#jh-panel")) {
				handleAction(act.getAttribute("data-act"), act);
			}
		}, true);

		document.addEventListener("change", (e) => {
			const t = e.target;
			if (!t || !t.getAttribute || !t.closest || !t.closest("#jh-panel")) return;
			if (t.hasAttribute("data-skip-here")) {
				toggleSkipHere(!!t.checked);
				return;
			}
			const key = t.getAttribute("data-opt");
			if (!key) return;
			opt[key] = !!t.checked;
			saveOpt();
			applyRuntimeOpts();
		}, true);

		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape") closePanel();
		}, true);
	}

	/** 一键把当前站点加入 / 移出不处理名单 —— 比让人手打逗号分隔的域名友好得多 */
	function toggleSkipHere(on) {
		const h = normHost(HOST);
		if (!h) return;
		const i = opt.skipHosts.indexOf(h);
		if (on && i < 0) opt.skipHosts.push(h);
		if (!on && i >= 0) opt.skipHosts.splice(i, 1);
		saveOpt();
		renderPages();
		toast(on ? `${h} 已加入不处理名单，刷新后生效` : `${h} 已移出不处理名单`, "ok");
	}

	function removeSkipHost(host) {
		const i = opt.skipHosts.indexOf(host);
		if (i < 0) return;
		opt.skipHosts.splice(i, 1);
		saveOpt();
		renderPages();
	}

	function toggleMute(name) {
		const i = opt.mute.indexOf(name);
		if (i >= 0) opt.mute.splice(i, 1);
		else opt.mute.push(name);
		saveOpt();
		renderPages();
	}

	function applyRuntimeOpts() {
		const entry = qs(".jh-entry");
		if (!entry) return;
		if (!worthEntry()) {
			entry.remove(); // 被关掉、或本页已不值当露脸
			return;
		}
		entry.className = "jh-entry " + entryThemeClass();
	}

	function handleAction(act, el) {
		switch (act) {
			case "close":
				closePanel();
				break;
			case "rescan":
				scan(document);
				deepScan();
				invalidatePagePwd();
				toast("已重新扫描本页链接", "ok");
				break;
			case "entry":
				opt.entry = el.getAttribute("data-entry") || "auto";
				saveOpt();
				applyRuntimeOpts();
				maybeInjectEntry();
				renderPages();
				break;
			case "all-on":
				opt.mute = [];
				saveOpt();
				renderPages();
				toast("已启用全部站点规则", "ok");
				break;
			case "reset":
				opt = Object.assign({}, DEFAULT_OPT);
				saveOpt();
				renderPages();
				applyRuntimeOpts();
				toast("已恢复默认设置", "ok");
				break;
			case "reset-stat":
				stat.skip = stat.resolve = stat.fill = 0;
				eventLog = [];
				saveStat();
				gm.set(KEY.log, []);
				renderPages();
				toast("统计与日志已重置", "ok");
				break;
			default:
				break;
		}
	}

	/* ---- 入口注入（按需露脸，不是每个页面都注入）---- */

	/**
	 * 宿主工具栏候选容器。
	 *
	 * 只挑「本来就是页头操作区」的容器 —— 找不到就静默。
	 * 管理器菜单（Tampermonkey 图标）始终可用，不为此硬凑注入点，
	 * 更不会做成脱离文档流、跟着页面滚的那种常驻件。
	 */
	const ENTRY_SLOTS = [
		".toolbar",
		".header-actions",
		".header-toolbar",
		".page-actions",
		"header .actions",
		"header .toolbar"
	];

	function entryThemeClass() {
		const mode = opt.entry === "auto" ? hostTheme() : opt.entry;
		return mode === "light" ? "jh-entry--light" : mode === "dark" ? "jh-entry--dark" : "";
	}

	/**
	 * 本页值不值得注入入口？三条同时成立才露脸：
	 *
	 * ① 顶层文档、脚本启用、站点不在「不处理」名单；
	 * ② **不在网盘分享页** —— 那是终点站。用户都到分享页了，那里既没有中转
	 *    需要剥、也没有提取码需要补，脚本本就该收手，更不该往人家工具栏塞东西；
	 * ③ 本页**确实处理过链接**（`pageHits > 0`）—— 一条都没动过就别出声，
	 *    免得在「脚本什么也没做」的页面上凭空多出一个按钮。
	 *
	 * 这是「看情况决定是否注入」：跳转本身是全自动的，入口按钮只是「脚本在
	 * 这页干了活」的可见凭证 + 顺手打开面板，它不该是每页都有的常驻物。
	 */
	function worthEntry() {
		if (!IS_TOP || !opt.on || isSkippedSite()) return false;
		if (opt.entry === "off") return false;
		if (panOf(HOST)) return false;
		return pageHits > 0;
	}

	let entryPending = false;

	function injectEntry() {
		if (entryPending || qs(".jh-entry")) return;
		entryPending = true;
		const doc = document;
		waitFor(ENTRY_SLOTS, (bar) => {
			entryPending = false;
			if (document !== doc) return; // 页面已被换掉，本次注入作废
			// 容器出现可能晚于条件成立，此刻复检一次：期间本页可能已经不值当露脸了
			if (!worthEntry()) return;
			if (bar.querySelector(".jh-entry")) return; // 防重复
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "jh-entry " + entryThemeClass();
			btn.innerHTML = ICON.link + "<span>直跳</span>";
			btn.title = "链接直跳：本页已处理 " + pageHits + " 条链接，点击查看";
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				openPanel();
			}, true);
			bar.appendChild(btn);
			log("入口已注入宿主工具栏");
		}, 6000);
	}

	/** 扫描之后调用：本页确实干了活才露脸 */
	function maybeInjectEntry() {
		if (!worthEntry()) return;
		injectEntry();
	}

	function registerMenu() {
		if (!IS_TOP) return;
		gm.menu("链接直跳 · 打开面板", () => openPanel());
		gm.menu("链接直跳 · 重新扫描本页链接", () => {
			scan(document);
			deepScan();
			invalidatePagePwd();
			toast("已重新扫描本页链接", "ok");
		});
		gm.menu(`链接直跳 · 已免中转 ${stat.skip} 次（点击重置）`, () => {
			stat.skip = stat.resolve = stat.fill = 0;
			eventLog = [];
			saveStat();
			gm.set(KEY.log, []);
			toast("统计已重置", "ok");
		});
	}

	/* ==========================================================================
	 * 9. 编排
	 * ======================================================================== */

	let observer = null;

	/**
	 * 增量扫描队列。
	 *
	 * 只扫「新增子树」而不是整页重扫 —— 动态页面（Next.js / React 水合、
	 * 无限滚动、评论区懒加载）里链接是**逐步插进来**的，而首屏 deepScan
	 * 只跑一次，漏掉的再没人管。这就是「同一页里靠前的链接接管了、靠后的
	 * 没接管」的根因。
	 *
	 * 队列按帧合并；同一节点只处理一次。
	 */
	const pendingRoots = [];
	let pendingSet = null;

	function queueNode(node) {
		if (!node || node.nodeType !== 1) return;
		if (!pendingSet) pendingSet = new Set();
		if (pendingSet.has(node)) return;
		pendingSet.add(node);
		pendingRoots.push(node);
	}

	/**
	 * 把一个新增子树里的链接按「通用规则」过一遍。
	 *
	 * 与 deepScan 共用 `resolveLink` —— 站点规则命中与否都要走，
	 * 未适配站点靠的就是这条路。
	 */
	function scanRoot(root) {
		if (!opt.on || !root) return 0;
		let n = 0;
		const links = [];
		try {
			if (root.tagName === "A" && root.href) links.push(root);
			const inner = root.querySelectorAll ? root.querySelectorAll("a[href]") : [];
			for (const a of inner) links.push(a);
		} catch (e) {
			return 0;
		}
		for (const a of links) {
			try {
				if (resolveLink(a)) n++;
			} catch (e) {
				/* 单条失败不影响其它 */
			}
		}
		if (n) bump("resolve");
		return n;
	}

	function flushRoots() {
		if (!pendingRoots.length) return;
		const batch = pendingRoots.splice(0, pendingRoots.length);
		pendingSet = null;
		for (const node of batch) {
			if (!node.isConnected) continue;
			// 已经在别处处理过的子树不必重复走
			if (node.closest && node.closest("[" + ATTR + "]") === node) continue;
			scanRoot(node);
		}
		// 异步增量也有可能是本页唯一「干活」的地方（水合后才出链接的站点）
		maybeInjectEntry();
	}

	function startObserver() {
		const root = document.documentElement;
		if (!root || observer) return;
		// 回调是异步的，跑起来时文档可能已经不是当初那个了（重导航 / 宿主换文档），
		// 那时再按老上下文扫新 DOM 只会改错别人的链接
		const doc = document;
		let queued = false;
		observer = new MutationObserver((records) => {
			if (document !== doc) return; // 环境已失效
			// 页面变了，整页提取码缓存作废 —— 帖子异步加载出「提取码：xxxx」时才知道有码
			invalidatePagePwd();
			for (const r of records) {
				// 只看新增节点；属性变更（站点自己改 href）由点击层兜底
				if (r.type !== "childList") continue;
				for (const node of r.addedNodes || []) queueNode(node);
			}
			if (queued || !pendingRoots.length) return;
			queued = true;
			// 合并同一帧内的多次变更，避免动态页面里反复查询
			const run = () => {
				if (document !== doc) return; // 环境已失效
				queued = false;
				// ① 站点规则命中的部分仍走 scan（它按选择器精确改写）
				const n = scan(document);
				if (n) bump("resolve");
				// ② 其余按通用规则处理新增子树
				flushRoots();
			};
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
			else setTimeout(run, 16);
		});
		observer.observe(root, { childList: true, subtree: true });
	}

	function init() {
		loadStore();
		if (isSkippedSite()) {
			log("站点在不处理名单里，本页跳过");
			return;
		}
		if (!opt.on) {
			registerMenu();
			return;
		}

		/* 尽早挂上 —— 必须在页面自己的脚本之前，否则点击已被站点接管 */
		document.addEventListener("click", onClick, true);
		hookOpen();

		const boot = () => {
			addStyle("jh-style", CSS);
			startObserver();
			scan(document);
			// deepScan 扫完会自己判断要不要注入入口（见 maybeInjectEntry）
			deepScan();
			registerMenu();
			setTimeout(() => {
				autoFill();
				tryAutoJump();
			}, 120);
		};

		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", boot, { once: true });
		} else {
			boot();
		}

		if (!gm.get(KEY.flag, false)) {
			gm.set(KEY.flag, true);
			setTimeout(() => toast("链接直跳已启用：点外链不再经过中转页", "info"), 1200);
		}
		log(`v${VERSION} 已加载 · ${HOST} · 规则 ${SITES.length} 条 · 网盘 ${PANS.length} 家`);
	}

	/* ==========================================================================
	 * 10. 导出（Node / jsdom 直测用）
	 * ======================================================================== */

	const API = {
		VERSION,
		ATTR,
		KEY,
		STRONG_PARAMS,
		WEAK_PARAMS,
		SITES,
		PANS,
		INTERSTITIAL_THRESHOLD,
		// 纯函数
		decodeLoose,
		tryDecodeBase64,
		safeUrl,
		normToUrl,
		isHttpUrl,
		isSameHost,
		sameRegistry,
		registrable,
		isJumpPath,
		queryPairs,
		pickRedirectParam,
		stepOnce,
		resolveTarget,
		shouldJump,
		scoreInterstitial,
		panOf,
		parsePwd,
		parsePwdAll,
		withPwd,
		readPwdFromUrl,
		// 引擎
		eng: {
			scan,
			scanRoot,
			deepScan,
			resolveLink,
			isPanShare,
			onClick,
			tryAutoJump,
			autoFill,
			resolveAnchor,
			applyRewrite,
			netdiskTarget,
			netdiskCandidate,
			findNearbyPwd,
			hasSiblingPanLink,
			pagePwds,
			invalidatePagePwd,
			navigate,
			pageText,
			worthEntry,
			injectEntry,
			maybeInjectEntry,
			get pageHits() {
				return pageHits;
			}
		},
		ui: {
			open: openPanel,
			close: closePanel,
			get tab() {
				return currentTab;
			},
			showToast: toast,
			/** 供 preview.html 之类的静态预览复用同一套样式 */
			css: CSS,
			render: { overviewHTML, optHTML }
		},
		state: {
			get opt() {
				return opt;
			},
			get stat() {
				return stat;
			},
			get log() {
				return eventLog;
			},
			loadStore,
			saveOpt,
			currentRule,
			migrate: migrateOpt
		}
	};

	if (typeof module !== "undefined" && module.exports) module.exports = API;
	if (typeof window !== "undefined") {
		try {
			win.__jumpHub__ = API;
		} catch (e) {
			/* 忽略 */
		}
	}

	// 只在真实浏览器环境里自启动，方便 Node 里 require 直测
	if (typeof document !== "undefined" && typeof window !== "undefined" && typeof location !== "undefined") {
		try {
			init();
		} catch (e) {
			try {
				log("初始化失败：", e && e.message);
			} catch (e2) {
				/* 忽略 */
			}
		}
	}
})();
