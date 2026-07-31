# router

[English](README.md) | **中文**

一个 Claude Code 插件,把编码子任务路由到能胜任的最便宜的模型,从而节省 Opus token。
你用主会话(Opus)做规划,它把方案拆解、将明确的子任务派发给运行在**隔离 git worktree**
里的更便宜的执行器(`codex` 或 `claude` CLI),对每个 diff 做把关(范围 + 密钥 + 可执行位),然后复审
它、并**在你的真实环境里跑 build/测试来验证**;你确认后合并。便宜的模型负责执行,Opus 负责
规划、复审、验证和合并。

> **状态:beta(0.x)。** 1.0 之前命令仍可能变动。

## 用 router 与不用 router

|                | 直接提示 agent              | 用 router                                                      |
| -------------- | --------------------------- | -------------------------------------------------------------- |
| **谁来执行**   | Opus(贵)                  | 配额更多、更便宜的执行器(codex / sonnet)                     |
| **改动范围**   | 只受提示词约束              | 在 diff 上强制:允许的 glob + 改动行数上限                     |
| **正确性**     | 你手动检查                  | CLI 对 diff 把关(范围 + 密钥扫描 + 可执行位);Opus 在你真实环境跑 build/测试 |
| **……以及偷懒** | 只能相信模型的说辞          | ……**再加上**主会话复审 diff,识别偷懒 / 错误的工作            |
| **改动落在哪** | 立即写进你的工作区          | 隔离 worktree;只有 `land` 时才动你的工作区                    |
| **配额 / 限流**| 运行卡住                    | 按真实剩余配额在 codex 与 claude 间均衡;429 自动切换          |

router **从不自动合并**。各道关卡决定 PASS/FAIL;是否 land 由你决定。

## 环境要求

