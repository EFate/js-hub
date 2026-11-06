---
name: js-hub-design-system
description: 为 js-hub 仓库设计、实现和验证油猴脚本：强制「需求边界 → 架构图分层 → 数据结构 → 按图实现 → 全功能测试 → 三件套交付」流程，并提供 UI 视觉规范、注入决策与 Meta 分发要求。用于新建脚本、重构升版、设计架构图、检查入口是否违规、核对 Meta 六件套，或用户说「写个油猴脚本」「按 design-system 规范实现」。
metadata: { "openclaw": { "emoji": "🧩", "requires": { "bins": ["node"] } } }
---

# js-hub 油猴脚本设计系统

js-hub 仓库内一切用户脚本的设计与交付基准：`design-system/` 目录的流程规范与 UI 视觉规范，合并为一个可直接执行的技能。

## 何时使用

- 在 js-hub 仓库**新建**任何油猴脚本
- 对已有脚本做**重构 / 升版 / 大改**（改架构、加层、换入口）
- 用户提到「先设计架构图」「按架构图实现」「按 design-system 规范」「入口规范」「Meta 六件套」
- 需要判断某个入口/按钮该不该存在、该注入还是零注入

## 何时不使用

- 只改文案、改一个选择器、修一个 typo —— 直接改，不必走全流程
- 不在 js-hub 仓库内的脚本（本技能的 raw 地址、目录约定、测试工具路径都绑定本仓库）
- 单纯问「油猴怎么用」这类概念问题

## 示例提示词

- `写一个油猴脚本，把某站点页面里的广告和右栏去掉`
- `按 design-system 规范把这两个脚本合并成一个`
- `先在 architecture-diagram-svg 里画出架构图，再按图实现`
- `检查这个脚本的入口是不是违反悬浮器件禁令、Meta 六件套齐不齐`
- `这个脚本升到 1.1.0，架构图、README、update.md 一起同步`

## 核心铁律（先记住这七条）

1. **主动手前读规范**：本技能的 `references/workflow-spec.md`（流程）与 `references/ui-spec.md`（外观）是唯一依据，不凭记忆。
2. **架构图先行**：先画 `architecture-diagram-svg/<脚本名>-architecture.svg`，再写第一行业务代码；图是实现合同，改实现必须同时改图。
3. **零注入是合法结论**：功能全自动、页面上没有「需要用户点一下」的动作 → 不写任何注入代码，管理器菜单是唯一入口。
4. **禁止悬浮器件与全局快捷键**：圆形悬浮球、胶囊、侧边吸附按钮、可拖拽常驻按钮一律不做；`Esc` 关闭面板是唯一允许的快捷键。
5. **Meta 六件套缺一不算完成**：`@name`、`@namespace js-hub/<目录名>`、`@version`、`@author EFate`、`@license MIT`、`@updateURL` + `@downloadURL`。
6. **只动目标目录**：别窜台，改动只落在目标脚本文件夹与 `architecture-diagram-svg/` 对应图。
7. **测试矩阵一项不省**：语法 → smoke → e2e → 文档核验 → 死代码 → 分发校验，全绿才交付。

## 工作流（七阶段，顺序不可跳）

### 阶段 0 · 需求分析

先查 `.workbuddy/memory/MEMORY.md` 与相关 daily log —— 项目红线、历史事故、各脚本测试基线都在里面，不查会重复踩坑。

再划清「做什么 / 明确不做什么」。识别类逻辑拿不准时**宁可不处理，也不误处理**——把「不处理」写进边界清单，而不是留给运行时猜。

产出：功能边界清单（做什么、不做什么、存疑时怎么处置）。

### 阶段 1 · 建目录

目录名 kebab-case、见名知义（`jump-hub`、`netdisk-hub`、`tieba-enhance`）。建立：

```
<脚本名>/
├── <脚本名>.user.js
├── README.md
├── update.md
└── test/
```

