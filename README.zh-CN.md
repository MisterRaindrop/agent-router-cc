<div align="center">
  <img src="docs/assets/logo.svg" width="112" alt="router logo"/>

  <h1>router</h1>

  <p><b>写之前把设计想清楚,写之后把它证明出来。</b></p>

  <p>一个让 Claude Code 更有纪律地写代码的插件 —— 动手前把设计定下来,按人审得过来的
  提交粒度写,在你的真实环境里验证,再让另一个模型来挑刺。</p>

  <p>
    <a href="https://github.com/MisterRaindrop/agent-router-cc/actions/workflows/ci.yml"><img src="https://github.com/MisterRaindrop/agent-router-cc/actions/workflows/ci.yml/badge.svg" alt="ci"/></a>
    <a href="https://github.com/MisterRaindrop/agent-router-cc/releases"><img src="https://img.shields.io/github/package-json/v/MisterRaindrop/agent-router-cc?label=version&color=e8a33d" alt="version"/></a>
    <img src="https://img.shields.io/badge/status-beta-d9635f" alt="status beta"/>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-4c7bd9" alt="license Apache-2.0"/></a>
    <img src="https://img.shields.io/badge/node-%E2%89%A5%2018-2f8f5b" alt="node >= 18"/>
    <img src="https://img.shields.io/badge/Claude%20Code-plugin-8a63d2" alt="Claude Code plugin"/>
  </p>

  <p><a href="README.md">English</a> | <b>中文</b></p>
</div>

---

## ✨ 核心想法

直接让 agent "把这个做了",出问题的地方是可以预料的:没讨论过的细节它靠猜;所有改动揉成一个
没人审得动的提交;测试测错了东西也照样绿,它就宣布完成;最后还用自己的盲点审自己写的代码。
router 在每一个这样的位置放一道关,除了兜底那一道,全部 opt-in:

|                  | 直接给 agent 下指令            | 用 router                                                   |
| ---------------- | ------------------------------ | ----------------------------------------------------------- |
| **写之前**       | 模型猜你的意思                 | `brainstorm` 先质疑这个想法;`design` 逐节定下来,每节你批准 |
| **设计本身**     | 由写它的模型自己审             | `design-review`:另一个模型来攻击,每条意见你裁决           |
| **怎么拆**       | 模型想怎么做就怎么做           | 动手前商定一次:分成哪几个功能单元、各动哪些文件、各自怎么验 |
| **提交**         | 一个大 diff                    | 一个功能单元一个提交,各自带测试                            |
| **"做完了"**     | 模型说了算                     | 主会话通读完整 diff,按 CI 的方式在你的真实环境跑完整构建   |
| **写之后**       | 相信作者自己的测试             | `review`:另一个模型的两个镜头;测试本身也在被审之列        |

router **从不合并**。落不落地由你决定。

## 🚀 快速开始

