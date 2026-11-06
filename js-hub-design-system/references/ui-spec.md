# 油猴脚本 UI 设计规范（Design System）

> 提取自 `github-accelerate.js`（v1.5.5）实际外观，作为本仓库其他油猴脚本的统一风格基准。
> **风格定位**：GitHub 原生感 · 扁平 · 6/14px 圆角 · 克制强调色 · 明暗自适应 · 零类库依赖 · **不打扰页面**。
>
> **入口基线（2026-09-15 起，2026-09-22 修订）**：禁止一切**脱离文档流的悬浮入口**与**全局快捷键**；**注入前必须先过「注入决策」——零注入也是合法结论**（全自动脚本不注入，管理器菜单是唯一入口）；决定注入的必须**嵌入宿主既有容器**，且**必须保留脚本管理器菜单兜底**。详见第一节「交互入口约定」。

---

## 一、两套样式模式（先读这一节）

一个脚本的 UI 通常分两类，**消费方式不同，务必区分**：

| 模式 | 前缀 | 特点 | 适用 |
|---|---|---|---|
| **A 自有面板/浮层** | `ghb-` | 自带 `--ghb-*` 变量体系，与宿主解耦，可独立切换明暗 | 控制面板、弹窗、Toast |
| **B 注入宿主的增强元素** | `gh-` | 复用宿主 CSS 变量，自动融入宿主外观 | 注入到页面里的按钮、分组、标签 |

**模式 B 的「三级变量回退」写法**（跨宿主主题版本保持稳定，推荐照抄）：

```css
color: var(--fgColor-muted, var(--color-fg-muted, #8b949e));   /* 新 token → 旧 token → 硬编码兜底 */
```

> 新脚本换前缀即可（如 `bl-`、`ab-`、`nd-`），保持「两个字母 + `-`」的紧凑风格。

### 交互入口约定（禁悬浮器件 / 注入先过决策）

入口的**唯一判据是「是否脱离宿主文档流」**——脱离的禁止，嵌入的鼓励：

| 类别 | 判定 | 策略 |
|---|---|---|
| **悬浮器件** | 脱离文档流的浮层入口：圆形悬浮球、圆角胶囊、侧边吸附按钮、可拖拽常驻按钮 | ❌ **禁止**。遮挡内容、需要拖拽避让、制造视觉噪音。 |
| **注入式入口** | 嵌在宿主页面既有容器内的元素（页面工具栏、操作栏、文件列表操作区） | ⚠️ **允许，但先过下方「注入决策」**——不是每个脚本都适合注入。 |
| **全局快捷键** | 全局 `keydown` / `keyup` 监听 | ❌ **禁止**。易与宿主站点、浏览器及其它扩展冲突。（例外：面板打开后监听 `Esc` 关闭，允许。） |
| **管理器菜单** | `GM_registerMenuCommand` | ✅ **必备兜底**。无论是否注入都必须提供。 |

**注入决策（第 0 步，先于一切注入规则）**：

注入不是标配。写任何注入代码之前，先回答两个问题：

1. **这个脚本在页面上有「需要用户点一下」的动作吗？**——功能全自动完成 = 没有。
2. **入口出现后，用户能拿它做什么？**——说不出一个具体动作 = 没用。

两问的答案都是「没有」→ **零注入**。强行注入只是视觉噪音：用户到分享页了按钮还挂着，反而让人困惑「这按钮是干嘛的」——直跳脚本的入口按钮就是这么被整体砍掉的。判定结果按三档落地：

| 档位 | 判定 | 做法 | 例 |
|---|---|---|---|
| **零注入** | 功能全自动，页面上没有任何需要用户操作的动作 | **不写任何注入代码、不提供任何入口设置**；管理器菜单是唯一入口 | 直跳脚本——跳转本身全自动，按钮无事可做 |
| **按需注入** | 只有部分页面需要入口 | 本页**真实干过活**才露脸；终点页（工具已无事可做的页面，如网盘分享页）永不注入；提供 **按需 / 总是 / 从不** 三档设置 | 下载助手——识别到可下载文件才出现 |
| **常驻注入** | 脚本本身就是页面操作工具，任何适配页都用得上 | 适配页内常驻，仍守八条硬性要求 | 批量操作、表单填充类工具 |

