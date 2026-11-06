# 油猴脚本设计与实现流程规范（Design Workflow）

> 本文件管「**怎么设计、怎么实现、怎么验证**」；同目录 `ghb-ui-spec.md` 管「**长什么样**」（UI 视觉规范）。
> 两者共同构成本仓库新脚本的完整设计依据。配套技能入口：`.workbuddy/skills/js-hub-script-design/SKILL.md`。

---

## 一、流程总览（七阶段，顺序不可跳、不可倒）

```
需求分析 → 建目录 → 架构图（分层）→ 数据结构 → 按图实现 → 全功能测试 → 交付
```

| # | 阶段 | 产出 | 铁律 |
|---|---|---|---|
| 0 | **需求分析** | 功能边界清单 | 划清「做什么 / 明确不做什么」；**准确优先，歧义不动**——识别类逻辑拿不准的宁可不处理，也不误处理 |
| 1 | **建目录** | `<脚本名>/` | 目录名 kebab-case、见名知义（如 `jump-hub`、`netdisk-hub`、`ad-bllocker`）；**别窜台**：改动只落在目标脚本文件夹内 |
| 2 | **架构图先行** | `architecture-diagram-svg/<脚本名>-architecture.svg` | **先画图后写码**，架构图是实现合同 |
| 3 | **数据结构设计** | 结构图 + 字段表 | 先定数据结构再写逻辑（见第三节） |
| 4 | **按图实现** | `<脚本名>/<脚本名>.user.js` | 实现与图不一致 = 图或代码必须改一个，不允许静默漂移 |
| 5 | **全功能逐一测试** | test/ + 核验脚本 | 见第五节测试矩阵，**一项都不能省** |
| 6 | **交付** | 三件套齐全 + 入库 | 见第六节交付清单；commit + push + 线上版本校验 |

---

## 二、架构图分层约定（L1…Ln）

### 2.1 分层模板

参考 `github-accelerate` 的 L1-L7 实践。新脚本按复杂度取用，**每层单一职责**，层数可增删但不可混装：

| 层 | 职责 | 典型内容 |
|---|---|---|
| L1 | 配置 / Meta 层 | UserScript 头、常量、站点规则表 |
| L2 | 数据结构层 | 状态对象、存储键、核心数据模型 |
| L3 | 识别 / 解析层 | 目标识别、参数解析、解码 |
| L4 | 核心逻辑层 | 决策、调度、算法主干 |
| L5 | 执行 / 交互层 | DOM 改写、点击接管、动作执行 |
| L6 | UI 层 | 面板、设置、提示（样式遵循 ghb-ui-spec） |
| L7 | Watcher 层 | **唯一的** DOM / 路由监听者（MutationObserver / 路由钩子只在这里出现，其余层只消费它的事件） |

> 分层判据：任何一层被替换，其余层不应需要理解它的内部实现。监听类代码若散落多层 = 分层失败，必须收拢到 Watcher 层。

### 2.2 架构图规范

- 位置：仓库根 `architecture-diagram-svg/<脚本名>-architecture.svg`，全部脚本的架构图统一放这一个目录
- viewBox 宽统一 `680`，标题带版本号（升版时同步更新图）
- 生成后用 `.tmp/check_svg.js <svg>` 校验文字溢出（CJK 1em / 拉丁 0.55em / 空白 0.28em 估算）
- 绘制阶段配合 **diagram-builder** 技能（SVG / Mermaid 两种产出方式）
- 升版时架构图必须与代码同步更新，由 `.tmp/verify-docs.js` 的「架构图含 XX」类断言锁住关键结构

---

## 三、数据结构设计要求

**先表后码**：写第一行业务代码之前，先在架构图旁列出核心数据结构。

1. **核心状态单一数据源**——如设置对象 `OPT`、结果池、任务队列，各自只有一个定义点与一条读写路径；禁止两处各自维护同名状态
2. **存储键命名约定**——`<前缀>.*`（如 `bl.*`、`jh.*`）；旧键升级走迁移表（`LEGACY_*_KEYS`），迁移后丢弃，不长期兼容
3. **主键设计先想清楚去重语义**——如直链池以「文件名」而非 URL 为主键（URL 每次签名都变）；主键选错 = 静默重复或误覆盖
4. **模块导出对齐测试**——核心逻辑用 UMD 导出，让测试 `require` 真实代码而非复制品
5. **数据结构画进架构图 L2 层**——字段名与代码一致，verify-docs 可断言「图中的键名 = 代码中的键名」

---

## 四、实现纪律