### 阶段 2 · 架构图先行

按 L1-L7 分层模板画 SVG，`viewBox` 宽统一 `680`，标题带版本号。生成后必须校验文字溢出：

```sh
node {baseDir}/scripts/check_svg.js architecture-diagram-svg/<脚本名>-architecture.svg
```

分层模板见 [references/workflow-spec.md](references/workflow-spec.md) 第二节。用户会截图验收，视觉要求精致；`check_svg.js` 有盲区（`rx` 必须是纯数字、批量 Edit 后要 grep 复核）。

### 阶段 3 · 数据结构设计

先表后码：核心状态单一数据源、存储键 `<前缀>.*`、主键去重语义想清楚、UMD 导出对齐测试。字段名要与架构图 L2 层一致，文档核验才能断言「图里的键名 = 代码里的键名」。

### 阶段 4 · 按图实现

- 入口先过**注入决策**三档：零注入 / 按需注入 / 常驻注入（见 [references/ui-spec.md](references/ui-spec.md) 第一节）
- 自有面板用 `ghb-` 前缀自成体系，注入宿主的元素用 `gh-` 前缀复用宿主变量
- 工程红线：批量删代码前先打印区间内所有定义的符号；头部改动后必 grep 复核；`querySelector` 避免 `:has()`；CRLF 文件多行锚点用 `\r\n`

### 阶段 5 · 全功能逐一测试

按 [references/workflow-spec.md](references/workflow-spec.md) 第五节矩阵逐项执行：`node --check` → smoke → e2e（场景隔离）→ 真实 HTML 端到端（识别类必做）→ 文档核验 → 死代码 → 分发校验。

**变异测试是抓假绿的唯一手段**：改完断言后回退修复点，断言必须变红，再还原。假绿五型见 [references/engineering-traps.md](references/engineering-traps.md)。

### 阶段 6 · 交付

```sh
node {baseDir}/scripts/check_svg.js architecture-diagram-svg/<脚本名>-architecture.svg
node <脚本名>/test/test.js
node --check <脚本名>/<脚本名>.user.js
git add <脚本名> architecture-diagram-svg/<脚本名>-architecture.svg
git commit -F .git/COMMIT_MSG
git push origin main
```

推送后**必须**核验线上版本，不能只信本地 `git status`（本仓库 packed-refs 有假 ahead 坑）：

```sh
git ls-remote origin main
```

raw CDN 限流（429 / http=000）时改用 contents API 拉 blob 解码比对 `@version`。

## 交付定义（Definition of Done）

- [ ] 架构图已生成，`check_svg.js` 无文字溢出，标题版本号与 `@version` 一致
- [ ] 脚本 Meta 六件套齐全，`@author EFate`、`@license MIT`、updateURL/downloadURL 同址
- [ ] 入口决策有明确结论，且无悬浮器件、无全局快捷键（面板 Esc 除外）
- [ ] `test/` 下 smoke + e2e 全绿，断言数为可复述的具体数字
- [ ] 变异测试多项被捕获，还原后全绿
- [ ] README 为纯功能文档：无版本号小标题、无规范引用、无内部标识符，文末 `## Author` 段
- [ ] update.md 有本版记录，测试数字与 README / 核验脚本三处一致
- [ ] 死代码扫描：顶层符号仅出现一次的数量为 0（或逐个说明）
- [ ] 已 push，`ls-remote` 对照本地 HEAD 一致，线上 `@version` 已核验

## 资源

- 流程 / 分层 / 数据结构 / 测试矩阵 / 交付清单：[references/workflow-spec.md](references/workflow-spec.md)
- UI 视觉规范（两套模式、变量体系、入口注入决策、Meta 分发）：[references/ui-spec.md](references/ui-spec.md)
- 工程红线与历史事故、假绿五型：[references/engineering-traps.md](references/engineering-traps.md)
- 架构图文字溢出校验器：`scripts/check_svg.js`