> 三档是**设计期决策**，不是运行时开关：判为零注入的脚本，连「显示入口」设置都不该有（给一个永远不该出现的按钮配开关，是把噪音写进设置页）。新脚本建骨架时先定档，再决定写不写注入代码。

**注入式入口的八条硬性要求**（适用于**按需注入 / 常驻注入**两档；零注入脚本不适用）：

1. **挂进宿主既有容器**——不得单独脱离文档流；用 `position: static` / `relative`，禁止 `fixed` / `absolute` 悬浮。
2. **尺寸向邻居看齐**——高度、字号、内边距与同一行的兄弟元素对齐，不喧宾夺主。
3. **样式优先复用宿主变量**——即模式 B 的三级回退写法；宿主确无可复用时，才补自有的最小样式。
4. **等容器出现再注入**——宿主多为 SPA，容器异步渲染。必须用 `MutationObserver` 等待，不得轮询或 `setTimeout` 硬等。
5. **防重复注入**——注入前检查标记 class 是否已存在。
6. **必须同时保留菜单兜底**——注入点会随宿主改版失效，管理器菜单是最后一道保障。
7. **按需档的触发判据必须「真干活」**——只有本页真实处理过内容才露脸（地址真被改了才计数，落标记、预扫描不算）；终点页永不注入；延迟回调触发时必须复检判据，防止异步渲染后误注入。
8. **是否注入，状态必须告知**（按需档适用）——按钮没出现时用户会问「为什么」。面板必须明示当前页的注入判定结果与**具体原因**（如：已注入工具栏（处理 N 条）／网盘分享页是终点站，无需入口／本页没有需要处理的链接／已在「不处理」名单／已选「从不显示」／未找到宿主工具栏容器）。不允许让用户对着一个消失的按钮猜原因。零注入脚本无此要求——按钮本来就不存在，无需解释。

```js
// 注入：等宿主工具栏出现后，把入口挂进去
waitFor(host.mount.home, (bar) => {
  if (bar.querySelector(".xx-entry")) return;   // 防重复
  bar.prepend(makeEntry());                     // 挂进既有容器
});
// 兜底：注入失效时仍可进面板
GM_registerMenuCommand("打开面板", ui.open, "o");
```

**面板配套要求**：

1. **懒挂载**——面板 DOM 与样式在首次打开时才注入；未打开时不得向宿主页面追加面板相关节点。
2. **首次提示**——可提示一次入口位置（Toast，数秒自动消失），且必须能在设置中关闭。
3. **可关闭**——面板必须支持 `Esc` 与点击遮罩关闭。

> **范围说明**：本条约束「入口的形态与位置」。面板内部的功能性控件（开关滑块、标签徽章、复选框对勾等）沿用各自惯例形态，不在去圆形化范围内。

---

## 一·五、脚本 Meta 与分发（硬性要求，2026-09-22 起）

**每个脚本的头部 Meta 必须携带作者、许可与更新地址**，缺一不可：

```js
// ==UserScript==
// @name         脚本名
// @namespace    js-hub/<文件夹名>
// @version      x.y.z
// @author       EFate
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/<文件夹>/<脚本文件名>
// @downloadURL  https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/<文件夹>/<脚本文件名>
// ==/UserScript==
```

