# router

[English](README.md) | **中文**

一个 Claude Code 插件,把编码子任务路由到能胜任的最便宜的模型,从而节省 Opus token。
你用主会话(Opus)做规划,它把方案拆解、将明确的子任务派发给运行在**隔离 git worktree**
里的更便宜的执行器(`codex` 或 `claude` CLI),对每个 diff 做机械校验并复审;你确认后合并。
便宜的模型负责执行,Opus 只做规划、复审和合并。

> **状态:beta(0.x)。** 1.0 之前命令仍可能变动。

## 用 router 与不用 router

|                | 直接提示 agent              | 用 router                                                      |
| -------------- | --------------------------- | -------------------------------------------------------------- |
| **谁来执行**   | Opus(贵)                  | 配额更多、更便宜的执行器(codex / sonnet)                     |
| **改动范围**   | 只受提示词约束              | 在 diff 上强制:允许的 glob + 改动行数上限                     |
| **正确性**     | 你手动检查                  | 机械校验(你的 `verify` 命令 + 范围 + 密钥扫描)……            |
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

- **router CLI** 在隔离 worktree 中、用按配额挑选的执行器运行该任务,并对产出的 diff
  做**机械校验**——正是这一步在跑你的测试(任务的 `verify` 命令),检查 diff 是否停留在
  允许的文件范围内,并扫描是否泄漏密钥。
- 随后 **Opus 读取并复审这个 diff**,识别偷懒或做错的地方——写死的值、跳过的用例、
  误解的意图(便宜的模型可能一边通过测试、一边做错)。**Opus 自己并不跑测试**,那是上面
  CLI 的活儿。如果复审没问题,该任务的 worktree 就被合并回你的分支,Opus 继续下一个任务;
  如果有问题,就用更清晰的契约重新 dispatch,或由 Opus 亲自接手。

到最后,Opus 会对合并后的整体结果做一次统一验收,并且只在**经你批准**后才 land。便宜的
模型负责执行,Opus 只做规划、复审和合并——这就是省下的 token。

### 底层命令

`/router:go` 会替你驱动这些命令,但你也可以直接运行。每个命令都接受一个 **task id**
——Opus 给子任务起的短名;它的契约位于 `.router/tasks/<id>/task.yaml`。

```
/router:dispatch <id>   # 用按配额挑选的执行器把任务 <id> 运行一次,在隔离的 worktree
                        #   分支上产出一个已机械校验的 diff
/router:land <id>       # 把任务 <id> 已校验的 diff 合并进你的工作分支
/router:result <id>     # 显示任务 <id> 的逐项校验报告和日志末尾
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
  停滞看门狗监督;它的输出永不进入编排器的上下文。Codex 使用其 `workspace-write` 沙箱。
  Claude 只拿到 `Read`/`Edit`/`Write` 工具,处于普通的 `acceptEdits` 模式(没有 Bash,
  也没有 `bypassPermissions`),因此 worktree 之外的访问会被拒绝。在你 `land` 之前,
  你的工作区不会被改动。
- **凭据隔离。** 执行器 CLI 只拿到复用套餐认证所需的登录会话 / 网络上下文,外加一个显式
  配置的 provider key。由仓库控制的 `verify` 命令则运行在独立的最小环境中,永不继承
  provider key、代理凭据或登录会话元数据。
- **双重校验。** 机械校验(确定性):diff 必须能 apply、停留在 `allowed_globs` 内、
  不泄漏密钥,并通过任务的 `verify` 命令。语义校验:随后主会话(Opus)复审 diff,
  以识别便宜模型的偷懒或错误。
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
