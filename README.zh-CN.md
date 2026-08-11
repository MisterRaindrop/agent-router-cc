<div align="center">
  <img src="docs/assets/logo.svg" width="112" alt="router logo"/>

  <h1>router</h1>

  <p><b>最强的模型出判断,最便宜的配额烧 token。</b></p>

  <p>一个 Claude Code 插件,把编码子任务路由到能胜任的最便宜模型 ——
  主会话(Opus)负责规划、复审、验证与合并,便宜的执行器负责写代码。</p>

  <p>
    <a href="https://github.com/MisterRaindrop/agent-router-cc/actions/workflows/ci.yml"><img src="https://github.com/MisterRaindrop/agent-router-cc/actions/workflows/ci.yml/badge.svg" alt="ci"/></a>
    <a href="https://github.com/MisterRaindrop/agent-router-cc/releases"><img src="https://img.shields.io/badge/version-0.8.3-e8a33d" alt="version 0.8.3"/></a>
    <img src="https://img.shields.io/badge/status-beta-d9635f" alt="status beta"/>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-4c7bd9" alt="license Apache-2.0"/></a>
    <img src="https://img.shields.io/badge/node-%E2%89%A5%2018-2f8f5b" alt="node >= 18"/>
    <img src="https://img.shields.io/badge/Claude%20Code-plugin-8a63d2" alt="Claude Code plugin"/>
  </p>

  <p><a href="README.md">English</a> | <b>中文</b></p>
</div>

---

## ✨ 核心想法

一个编码任务里,绝大多数 token 花在机械劳动上 —— 读仓库、写实现、迭代到绿(实测:一个约
400 行的功能,执行侧吃掉 **1.88M 输入 token**)。而真正需要最强模型的部分 —— 规划、复审、
验证、合并 —— 恰恰是**低 token、高判断**的。router 就是沿着这条线把工作切开的:

|                | 直接提示 agent              | 用 router                                                      |
| -------------- | --------------------------- | -------------------------------------------------------------- |
| **谁来执行**   | Opus(贵)                  | 配额更多、更便宜的执行器(codex / sonnet)                     |
| **改动范围**   | 只受提示词约束              | 在 diff 上强制:允许的 glob + 改动行数上限                     |
| **正确性**     | 你手动检查                  | CLI 对 diff 把关(范围 + 密钥 + 可执行位);Opus 在你真实环境跑 build/测试 |
| **……以及偷懒** | 只能相信模型的说辞          | ……**再加上**主会话复审 diff,识别偷懒 / 错误的工作            |
| **改动落在哪** | 立即写进你的工作区          | 隔离 worktree;只有 `land` 时才动你的工作区                    |
| **配额 / 限流**| 运行卡住                    | 按真实剩余配额在 codex 与 claude 间均衡;429 自动切换          |

router **从不自动合并**。各道关卡决定 PASS/FAIL;是否 land 由你决定。

## 💸 省了多少 —— 实测,不是口号

在本仓库自己的开发上实测(20 次真实 dispatch,`router usage --all`):

| | 实际花费 | 若全程用 Opus(估算) | 估算省下 |
|---|---|---|---|
| 20 次 dispatch | **$23.96** | ~$93.34 | **~$69.38(约 74%)** |

这个数字是 **list-price 估算,不是账单** —— 执行器跑在订阅套餐上,真实边际成本往往更低;
`--explain-savings` 会打印全部前提。质量靠机制保证,不靠相信便宜模型:每个 diff 都要过五道
机械门禁、主会话的**整份复审**、真实环境验证、以及报"完成"前的强制全链路 CI —— 验收标准和
Opus 亲自写代码时完全一样。路由档位的实测一次通过率:**89%**(n=9,中位墙钟 3.4 分钟)。

## 🚀 快速开始