| 条目 | 要求 |
|---|---|
| `@author` | 固定 `EFate`。三个既有脚本均为 `@author EFate`，新脚本照抄 |
| `@license` | 固定 `MIT`。开源许可必须显式声明，不许缺省 |
| `@updateURL` | 指向本仓库 raw 地址。没有它，Tampermonkey 无法检查更新，**用户侧将永远停留在旧版** |
| `@downloadURL` | 与 `@updateURL` 同地址。没有它，Tampermonkey 不会自动下载新版本 |
| 发版纪律 | 改完必须 commit + push（用系统 git），并 **curl 校验线上 `@version` 与本地一致**；只改不推 = 用户侧永远旧版 |
| 新脚本核对项 | 建脚本时把上面六行（namespace / version / author / license / updateURL / downloadURL）当作模板必填项，不填不算完成 |

---

## 二、变量体系（核心）

颜色**一律走变量，禁止散落硬编码**（唯一例外：遮罩黑、Toast 语义色、色板兜底值）。

```css
/* 根级：全局强调/语义色（挂在 html 上，注入页面的元素也能读到） */
html{
  --ghb-accent:#2da44e; --ghb-accent-2:#1a7f37; --ghb-accent-fg:#ffffff;
  --ghb-good:#2da44e; --ghb-warn:#d29922; --ghb-bad:#f85149;
}
/* 浅色模式：仅强调色加深，其余见 .ghb-scope.ghb-light */
html[data-color-mode="light"]{ --ghb-accent:#1a7f37; --ghb-accent-2:#116329; }

/* 面板作用域：暗色（默认） */
.ghb-scope{
  --ghb-bg:#0d1117; --ghb-bg-2:#161b22; --ghb-bg-3:#21262d;
  --ghb-bd:#30363d; --ghb-bd-2:#21262d;
  --ghb-fg:#e6edf3; --ghb-fg-2:#8b949e; --ghb-fg-3:#6e7681;
  --ghb-shadow:0 16px 44px rgba(0,0,0,.5);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  color:var(--ghb-fg); font-size:13px; line-height:1.5;
}
/* 面板作用域：浅色 */
.ghb-scope.ghb-light{
  --ghb-bg:#ffffff; --ghb-bg-2:#f6f8fa; --ghb-bg-3:#eaeef2;
  --ghb-bd:#d0d7de; --ghb-bd-2:#d8dee4;
  --ghb-fg:#1f2328; --ghb-fg-2:#59636e; --ghb-fg-3:#818b98;
  --ghb-shadow:0 16px 44px rgba(31,35,40,.16);
}
/* 图标：统一 1em，随字号缩放 */
.ghb-scope svg{width:1em;height:1em;fill:currentColor;flex:none;vertical-align:-.125em;}
```

### 变量语义

| 变量 | 用途 |
|---|---|
| `--ghb-accent` / `-2` / `-fg` | 强调色 / 强调色加深 / 强调色上的文字 |
| `--ghb-good` `--ghb-warn` `--ghb-bad` | 语义色：成功绿 / 警告黄 / 危险红 |
| `--ghb-bg` `-2` `-3` | 背景三级：最底层 / 次级 / 悬浮层 |
| `--ghb-bd` `-2` | 边框两级（`-2` 更浅，用于分隔线） |
| `--ghb-fg` `-2` `-3` | 文字三级：主文 / 次文 / 弱文 |
| `--ghb-shadow` | 大面板投影（暗色偏黑，浅色偏灰） |

---

## 三、色板 / 排版 / 圆角

**色板**：

| 语义 | 深色 | 浅色 |
|---|---|---|
| 强调 accent | `#2da44e` | `#1a7f37` |
| 成功 good | `#2da44e` | `#2da44e` |
| 警告 warn | `#d29922` | `#9e6a03` |
| 危险 bad | `#f85149` | `#f85149` |
| 背景 bg | `#0d1117` | `#ffffff` |
| 次级 bg-2 | `#161b22` | `#f6f8fa` |
| 悬浮 bg-3 | `#21262d` | `#eaeef2` |
| 边框 bd | `#30363d` | `#d0d7de` |
| 主文 fg | `#e6edf3` | `#1f2328` |
| 次文 fg-2 | `#8b949e` | `#59636e` |