**环境要求:** Claude Code · Node.js >= 18 · git。可选:已登录的
[codex](https://github.com/openai/codex) CLI(订阅套餐即可,**无需 API key**)—— 用作独立审核者,
以及你点名时的第二个写手。

在 Claude Code 中安装:

```
/plugin marketplace add MisterRaindrop/agent-router-cc
/plugin install router@agent-router-cc
/reload-plugins
```

除此之外没有安装步骤、没有配置:`dist/router.js` 是已提交进仓库、无依赖的 bundle,router
首次使用时自动创建被 gitignore 的 `.router/`。**无需 `init`、无策略文件、无需提交。**

然后和主会话把改动聊清楚:

```
/router:go
```

### 在另一台机器上,或者在脚本里

同样两步,不用打开 Claude Code。仓库是公开的,不需要 SSH key,也不需要 `gh` 登录:

```bash
claude plugin marketplace add MisterRaindrop/agent-router-cc
claude plugin install router@agent-router-cc -y      # 非 TTY(脚本里)时 -y 是必需的
```

重启 Claude Code 生效,然后确认装进去的是什么:

```bash
claude plugin list | grep -A3 router     # → 版本、scope、Status: ✔ enabled
```

### 更新

```bash
claude plugin marketplace update agent-router-cc     # 先刷 marketplace 缓存
claude plugin update router@agent-router-cc
```

在 Claude Code 里的等价操作:`/plugin marketplace update agent-router-cc`,在 `/plugin` 菜单的
**Installed** 里更新 **router**,再 `/reload-plugins`。

命令文件(`commands/`、`skills/`、`hooks/`)只在启动时读一次,所以改到它们的版本必须重启;
CLI bundle 不用 —— `dist/router.js` 每次调用都是新起进程。

## 📐 一次运行的形状

```
日常任务:  把改动聊清楚  →  /router:go  →  /router:review(可选)
                             拆法确认一次;      另一个模型做的
                             写、提交、验证      独立严格复审

大型功能(opt-in,由你判断,router 从不猜任务大小):
  /router:brainstorm  →  /router:design  →  /router:design-review(可选)  →  /router:go
  目标还没定时先质疑;     澄清 + 代码调研;    独立模型对抗审核;               按已批准的
  比较别人怎么解、        一份 DESIGN.md      每条意见由你裁决,              DESIGN.md 实现
  论证不该做、            逐节经你确认        绝不自动采纳
  提出你没被给过的选项
```

`/router:go` 只在**三个节点**暂停 —— 没有你,什么都不会发生:

1. **确认拆法**,整个功能只问一次:要提交哪几个功能单元、各动哪些文件、各自怎么验证。这是一次
   **对话**:不写盘、不批准进文档。
2. **不清晰的部分留给你。**需要计划里没做过的判断的,先和你定下来再写。
3. **合并前交还给你。**它通读自己的完整 diff,**按你的 CI 的调用方式、不为了跑通去改环境**,在你的
   真实环境跑完整构建,并如实说明哪些没跑。这是兜底;`/router:review` 是下一关。

## ✍️ 让 codex 写其中一部分

你说一句"这部分让 codex 写",那部分就交给 codex,而不是主会话自己写:`router write` 在你当前的
分支上、在 codex 的 `workspace-write` 沙箱里启动它,交给它一份主会话写好的 brief;`router resume`
把反馈发回**同一个**会话,让它不用重新读一遍仓库。主会话审它的提交,和审自己写的一模一样 ——
写手的报告只是声明,不是证据。

这是唯一保留下来的委派。0.15.0 之前,router 把**每一个**工作包都派给单独的执行器:按剩余配额挑
模型、全程持锁、diff 上过一组机械门禁。它被删掉,是因为这个项目自己的记录说明了缺陷到底是在哪
被抓到的 —— 主会话通读 diff、主会话跑真实构建、独立审核 —— 没有一样依赖"换个进程来写"。详见
`DEPRECATIONS.md`。

## ⚔️ design 流程 —— 一份文档,逐节批准

大型功能 —— 跨模块、有真正的方案取舍 —— 由你主动进入:

- **`/router:brainstorm` → `BRAINSTORM.md`**(可选的第一段,用于**目标本身还没定**的时候)。每一轮
  都欠你四样东西:一个你没想过的角度问"为什么";别的产品实际怎么解决这件事;**最有力的"根本不
  该做"的论证**;至少一个你没提过的方案。`status: rejected` 是真实的结果 —— 一个带着理由被否掉的
  想法,正是这一段成功了。
- **`/router:design` → `DESIGN.md`**(为什么做 / 做什么 / 不做什么 / 方案选择 / 风险 / 验收标准 /
  验证矩阵)。一次只问一个问题,与**代码调研**交错(符号索引、`file:line` 证据);给出 2–3 个方案
  和取舍,被否掉的连同原因一起记录;然后**逐节起草**,每节经你确认才写下一节。对话没收敛之前不生成
  任何文档 —— 那正是模型开始胡乱猜测的地方。
- **`/router:design-review`**(可选,轮数由你定)—— **独立模型**攻击 Design:批评逐字打印、用你的
  对话语言书写、每条意见带 `confidence`,且 reviewer 必读"备选方案"一节 —— 已被你否掉的路不会被当作
  新建议再端上来。**每条意见由你裁决**(接受 / 拒绝 / 讨论),记入 `DECISIONS.md`;你裁决之前,文档
  一个字都不会被改。

`DESIGN.md` 的最后一节是**验证矩阵**:每条验收标准映射到它究竟在哪被证明,`unverified` 保持可见,
而不是拿一个证明不了它的测试糊过去。没有单独的工作计划,拆法在 `/router:go` 里商定。

日常小任务跳过这一切,直接 `/router:go`。

## 🗺️ `/router:explain` —— 用系统视角阅读已经完成的功能

代码完成后，运行 `/router:explain <commit>`（也可以传入明确的范围或 `--working-tree`），
Router 会在 `.router/explanations/` 下生成一份可以直接打开的设计页面。开头直接给结论；
一张完整设计图同时说明功能处在系统什么位置，以及它靠哪条路径工作。必要的执行顺序直接
标在这张图上，不再重复画第二张流程图；只有证据会改变结论时，页面才增加问题提示。

它不是 PR 文件摘要，也不是实现前的 `DESIGN.md`。它解释代码最终形成了什么系统，读者
不需要再从文件清单里反推设计。

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
| `/router:go` | **上层命令** —— 实现你们刚商定的改动(有已批准的 `DESIGN.md` 时按它来):拆法确认一次、一个功能单元一个提交、在真实环境验证、合并前交还给你 |
| `/router:brainstorm` | 设计之前先质疑这个想法 —— 比较别人怎么解、论证不该做、提出你没被给过的选项 |
| `/router:design` | 大型功能的 opt-in 入口 —— 澄清、调研、逐节起草并批准 `DESIGN.md` |
| `/router:design-review` | 对 Design 的对抗式第二意见 —— 每条意见由你裁决,绝不自动采纳 |
| `/router:review` | 对改动的独立、严格的双镜头复审 |
| `/router:explain [范围]` | 用简短结论和一张完整设计图解释已经完成的代码;接受 commit、Git 范围或 `--working-tree` |
| `/router:resume <id>` | 把反馈发回某次 codex 写手的同一个会话 |
| `/router:symbol` | 上下文外的符号索引 —— 不读整个文件也能定位代码 |

背后的 CLI:`router write` / `resume`(codex 写手)、`router plans`(每个计划及其阶段)、
`router models`(写手和审核用的模型)、`router symbol`、`router doctor`、`router supervise`。插件
不会把 `router` 放进 `PATH` —— 一行 alias 见 [docs/quickstart.md](docs/quickstart.md#the-cli),或者
直接让主会话帮你跑。

**[docs/workflow.md](docs/workflow.md)** 是完整的端到端协议。

## 🔒 codex 写手的边界

- **只在干净的工作区里启动。**有未提交的改动,`router write` 就拒绝;它从不替你提交、stash 或挪动
  你的改动。
- **在你当前的分支上提交**,并被要求不得 merge、rebase、push 或改写历史。resume 时只要不在原来那个
  分支上就拒绝。
- **codex 的 `workspace-write` 沙箱**:能在 checkout 里改文件、提交,碰不到外面。
- **最小环境**:只给套餐认证需要的登录上下文,绝不透传完整父环境 —— 无关的凭据(`AWS_*`、token)
  到不了它手里。
- **它驱动不了 router。**嵌套调用的 `router` 只要是写操作就直接拒绝,所以写手没法再往同一个
  checkout 里启动第二个写手。
- **受监管**:墙钟超时 + 停滞看门狗,退出时杀掉整个进程组;输出写到 `.router/writes/<id>/codex.log`,
  从不进入你会话的上下文。
- **没接上的 resume 会直说。**codex 报回的会话不一样 —— 或者根本没报 —— 就标 `RESUME DID NOT
  RE-ATTACH`,按一次全新的运行对待,而不是当作续接。

## 🛠️ 开发

```sh
npm ci
npm run check     # tsc --noEmit + core 纯度守卫 + node --test
npm run build     # 打包 src/ -> dist/router.js(把结果提交进仓库)
```

`src/` 按 `domain -> core -> io -> app -> cli` 分层。`core/` 是纯函数(无 fs、
child_process、process、时钟或随机性 —— 由 `npm run check:deps` 强制),这让这部分逻辑
保持确定性、可单元测试。

## 🤝 参与贡献

欢迎贡献 —— 构建、测试和 PR 流程见 **[CONTRIBUTING.md](CONTRIBUTING.md)**,项目方向见
**[ROADMAP.md](ROADMAP.md)**,每个版本的变更见 **[CHANGELOG.md](CHANGELOG.md)**。
安全问题请走 **[SECURITY.md](SECURITY.md)** 的私密渠道,不要发公开 issue。

## 📄 许可证

Apache-2.0。