1. **架构图是合同**——按图实现；实现中发现图有错，先改图并说明，再改码
2. **Meta 硬性项（六件，缺一不算完成）**——`@name`、`@namespace js-hub/<目录名>`、`@version`、`@author EFate`、`@license MIT`、`@updateURL` / `@downloadURL` 指向本仓库 raw 地址（详见 ghb-ui-spec 一·五节）：

   ```js
   // ==UserScript==
   // @name         脚本中文名
   // @namespace    js-hub/<目录名>
   // @version      x.y.z
   // @description  一句话说清功能
   // @author       EFate
   // @license      MIT
   // @updateURL    https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/<目录名>/<脚本名>.user.js
   // @downloadURL  https://raw.githubusercontent.com/EFate/js-hub/refs/heads/main/<目录名>/<脚本名>.user.js
   // ==/UserScript==
   ```
3. **入口先过注入决策**——零注入 / 按需注入 / 常驻注入三档（详见 ghb-ui-spec 第一节「注入决策」）；判为零注入的脚本不写注入代码、不配入口设置
4. **工程红线**（历史事故固化，违反必翻车）：
   - 批量删代码前**必须先打印区间内所有定义的符号**（曾吞掉无干系函数静默失效）
   - Edit 工具对文件头部编辑偶发静默失败——**头部改动后必须 grep 复核**
   - CRLF 文件里多行锚点用 `\r\n` 拼接；补丁一律「锚点未命中即报错退出、不写文件」
   - `querySelector` 避免 `:has()`（旧内核抛异常）
   - 识别类脚本改动必须过**真实 HTML 端到端**，纯函数冒烟不够
5. **代码审查阶段**配合 **dev-expert** 技能（P8 全栈专家：代码审查 / 重构 / 根因调试纪律）

---

## 五、测试矩阵（全功能逐一验证，一项不省）

| 顺序 | 手段 | 覆盖 | 通过标准 |
|---|---|---|---|
| 1 | `node --check` | 语法 | 零错误 |
| 2 | **smoke**（纯函数冒烟） | 每个导出函数 + 关键内部判据 | 100% 通过；组内含护栏断言（数量、键名、禁用 API 残留） |
| 3 | **e2e**（jsdom 场景） | 用户可见行为逐场景 | 100% 通过；每场景 boot 隔离（`window.close()`），防延迟回调跨场景串扰 |
| 4 | **真实页面端到端** | 识别类脚本必做 | curl 抓真实 HTML（403 则补 Referer/Sec-Fetch 头）→ JSDOM 加载 + 挂 global → require 真实脚本 → 断言最终行为（如「浏览器最终去哪」） |
| 5 | `.tmp/verify-docs.js` | 文档 ↔ 代码一致性 | 版本、计数、阈值、键名、UI 残留、架构图关键结构全部断言 |
| 6 | `.tmp/deadcode-*.js` | 死代码 | 「定义了但全文只出现一次」的顶层符号 = 0（或逐个确认合理） |
| 7 | 分发校验 | 线上 | push 后 `ls-remote origin main` 对照本地 HEAD（本仓库 packed-refs 可能假 ahead，别只信 status）；curl 校验线上 `@version` |

测试文件放 `<脚本名>/test/`（.gitignore 已排除测试目录，不入库但必须存在且全绿）。测试纪律细节配合 **superpowers** 技能（TDD / 回归流程）。

---

## 六、交付物清单（三件套 + 一图 + 测试）

```
<脚本名>/                     ← 目录名 kebab-case，按需求命名
├── <脚本名>.user.js          ← 脚本本体（Meta 六件套：name/namespace/version/author=EFate/license=MIT/updateURL+downloadURL）
├── README.md                ← 纯功能文档：只说功能、用法、设置、限制、隐私
│                               ✗ 不写版本号小标题 ✗ 不引用设计规范 ✗ 不写内部标识符
│                               文末分隔线 + 「## Author」段（**EFate**）
├── update.md                ← 每版一段变更记录（含测试数字）
└── test/                    ← smoke / e2e / fixtures（真实 HTML 固件）

architecture-diagram-svg/
└── <脚本名>-architecture.svg ← 架构图（与代码同步升版）
```

- README 的「纯功能文档」裁决见 `.tmp/verify-docs.js` 断言，改完必跑
- 交付前最终自检 = 第五节矩阵全部通过

---

## 七、协作技能映射

| 阶段 | 用哪个技能 |
|---|---|
| 阶段 2 架构图绘制 | `diagram-builder`（SVG / Mermaid） |
| 阶段 4 实现与代码审查 | `dev-expert`（P8 全栈：审查 / 重构 / 根因调试） |
| 阶段 5 测试纪律 | `superpowers`（TDD / 回归 / 子代理开发流程） |
| L6 UI 层样式 | `ghb-ui-spec.md`（本目录 UI 视觉规范） |
| 流程入口 | `js-hub-script-design` 技能（本规范的技能化封装） |