**排版**：字号三档 `13 / 12 / 11px`，行高 `1.5`，字体走宿主系统栈。
**圆角**：小控件 `6px`、复选框 `4px`、胶囊 `999px`、大容器 `14px`。

---

## 四、组件速查

| 组件 | class / id | 关键规格 |
|---|---|---|
| 遮罩 | `#ghb-overlay` | 全屏 `rgba(0,0,0,.5)`，`.2s` 淡入 |
| 面板 | `#ghb-panel` | 居中 `460px`（内容密集时可放宽至 `520px`），`max-h 84vh`，圆角 `14px`，`--ghb-shadow` |
| 面板头 | `.ghb-head` | `24px` 图标 + `15px/600` 标题 + 版本胶囊 `.ghb-ver` |
| Tab | `.ghb-tab` | 等分 `flex:1`，`13px`，激活底边 `2px accent`（`.ghb-on`） |
| 内容区 | `.ghb-body` | 可滚，滚动条 `8px` 圆角 `4px` |
| 按钮 | `.ghb-btn` | `bg-3` 底 + `bd` 边 + 圆角 `6px` + `12px` |
| 主按钮 | `.ghb-btn.ghb-primary` | `accent` 底 `accent-fg` 字 |
| 危险按钮 | `.ghb-btn.ghb-danger` | `hover` 变 `--ghb-bad` 底白字 |
| 图标按钮 | `.ghb-icon-btn` | `28×28` 无边框，`hover` 变 `bg-3` 底 |
| 输入框 | `.ghb-input` | `bg-2` 底 + 圆角 `6px`，聚焦 `accent` 边 |
| 复选框 | `.ghb-cb` | `16×16`，选中 `accent` 底白勾（直角对勾） |
| 开关 | `.ghb-switch` | `40×22` 胶囊，滑块右移 `18px` |
| 列表行 | `.ghb-row` | `hover` 背景 `bg-2` |
| 标签 | `.ghb-tag` | `11px` 胶囊 `999px` + `bd` 描边 |
| 进度条 | `.ghb-bar` | `3×64px`，快/中/慢填充 `good/warn/bad` |
| 设置行 | `.ghb-setting` | 左「标题+说明」，右开关 |
| Toast | `.ghb-toast` | 底部居中，圆角 `8px`，配色 `info/ok/warn/err` |
| 加载旋转 | `.ghb-spin` | `1s linear infinite` |

> 进度条**文字色与填充色分开**定义（`.ghb-t-fast` 文字 / `.ghb-f-fast` 填充），避免标签被染成同色背景。

---

## 五、动效 & 层级

**动效**：

| 场景 | 时长 | 缓动 |
|---|---|---|
| 通用 hover / 小控件 | `.15s` / `.18s` | `ease` |
| 面板 / 弹窗开关 | `.22s` | `cubic-bezier(.4,0,.2,1)` |
| 加载旋转 | `1s linear infinite` | — |

**z-index 阶梯**（统一 `2147483000 + n`，`n` 从 `1` 起；全局同类 UI 不冲突）：

| 层级 | 值 | 元素 |
|---|---|---|
| 1 | `2147483001` | 遮罩 Overlay |
| 2 | `2147483002` | 面板 Panel |
| 3 | `2147483003` | 下载弹窗 DlModal |
| 4 | `2147483004` | Toast |

---

## 六、起手模板（整段复制到新脚本）