- **Claude Code**
- **Node.js >= 18** 和 **git**
- 一个已登录的执行器 CLI:[codex](https://github.com/openai/codex) **或** `claude`。
  订阅套餐即可 —— **无需 API key**。

无需安装步骤、无需配置:`dist/router.js` 是已提交进仓库、无依赖的 bundle,router
在首次使用时会自动创建一个被 gitignore 的 `.router/`。**无需 `init`、无策略文件、无需提交。**

## 安装

在 Claude Code 中执行:

```
/plugin marketplace add MisterRaindrop/agent-router-cc
/plugin install router@agent-router-cc
/reload-plugins
```

## 更新

router 以一个已提交进仓库、无依赖的 bundle 发布,所以更新只是从 marketplace 拉取最新
版本。先(在 Claude Code 中)从 git 仓库刷新目录:

```
/plugin marketplace update agent-router-cc
```

然后更新已安装的插件——打开 `/plugin` 菜单,在 **Installed** 标签页里更新 **router**,
或者在终端里运行:

```
claude plugin update router@agent-router-cc
```

最后重新加载,让新版本在当前会话中生效:

```
/reload-plugins
```

## 使用

直接和 Opus 对话,一起把改动规划好,然后:

```
/router:go
```

`/router:go` 是**上层命令**——通常你只需要敲这一个。它执行你俩刚商定的方案,并替你
驱动下面所有的底层命令。它只在**三个节点**暂停:

1. **确认任务分解。** Opus 把方案拆成最小的、定义清晰的子任务,在任何东西运行之前,
   先把每个子任务(它的文件范围和目标模型)展示给你。
2. **处理不清晰的任务。** 任何需要真正判断或设计的部分,Opus 会亲自和你一起做,而不是
   丢给便宜的模型。
3. **合并前先经你批准。** 没有你的同意,任何东西都不会 land 进你的分支。

对于中间每个**明确**的任务,工作由两个角色分担:

- **router CLI** 在隔离 worktree 中、用按配额挑选的执行器运行该任务——彼此独立的任务可以
  同时跑,各自一个 worktree——并对产出的 diff 做**快速、无环境的把关**:能否干净地 apply、
  是否停留在允许的文件范围内、有没有泄漏密钥、新增脚本在同目录兄弟都可执行时是否也带了
  可执行位。只有当该任务的契约设置了 `verify` 命令时它才跑 build 或测试,而且答案是机械的:
  *跑了没有、过了没有*,绝不是*做对了没有*。
- 随后 **Opus 读取并复审这个 diff**,识别偷懒或做错的地方——写死的值、空壳或跳过的测试、
  误解的意图(便宜的模型可能一边过了浅层把关、一边做错)。而且**验证归 Opus**:任何有风险的
  改动,它都在**你的**真实环境里亲自跑 build/测试(它有 docker 和完整工具链,沙箱执行器没有),
  读完整输出、自己判断过没过。如果复审干净且低风险,该 worktree 就合并回来、Opus 继续下一个;
  否则用更清晰的契约重新 dispatch,或由 Opus 亲自接手。

到最后,Opus 会做一次**强制验收**——它自己弄清楚这个项目怎么 build 和测试、确认每处改动都被
测试覆盖、并在你的真实环境里跑一遍全链路 CI(自己读完整输出),通过后才报"完成"——并且只在
**经你批准**后才 land。便宜的模型负责执行,Opus 负责规划、复审、验证和合并——这就是省下的 token。

### 底层命令

`/router:go` 会替你驱动这些命令,但你也可以直接运行。每个命令都接受一个 **task id**
——Opus 给子任务起的短名;它的契约位于 `.router/tasks/<id>/task.yaml`。

```
/router:dispatch <id...> # 用按配额挑选的执行器运行这些任务,各自在隔离的 worktree 分支上
                         #   产出一个已机械校验的 diff。传多个 id 会**并发**跑
                         #   (--max-parallel <n> 限制并发数),墙钟取最慢的那个而不是求和
/router:land <id...>     # 把这些任务已校验的 diff 合并进你的工作分支
/router:result <id>      # 显示任务 <id> 的逐项校验报告和日志末尾
```

任务契约(`.router/tasks/<id>/task.yaml`)自带 `allowed_globs`(文件范围)、可选的
`verify` 命令(如 `[["npm","test"]]`),以及可选的 `worker`(用于指定执行器)。这些由
Opus 从你们的对话中生成;没有全局策略文件。

参见 **[docs/quickstart.md](docs/quickstart.md)**,以及
**[examples/minimal/](examples/minimal/)** 中一个可运行的任务。

## 工作原理

- **任务范围化,无策略文件。** 每个任务自带自己的范围和 `verify` 命令;没有全局的
  `policy.yaml`,也不从 git 读取任何东西。执行器默认为 codex + claude。
- **隔离执行。** 执行器在 `.router/` 下一个全新的 `git worktree` 中运行,受墙钟超时和
  停滞看门狗监督;它的输出永不进入编排器的上下文,并且**不会继承你自己会话里的任何 MCP
  服务器**。Codex 使用其 `workspace-write` 沙箱。Claude 拿到 `Read`/`Edit`/`Write`,处于
  普通的 `acceptEdits` 模式(绝不用 `bypassPermissions`);**只有**当任务声明了 `verify`
  命令时才额外拿到 `Bash`,以便它能自证工作。这里要说清楚一件**实测**出来的事:预授权那条
  verify 命令只是免掉提示,**并不会把 Bash 限制在这条命令上** —— 所以这种运行在自己的
  worktree 里是有 shell 的,约束来自那个工作目录和被剥净的环境,而不是这份白名单。
  两者之中 codex 的沙箱更紧;没有 `verify` 的任务完全拿不到 Bash。在你 `land` 之前,
  你的工作区不会被改动。
- **凭据隔离。** 执行器 CLI 只拿到复用套餐认证所需的登录会话 / 网络上下文,外加一个显式
  配置的 provider key——绝不透传完整父环境(里面可能有无关的 `AWS_*`、代理或 API 凭据)。
- **验证由你掌控。** CLI 对每个 diff 做快速、**无环境**的把关(能 apply、在 `allowed_globs`
  内、无密钥)——这是便宜模型伪造不了的确定性保证。真正的 build/测试由主会话(Opus)在**你的**
  真实环境里跑(含 docker):按风险逐任务触发,并且在报"完成"前**必定**跑一遍全链路。Opus 读完整
  输出、自己判断——便宜模型永不给自己下"过/挂"的结论,日志也不会被压缩掉。
- **真实配额均衡。** codex 用量从 `~/.codex/sessions` 读取,claude 用量从 statusline
  快照读取(`statusline/router-usage.mjs`,可选);余量更多的执行器先跑,遇到真实的
  429 则切换到另一个。

## 开发

```sh
npm ci
npm run check     # tsc --noEmit + core 纯度守卫 + node --test
npm run build     # 打包 src/ -> dist/router.js(把结果提交进仓库)
```

`src/` 按 `domain -> core -> io -> app -> cli` 分层。`core/` 是纯函数(无 fs、
child_process、process、时钟或随机性 —— 由 `npm run check:deps` 强制),这让关卡逻辑
保持确定性、可单元测试。

## 许可证

Apache-2.0。