**环境要求:** Claude Code · Node.js >= 18 · git · 一个已登录的执行器 CLI
([codex](https://github.com/openai/codex) **或** `claude` —— 订阅套餐即可,**无需 API key**)。

在 Claude Code 中安装:

```
/plugin marketplace add MisterRaindrop/agent-router-cc
/plugin install router@agent-router-cc
/reload-plugins
```

除此之外没有安装步骤、没有配置:`dist/router.js` 是已提交进仓库、无依赖的 bundle,router
首次使用时自动创建被 gitignore 的 `.router/`。**无需 `init`、无策略文件、无需提交。**

然后直接和 Opus 对话,一起把改动规划好:

```
/router:go
```

之后更新:`/plugin marketplace update agent-router-cc`,在 `/plugin` 菜单的 **Installed**
里更新 **router**(或 `claude plugin update router@agent-router-cc`),再 `/reload-plugins`。

## 📐 一次运行的形状

```
日常任务:  和 Opus 对话规划  →  /router:go  →  /router:review(可选)
                               拆包、派发、门禁、   对落地代码的独立、
                               复审、land           严格复审

大型功能(opt-in,由你判断,router 从不猜任务大小):
  /router:design      →  /router:design-review(可选)  →  /router:plan     →  /router:go
  澄清 + 代码调研;        独立模型对抗审核;                怎么做:步骤、      逐字执行
  DESIGN.md 逐节           每条意见由你裁决,               任务拆分、验证;    已批准的计划
  经你确认后批准           绝不自动采纳                     摘要经你批准
```

`/router:go` 只在**三个节点**暂停 —— 没有你,什么都不会发生(执行经 design 流程批准的
Plan 时跳过第 1 个节点:任务清单你已在 `/router:plan` 批准过,不问第二遍):

1. **确认任务分解。**每个工作包的文件范围和目标模型,在任何东西运行前先展示给你。
2. **不清晰的任务留给你。**需要真正判断或设计的部分,Opus 和你一起做,不丢给便宜模型。
3. **合并前先经你批准。**没有你的同意,任何东西都不会 land 进你的分支。

中间每个**明确**的工作包,在隔离 worktree 里由按配额挑选的执行器运行 —— 相互独立的包
**并发**跑,墙钟取最慢的那个而不是求和(实测:26s + 31s 的批次 32s 跑完;234s + 244s 的
批次 244s 跑完)。最后 Opus 做**强制验收**:在你的真实环境跑全链路 CI、自己读完整输出,
通过后才报"完成"。

## 🗂️ 任务契约:tier 和 risk 是两个不同的问题

每个工作包是一份机器契约,位于 `.router/tasks/<id>/task.yaml`,由主会话从你们的对话生成
—— 没有全局策略文件:

```yaml
# .router/tasks/q2/task.yaml
title: usage --json 每次运行只输出一份文档
plan_id: issue-1234
allowed_globs: ["src/app/**", "test/usage-*.test.ts"]
max_changed_lines: 400   # 按真实 diff 的形状定:测试和删除的行数一样计入
tier: weak               # 需要多强的能力:  weak | strong | critical
risk: normal             # 值多少复审:      low  | normal | high(单向:只升不降)
verify: [["npm", "test"]]
depends_on: []
```

| 字段 | 问题 | 决定什么 |
|---|---|---|
| `tier` | 这活需要多强的**能力**? | 挑选模型与推理强度 |
| `risk` | 做错了有**多糟**? | 挑选独立复审的深度 |

对认证路径的机械式改动,是 `weak` **且** `high`。CLI 会依据确定性信号(改动行数、碰到
声明为不变量的路径)把 `risk` 往上调,**绝不调低**;配额永远不会把任务降级到更弱的档位。

## 🤖 模型怎么选

| 档位 | codex | claude |
|---|---|---|
| `weak` | gpt-5.6-terra · medium | haiku · medium |
| `strong` | gpt-5.6-sol · high | sonnet · high |
| `critical` | gpt-5.6-sol · xhigh | opus · xhigh |

1. 先判断任务需要的**最小能力档位** —— 这是唯一重要的路由决定。
2. 同一档位下两个执行器都是候选,按**真实剩余配额**挑(codex 用量读自
   `~/.codex/sessions`,claude 读自可选的 statusline 快照)。余量多的先跑,遇到真实 429
   切到另一个。配额只在档位**内**重排 —— 从不降档。
3. 推理强度跟着活儿走,不拉满:机械实现 `medium`,需要真本事 `high`,`critical` 才给 `xhigh`。
4. 编排器自己的模型**只出现在 `critical` 档** —— 把它当普通执行器用,等于吃掉这套路由
   本来要保护的那份预算。

任何一格都可以在 `.router/models.yaml` 里覆盖;`router models` 打印解析后的结果表。
没有任何东西会替你自动改它。

## 🛡️ 两种门禁

**无环境门禁** —— CLI 对每个 diff 都跑,便宜模型伪造不了的确定性保证:

| 检查 | 含义 |
|---|---|
| `diff_applies` | 能干净地 apply 到基线 commit |
| `scope` | 只改了 `allowed_globs`、没超行数上限、没删测试 |
| `secret_scan` | 新增的行里没有密钥 |
| `exec_bit` | 同目录兄弟脚本都可执行时,新脚本也带可执行位 |
| `verify` | 任务自己的 `verify` 命令退出码为 0 |

`verify` 只回答机械问题 —— **跑了没有、过了没有** —— 从不回答"做对了没有"。

**真实门禁**是项目的属性,在 `.router/gate.yaml` 里声明一次:

- **`mode: worktree`** —— build 和测试在各自的 run worktree 里跑;实现与验证都全并行。
- **`mode: queue`** —— 面向环境**只有一份**的项目(单一构建目录、绑定固定宿主路径的容
  器):执行器并行写代码但**不编译**;`router gate` 拿独占锁把 commit 逐个送进**你自己的
  checkout** —— 有未提交的被跟踪改动就直接拒绝、始终在当前集成分支头上验证、保住构建缓存
  (**绝不 `git clean`**)、最后还原你的分支。门禁失败还会在合并前的头上重跑一次基线,
  本来就红的项目不会被算到这次改动头上。

## ⚔️ design 流程 —— 两份文档,依次批准

大型功能 —— 跨模块、有真正的方案取舍 —— 由你主动敲 `/router:design` 进入。只有
**两份文档**,每份都由你批准:

- **`/router:design` → `DESIGN.md`**(为什么做 / 做什么 / 不做什么 / 方案选择 / 风险 /
  验收标准)。一次只问一个问题,与**代码调研**交错(符号索引、`file:line` 证据);给出
  2–3 个方案和取舍,被否掉的连同原因一起记录;然后**逐节起草**,每节经你确认才写下一节。
  对话没收敛之前不生成任何文档 —— 那正是模型开始胡乱猜测的地方。
- **`/router:design-review`**(可选,轮数由你定)—— **独立模型**攻击 Design:批评逐字
  打印、用你的对话语言书写、每条意见带 `confidence`、对约束不确定必须以问题而非断言的
  形式提出,且 reviewer 必读"备选方案"一节 —— 已被你否掉的路不会被当作新建议再端上来。
  **每条意见由你裁决**(接受 / 拒绝 / 讨论),记入 `DECISIONS.md`;你裁决之前,文档一个
  字都不会被改。后台运行、防截断、跨轮 resume 同一会话。
- **`/router:plan` → `PLAN.md`**(怎么做:步骤、任务拆分、依赖、验证矩阵、发布)——
  只能从已批准的 Design 派生,并绑定其 revision:Design 一改版,Plan 自动降回草稿。
  你批准摘要后,`/router:go` **逐字执行**。日常小任务跳过这一切,直接 `/router:go`。

## 🔍 `/router:review` —— 绿灯之后的最后一关

测试绿是**前提,不是证据** —— 测试本身也是被审对象。两个镜头(最好用两个不同的模型跑),
16 条固定审核维度:

- **架构师镜头(F1–F7):**需求真被解决了吗;该不该存在;复用还是重造;根因还是症状;
  更简单但仍正确;结构与集成;独立正确性判断 —— 不信作者的测试。
- **资深开发镜头(D1–D9):**超出测试的健壮性;失败模式(禁静默 fallback);
  **复杂度/过度设计**("解释比代码还长 = 复杂度伪装成散文");测试设计质量;可读性;
  与项目风格一致;注释与捷径标注;安全;性能常识。

判决拆成**两条轴,从不折叠**:`code_health`(有没有代码缺陷)和 `assurance`(有没有真的
被证明)。"没找到缺陷"不等于"被证明了"。阻塞要挣来 —— 干净的 diff 就直说"可以 ship";
机械项(格式、import 顺序)交给 lint/CI,不浪费 LLM 的判断力。

## 🧰 命令一览

| 命令 | 作用 |
|---|---|
| `/router:go` | **上层命令** —— 执行你们刚商定的方案(或逐字执行已批准的 `PLAN.md`),替你驱动下面的一切 |
| `/router:design` | 大型功能的 opt-in 入口 —— 澄清、调研、逐节起草并批准 `DESIGN.md` |
| `/router:design-review` | 对 Design 的对抗式第二意见 —— 每条意见由你裁决,绝不自动采纳 |
| `/router:plan` | 把已批准的 Design 变成 `PLAN.md` —— 步骤、任务拆分、验证;经你批准 |
| `/router:review` | 对落地代码的独立、严格的双镜头复审 |
| `/router:dispatch <id...>` | 用按配额挑选的执行器并发运行任务,产出已把关的 diff |
| `/router:resume <id>` | 把失败原因送回该任务自己的执行器会话 |
| `/router:land <id...>` | 把 PASSED 的 diff 合并进你的工作分支 |
| `/router:gate <id...>` | 在你自己的 checkout 里逐个验证 commit(queue 模式) |
| `/router:result <id>` | 某次运行的逐项校验报告和日志末尾 |
| `/router:list` | 各任务的最近状态,以及是否还留有 worktree |
| `/router:models` | 解析后的模型档位表(内置默认 + 覆盖) |
| `/router:usage` | 相对"全用最强模型"基线的花费;`--routing` 输出路由证据 |
| `/router:symbol` | 上下文外的符号索引 —— 不读整个文件也能定位代码 |
| `/router:setup-statusline` | 把 claude 侧配额读取接入 Claude Code 的 statusLine |

**[docs/workflow.md](docs/workflow.md)** 是完整的端到端协议 —— 工作包、档位与风险、两种
门禁模式、执行器必须交回什么、什么时候该续会话。另见 **[docs/quickstart.md](docs/quickstart.md)**
和 **[examples/minimal/](examples/minimal/)** 里一个可运行的任务。

## 🔒 隔离与凭据

- 执行器在 `.router/` 下全新的 `git worktree` 中运行,受墙钟超时和停滞看门狗监督;它的
  输出永不进入编排器的上下文,也不继承你会话里的任何 MCP 服务器。
- Codex 使用其 `workspace-write` 沙箱。Claude 运行在普通 `acceptEdits` 模式(绝不用
  `bypassPermissions`),**只有**任务声明了 `verify` 命令才拿到 `Bash` —— 授权是那条
  命令本身加它的"程序 + 子命令"前缀,不是一个 shell。
- 执行器 CLI 只拿到套餐认证所需的登录上下文,外加显式配置的 provider key —— 绝不透传
  完整父环境。
- 每次运行以交付报告收尾(`gate_ran` / `scope_drift` / `escalate_review`);头缺失按
  **合约违规**报出;代码与契约冲突时报 `CONTRACT_CONFLICT`,什么都不提交,决定权回到你手里。

## 🛠️ 开发

```sh
npm ci
npm run check     # tsc --noEmit + core 纯度守卫 + node --test
npm run build     # 打包 src/ -> dist/router.js(把结果提交进仓库)
```

`src/` 按 `domain -> core -> io -> app -> cli` 分层。`core/` 是纯函数(无 fs、
child_process、process、时钟或随机性 —— 由 `npm run check:deps` 强制),这让门禁逻辑
保持确定性、可单元测试。

## 🤝 参与贡献

欢迎贡献 —— 构建、测试和 PR 流程见 **[CONTRIBUTING.md](CONTRIBUTING.md)**,项目方向见
**[ROADMAP.md](ROADMAP.md)**,每个版本的变更见 **[CHANGELOG.md](CHANGELOG.md)**。
安全问题请走 **[SECURITY.md](SECURITY.md)** 的私密渠道,不要发公开 issue。

## 📄 许可证

Apache-2.0。