```js
const CSS = `
/* ===== 变量 ===== */
html{
  --ghb-accent:#2da44e; --ghb-accent-2:#1a7f37; --ghb-accent-fg:#ffffff;
  --ghb-good:#2da44e; --ghb-warn:#d29922; --ghb-bad:#f85149;
}
html[data-color-mode="light"]{ --ghb-accent:#1a7f37; --ghb-accent-2:#116329; }
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

/* 入口：无启动器、无快捷键 —— 面板仅由 GM_registerMenuCommand 打开，故此处不含 launcher 样式 */

/* ===== 遮罩 / 面板 ===== */
#ghb-overlay{position:fixed; inset:0; z-index:2147483001; background:rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .2s;}
#ghb-overlay.ghb-open{opacity:1; pointer-events:auto;}
#ghb-panel{position:fixed; left:50%; top:50%; z-index:2147483002; width:460px; max-width:calc(100vw - 32px); max-height:84vh;
  background:var(--ghb-bg); border:1px solid var(--ghb-bd); border-radius:14px; box-shadow:var(--ghb-shadow);
  display:flex; flex-direction:column; overflow:hidden; opacity:0; transform:translate(-50%,-46%) scale(.97); pointer-events:none;
  transition:opacity .22s, transform .22s cubic-bezier(.4,0,.2,1);}
#ghb-panel.ghb-open{opacity:1; transform:translate(-50%,-50%) scale(1); pointer-events:auto;}

/* ===== 头部 / Tab / 内容 ===== */
.ghb-head{display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid var(--ghb-bd-2); flex:none;}
.ghb-head h2{margin:0; font-size:15px; font-weight:600; color:var(--ghb-fg);}
.ghb-head .ghb-ver{font-size:11px; color:var(--ghb-fg-2); border:1px solid var(--ghb-bd); border-radius:999px; padding:1px 7px;}
.ghb-tabs{display:flex; border-bottom:1px solid var(--ghb-bd-2); flex:none; background:var(--ghb-bg-2);}
.ghb-tab{flex:1; padding:10px 0; border:none; background:transparent; cursor:pointer; font-family:inherit; font-size:13px;
  color:var(--ghb-fg-2); border-bottom:2px solid transparent; transition:color .15s, background .15s;}
.ghb-tab:hover{color:var(--ghb-fg); background:var(--ghb-bg-3);}
.ghb-tab.ghb-on{color:var(--ghb-fg); font-weight:600; border-bottom-color:var(--ghb-accent);}
.ghb-body{flex:1; overflow-y:auto; min-height:180px;}
.ghb-body::-webkit-scrollbar{width:8px;}
.ghb-body::-webkit-scrollbar-thumb{background:var(--ghb-bd); border-radius:4px;}
.ghb-page{display:none;} .ghb-page.ghb-on{display:block;}

/* ===== 按钮 ===== */
.ghb-btn{display:inline-flex; align-items:center; gap:5px; padding:5px 10px; border:1px solid var(--ghb-bd); border-radius:6px;
  background:var(--ghb-bg-3); color:var(--ghb-fg); font-family:inherit; font-size:12px; cursor:pointer; white-space:nowrap;
  transition:background .15s, border-color .15s, opacity .15s;}
.ghb-btn:hover{background:var(--ghb-bd); border-color:var(--ghb-fg-3);}
.ghb-btn[disabled]{opacity:.5; pointer-events:none;}
.ghb-btn.ghb-primary{background:var(--ghb-accent); border-color:var(--ghb-accent); color:var(--ghb-accent-fg);}
.ghb-btn.ghb-primary:hover{background:var(--ghb-accent-2);}
.ghb-btn.ghb-danger:hover{background:var(--ghb-bad); border-color:var(--ghb-bad); color:#fff;}
.ghb-icon-btn{width:28px; height:28px; display:flex; align-items:center; justify-content:center; border:none; border-radius:6px;
  background:transparent; color:var(--ghb-fg-2); cursor:pointer; font-size:16px; transition:background .15s, color .15s;}
.ghb-icon-btn:hover{background:var(--ghb-bg-3); color:var(--ghb-fg);}
.ghb-spin{animation:ghb-spin 1s linear infinite;}
@keyframes ghb-spin{to{transform:rotate(360deg);}}

/* ===== 表单控件 ===== */
.ghb-input{flex:1; min-width:0; padding:6px 9px; border:1px solid var(--ghb-bd); border-radius:6px; background:var(--ghb-bg-2);
  color:var(--ghb-fg); font-family:inherit; font-size:13px;}
.ghb-input:focus{outline:none; border-color:var(--ghb-accent);}
.ghb-cb{position:relative; width:16px; height:16px; flex:none; cursor:pointer;}
.ghb-cb input{position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; z-index:1;}
.ghb-cb span{display:block; width:16px; height:16px; border:1.5px solid var(--ghb-bd); border-radius:4px; background:var(--ghb-bg);
  transition:background .15s, border-color .15s;}
.ghb-cb input:checked + span{background:var(--ghb-accent); border-color:var(--ghb-accent);}
.ghb-cb input:checked + span::after{content:''; display:block; width:4px; height:8px; margin:1px 0 0 4.5px;
  border:solid #fff; border-width:0 2px 2px 0; transform:rotate(45deg);}
.ghb-switch{position:relative; width:40px; height:22px; flex:none; cursor:pointer;}
.ghb-switch input{position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; z-index:1;}
.ghb-switch i{display:block; width:40px; height:22px; border-radius:11px; background:var(--ghb-bd); transition:background .22s; position:relative;}
.ghb-switch i::after{content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff;
  transition:transform .22s cubic-bezier(.4,0,.2,1);}
.ghb-switch input:checked + i{background:var(--ghb-accent);}
.ghb-switch input:checked + i::after{transform:translateX(18px);}

/* ===== 列表行 / 标签 / 进度条 ===== */
.ghb-row{display:flex; align-items:center; gap:10px; padding:8px 16px; transition:background .12s;}
.ghb-row:hover{background:var(--ghb-bg-2);}
.ghb-tag{font-size:11px; padding:1px 6px; border-radius:999px; border:1px solid var(--ghb-bd); color:var(--ghb-fg-2);}
.ghb-bar{height:3px; width:64px; border-radius:2px; background:var(--ghb-bg-3); overflow:hidden; flex:none;}
.ghb-bar i{display:block; height:100%; border-radius:2px;}
.ghb-t-fast{color:var(--ghb-good);} .ghb-t-mid{color:var(--ghb-warn);} .ghb-t-slow{color:var(--ghb-bad);}
.ghb-f-fast{background:var(--ghb-good);} .ghb-f-mid{background:var(--ghb-warn);} .ghb-f-slow{background:var(--ghb-bad);}

/* ===== Toast ===== */
#ghb-toasts{position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:2147483004; display:flex;
  flex-direction:column; gap:8px; align-items:center; pointer-events:none;}
.ghb-toast{display:flex; align-items:center; gap:8px; max-width:min(560px, calc(100vw - 32px)); padding:9px 14px;
  border-radius:8px; font-family:inherit; font-size:13px; color:#fff; box-shadow:0 6px 20px rgba(0,0,0,.35);
  opacity:0; transform:translateY(12px); transition:opacity .22s, transform .22s;}
.ghb-toast.ghb-show{opacity:1; transform:none;}
.ghb-toast.ghb-info{background:#1f6feb;} .ghb-toast.ghb-ok{background:var(--ghb-good);}
.ghb-toast.ghb-warn{background:#9e6a03;} .ghb-toast.ghb-err{background:#b62324;}
`;
```

---

## 七、口诀

> **颜色只取变量、半径 6 / 14px、字号 13 / 12 / 11、动效 .15 / .18 / .22、层级 2147483000+n（n≥1）。**
> 自有面板用 `ghb-` 自成体系，注入宿主的元素用 `gh-` 复用宿主变量。换前缀即可复刻到任意新脚本。
> **入口进容器、不进浮层：不悬浮、不占快捷键；注入先过决策——零注入也是结论，注入了就按需、就告知状态；管理器菜单永远兜底。**
> **Meta 必带 `@author EFate` / `@license MIT` / `@updateURL` / `@downloadURL`：只改不推 = 用户永远旧版；推完必须 curl 校验线上版本号。**
