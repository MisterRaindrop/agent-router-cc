# Router 设计方案:`spec` + `go` + `review`(v3.1)

> 状态:草案(未提交,供审阅)。只描述设计与用法,不含实现代码。
> v3.1 相对 v3:`review` 改成**两层审核(宏观/功能 + diff 级)**;改掉「review 不管功能对错」的错误框架(测试绿 ≠ 功能对);维度按 Google 工程实践 + ponytail 补齐。
> 一以贯之:`spec` 审方案;reviewer 持久 resume;裁决权在人;任务拆分在 `go`;验证在主环境末尾统一跑;可见性规则。

---

## 1. 定位与三条硬规则

Router 是一个**串行任务编排器**,不是「省巨量 token 的魔法」,也不做双脑/顾问自动化。价值:先**把方案敲对(带独立第二意见)**,再**拆解 + 执行**,最后**对代码做资深开发对抗审核**;机械活走便宜模型,判断活留强模型,验证由编排者在真实环境串行兜底。

三条硬规则(贯穿全文):
1. **判断在强模型,机械给便宜模型,验证在编排者。**
2. **验证只能在主环境串行做**(唯一的 Docker/DB/编译环境)。executor 在 worktree 里只**改**,不**验**。
3. **CLI 保持薄**:只做机制;**智力全在提示词剧本里**;凡「需要判断对错」的裁决,交给**人**。

三个命令,顺序对应人真实的工作流:

- **`router spec`** —— 动手前把**方案**敲对:人驱动、针对方案合理性的对抗审核。
- **`router go`** —— **拆解并执行**已批准的方案 + 末尾统一验证。
- **`router review`** —— 测试绿之后,对**代码**做人驱动的**资深开发对抗审核**(功能正确性 + 代码质量,两层)。

`spec` 与 `review` 是**同一套机制**(人驱动、跨模型独立 reviewer、持久 resume、批评可见、人裁决),只是对象一个是 plan、一个是 diff。

---

## 2. 命令一:`router spec` —— 方案对抗审核(人驱动)

### 2.1 它审什么
审**方案 / 实现本身的合理性**,不是任务怎么拆:方案对不对?有无**隐藏风险**?是否**优雅、可维护、合工程规范**?**有没有更好/更简单的路子**?
> 「任务怎么拆」不在这审——那是执行细节,主会话智能够用,不值得动用独立模型(见 §3)。

### 2.2 reviewer:独立大脑 + 持久 resume 会话
- 独立于作者(Claude)的大脑(如 Codex),保证第二视角、不同盲区。
- **一个持久会话,每轮 resume**:首轮喂完整 plan;之后只发**变更**,它带着上一轮 objection 记忆继续审,能追问「第 2 条解决没」。**省 token、不重塞上下文**。
- resume 的是它自己(Codex),**始终独立于 Claude**。

### 2.3 裁决权在人,`spec` 不拥有循环
- **裁决权 = 你**(reviewer 也会错,一致 ≠ 正确)。
- **没有自动收敛**;你想审几轮审几轮,满意就冻结。
- **修改在主会话(你 ↔ Claude)里做**;`router spec` 只负责「拉独立大脑给出/续写批评并摊给你看」。

### 2.4 可见性(硬要求)
你要判断的**就是那份批评**,所以 reviewer 的**批评 + 理由必须打印/落文件**。(GPT 推理模型只给推理摘要、无原始 CoT;对审核够用。)

### 2.5 产物
一份**人批准的 PLAN**:方案 + **风险点** + **plan 级 DoD**(= `go` 末尾统一跑的 build+test)。冻结后交 `go`。**PLAN 不含任务拆分**。

### 2.6 用法回路
```
1. 你 ↔ Claude 聊出 v1 plan
2. router spec       # 首轮:启独立 reviewer,喂 plan,打印批评
3. 你判断哪些成立 → 让 Claude 改 → v2
4. router spec       # 次轮:resume 同一 reviewer,只发变更,打印新批评
5. 重复到你满意 → 冻结 PLAN
```

---

## 3. 命令二:`router go` —— 拆分 + 执行,末尾统一验证

拿冻结 PLAN,**主会话自己拆任务**(不对抗、不用 Codex),排序逐个执行;**完整 build+test 在所有任务合并完之后统一跑一次。**

### 3.1 拆分:每个任务「谁来做」
每个任务标 `worker`:
- **判断活** → `worker: main`:主会话 inline 做。
- **机械活** → `worker: { kind: codex|claude, model: ... }`:派便宜模型。

判据(四条):
- **压缩比高** = 产出 ÷ 说清所需字数;高(短指令→大产出)才值得派;spec≈产出→留 `main`。
- **可验证性** = 能写出客观可自动判的「做对了」检查;写不出别派。
- **独立性** = 只碰一小撮文件、耦合少。
- **少而批(★ 单环境独有)** = 别拆碎;相关机械改动合成一个任务(验证贵且串行,任务越少末尾越省)。

每任务落成 `task.yaml`(`id / goal / worker / allowed_globs / order`)。**无 per-task build 验收**,真正验收在末尾(§3.3)。

### 3.2 执行循环(串行,按 order)
```
for task in 有序任务:
  if task.worker == main:
      主会话 inline 完成 → 提交进主代码
  else:  # 机械活
      dispatch → executor 在独立 worktree 改 → 出 diff
      主会话 review diff:
        通过 → 合并进主代码(提交)      ← 只要 review 过就合并,不等 build
        不过 → resume 该 executor 带反馈重跑(会话+worktree 留着;小错继承、大错冷启动;熔断到 N 判死)
  (可选)跑免费轻检查:grep/lint

# ── 所有任务合并完之后 ──
主环境统一跑一次完整 build + test(= PLAN 的 DoD)
  绿 → 完成;红 → 在已合并的各 task 提交里 bisect/回退
```

### 3.3 为什么验证放末尾
重环境很贵、每 task 跑受不了;每 task 的**主会话 review 是便宜判断闸**先挡明显错;真正 build+test 末尾统一一次。代价:末尾失败要在已合并改动里定位——但每 task 一个提交,可 bisect,可控。**单环境下的正确取舍。**

### 3.4 任务身份与隔离
- 唯一 **task id**(`.router/tasks/<id>/`),各自 `task.yaml` 独立,不冲突。
- 每次 dispatch 在**独立 worktree**(`.router/worktrees/<id>/run-N`)改,并行编辑也互不踩;不需要 EC2/机器号。
- 串行下天然无冲突;将来并行:worktree 隔离编辑,合并+末尾验证仍串行,代码冲突在合并时像普通 git 解。

### 3.5 executor 会话生命周期、逐任务选模型、可见性
- **会话保活到验收**:executor 报 done ≠ 关闭。review 通过并合并后才关会话+清 worktree;不过则 **resume 同一会话**带反馈续改(不重塞、省 token);只有大错走偏才关掉冷启动换更强模型。
- **逐任务选模型**:`worker.model` 独立设,难任务强模型、机械任务普通模型;可选范围看你的 provider 认证。
- **可见性(go)**:可打印 executor 输出流+推理摘要观测;GPT 无原始 CoT。go 裁决看 **diff**,不依赖 CoT。

### 3.6 任务状态的留存与清理

**现状(当前代码)**
- `.router/tasks/<id>/`(task.yaml/合同/日志)和 `.router/worktrees/<id>/run-N/`(完整 git 检出)**都留在磁盘,不自动清**。
- worktree 只在**下次 dispatch 同一个 id 时**被惰性清掉(dispatch 先 `worktree remove` 再重建);**`land` 之后不清,关闭 Claude 也不清**;目前无 `clean`/`gc` 命令。
- 后果:每任务一个完整检出(大仓 GB 级),会越堆越多——真实缺口。

**建议的生命周期(fail-close)**
- **轻状态(task 元数据 + 用量记录)→ 永久留**:审计、监控、崩溃 resume 都要用(正是监控要读的数据)。
- **重状态(worktree)→ 验收后清**:任务被接受(review 过 + 合并)后,清 worktree + 关执行器会话,只留元数据。
- **加 `router list` / `router clean`(gc)**:看/清残留;**绝不自动删有未合并改动的 worktree**(宁可留着手动清,也不丢没落地的工作)。
- **关闭 Claude ≠ 清理**:编排者进程结束不触发清理;走「验收即清 + 显式 `clean`」,不靠关闭时的魔法(符合「CLI 薄 + 显式」)。
- resume:task 状态在磁盘,重开 Claude 后可据此续跑或清理。

---

## 4. 命令三:`router review` —— 代码对抗审核(测试绿之后)

### 4.1 触发与定位(测试绿 ≠ 功能对)
- **触发**:`go` 完成且末尾回归测试**绿之后**。
- **测试绿是前提,不是「功能对」的证明**——测试本身也是被审对象,可能压根没测对东西。所以 reviewer **独立判断功能正确性,不把正确性甩给测试**。
- **两个角色、两个层面一起看**(多视角挖出更多问题;两个角色**可用不同模型跑**以增强独立性):
  1. **架构师视角 → 宏观 / 功能层**:从头到尾读(不只看 diff)——需求真被正确解决了吗?方案/结构/整体逻辑合理吗?有没有更好的架构?(见 §4.2)
  2. **资深开发视角 → diff 级**:每处改动对不对、健壮、优雅、测试扎实、风格一致?(见 §4.3)
  - 两个角色各自出 findings,你对**并集**裁决;谁发现越界的问题也可以提(架构师看到明显的 diff 级坑、资深开发看到明显的架构问题,都照提)。
- 机制**复用 `spec` 那套**;把 reviewer 当**资深开发**。标尺(Google 工程实践):**是否改善整体代码健康**,不是完美;技术事实 > 个人偏好;风格以项目风格指南为准,其余**与既有代码一致**。

### 4.2 宏观 / 功能层维度(**架构师视角**;每条 = reviewer 要问的问题)
> 这层是「资深开发从头到尾看功能对不对」,不只是看 diff。多数来自 ponytail 的生成规则/正确性基准,提升为审核判据。

- **F1 需求真被正确解决了吗** —— 读全、追真实数据流后再下结论;警惕**「小而自信但改错地方」的 diff**(那是第二个 bug,不是效率)。
- **F2 这个改动该不该存在** —— YAGNI 到需求层:正确结论可能是「更小的需求 / 根本不用改 / 不用这个抽象」。
- **F3 复用还是重造** —— 有没有重造**已有 helper/util/pattern、标准库、平台原生能力、已装依赖**?(重造是最常见的 slop。)
- **F4 根因还是症状** —— 修在**共享根**上了吗?grep 所有调用者,**兄弟调用点也修好了吗**?(只修 ticket 点名的路径 = 留 bug。)
- **F5 有没有更简单但仍正确的做法** —— 更简单 **≠** 更脆弱;同等大小,选**边界正确**的那个。
- **F6 整体结构/逻辑/集成** —— 层次/抽象/集成对吗?实现有没有**偏离方案**、或暴露方案阶段没考虑到的问题?
- **F7 独立正确性判断(不信作者的测试)** —— reviewer **自己**推理正确性、提出边界/断言,而不是因为「测试绿了」就认为功能对;**指出绿测试掩盖的正确性缺口**。(必要时可要求补一条独立的正确性断言。)

### 4.3 diff 级维度(**资深开发视角**;每条 = reviewer 要问的问题)
- **D1 健壮性/边界(超出测试)** —— 绿测试没覆盖的输入/顺序/并发/边界/错误/资源耗尽,扛得住吗?
- **D2 失败模式/错误处理** —— 出错是传播还是被静默吞掉/默认掉?有没有藏 bug 的 fallback?(呼应「禁静默 fallback」)
- **D3 复杂度/过度设计** —— 比需要的更复杂/更通用吗?**「解释比代码还长」= 复杂度伪装成散文**。
- **D4 测试设计质量 + 测试存在下限** —— 重新引入目标 bug 会挂吗?断言有意义还是同义反复?测行为(公共 API)还是实现细节?有没有 sleep/时序 flaky?**非平凡逻辑至少留一个「会挂」的最小 check;一行代码别堆 fixture(YAGNI 也适用测试)。**
- **D5 可读性/命名** —— 名字和结构不解释也让下一个人看懂意图吗?
- **D6 与项目风格一致** —— 符合周围代码和项目既定规则(括号、命名、错误/日志/测试惯例)吗?(不是 reviewer 个人口味)
- **D7 注释/文档 + 捷径标注** —— 注释讲**为什么**?该更新的用户/spec 文档更新了吗?**故意走的捷径有没有标「上限 + 升级触发条件」**?(无触发条件的捷径 = 会烂,`no-trigger`。)
- **D8 安全** —— 注入/不可信输入/权限/资源生命周期(用后释放、泄漏、无界增长)?
- **D9 性能常识** —— 热路径有没有意外 O(n²)/逐行分配这类测试抓不到的回归?

### 4.4 finding 输出结构(打印给你看)
综合 Conventional Comments(label ⊥ 阻塞)+ Qodo(what/why/how + severity)+ ponytail(一行可执行、给替换)+ reviewdog(diff-scoped):
```
{ level:     functional | diff,                  # 宏观功能 / diff 级
  dimension: F1..F7 | D1..D9,
  severity:  blocking | advisory | nit,           # 阻塞轴,与 dimension 正交
  location:  { file, line, symbol? },             # 宏观项可以是「整体/跨文件」
  what:      "具体问题(引用确切代码/行为)",
  why:       "为什么要紧——具体后果,不是『最佳实践』",
  suggestion:"具体修法/替换,小改给 diff/片段",     # 像 ponytail:给替换,不问「有没有考虑过」
  confidence:high | medium | low }
```
- severity:**blocking** = 功能错 / 正确性 / 健壮 / 安全缺陷,或**测试抓不住它要防的 bug** → 必须解决;**advisory** = 设计/复杂度/可维护改进;**nit** = 纯风格偏好,不阻塞。
- **top-level 决断**:review-effort 1–5 + 「是否改善代码健康:通过 / 需改 / 不通过」。**干净就干脆放行**(ponytail 式「Lean already. Ship.」),别凑数。
- **diff-scoped**:只报本次改动涉及的东西,别把仓库存量问题一起倒出来。

### 4.5 reviewer 行为规则(资深、独立、决断、不橡皮图章)
1. **对抗但公平**:假设作者是有能力的同行、可能漏了东西;默认怀疑,但标尺是「改善代码健康」,别为完美/口味阻塞。**测试绿是去挖它没覆盖的路径的理由,不是放松的理由。**
2. **决断 + 可执行(ponytail 式)**:每条给 `location + what + why + 具体替换/修法`,**不 hedging、不问「有没有考虑过」**。说不出具体后果就降 `confidence` 或删。
3. **按本项目判**:标风格/结构前先看周围代码和项目规则;**与既有代码一致优先于你的偏好**;规则本身有问题就明说并标 advisory。
4. **阻塞要挣来**:只有功能错/正确性/健壮/安全/测试无效才 blocking;偏好归 nit;**没 blocking 就直说「可以 ship」**。
5. **把测试当一等公民审**:每个测试问「重新引入目标 bug 会不会挂?断言有意义吗?测行为还是实现?有没有 flaky?」并指出绿测试掩盖的缺口。
6. **跨轮 resume 不橡皮图章**:复审时**核实修复是否真的解决**,查新代码,不凭作者一句「改好了」。

### 4.6 机械的不进 LLM 审(交给 lint/CI)
- 格式/Allman 括号/空白/import 顺序、changelog 更新没、编译过没、测试绿没、纯 lint 规则——lint/CI/Danger 类兜,**diff-scoped**,别浪费 LLM 判断力。
- LLM 只花在:功能正确性、设计/过度设计、复用 vs 重造、根因、边界与失败模式、**测试是否有意义**、命名/注释意图、不成文的项目惯例、数据流相关的安全/资源、以及「是否改善代码健康」。

### 4.7 闭环(有问题怎么修)
- 你判断哪些 finding 成立(reviewer 会错也会漏)→ **blocking 必须处理**;
- 修复:小的主会话直接改;成规模机械修复可派 executor(走 go 的 dispatch→review→合并);
- 修完 **重跑末尾验证(测试)** → **resume 同一 reviewer 复审**(核实 blocking 真解决)→ 你满意就收。

### 4.8 与 `spec` 的对称
| | 对象 | 时机 | 维度 |
|---|---|---|---|
| `spec` | 方案 / plan | 动手前 | 方案是否合理、有无更优解、风险 |
| `review` | 代码 / diff | 测试绿后 | **功能正确性(宏观)** + 健壮/设计/测试/风格(diff 级) |

同一套:人驱动 + 跨模型独立 reviewer + 持久 resume + 批评可见 + 人裁决。

---

## 5. CLI vs 剧本边界(保持薄)

| | CLI 机制(代码) | 剧本(prompt / 主会话) |
|---|---|---|
| `spec` | 启/resume reviewer、批评**打印+落文件**、冻结 PLAN | scout plan、判断批评、改 plan(你↔Claude) |
| `go` | 发 id/尝试号、跑门禁、apply 到主环境、resume executor、记录验收 | 拆任务、review diff、裁决绿/红、决定重试/升级 |
| `review` | 启/resume reviewer、喂 diff、finding**打印+落文件**、(可选)先跑 lint/CI 过滤机械项 | 判断 finding 是否成立、决定修哪些、驱动修复+复审 |

**裁决(批评对不对、diff 行不行、finding 成不成立)永远不在 CLI:`spec`/`review` 归人,`go` 的 diff review 归主会话。**

---

## 6. 可见性规则(通用)

- **要你判断的东西(`spec` 的批评、`review` 的 finding)→ 必须可见**(打印/落文件)。
- **你审最终产物的东西(`go` 的 diff)→ 中间推理可藏**。

---

## 7. 不在本期(backlog)

- **监控 / 用量观测** → 见 `docs/design/backlog.md`。核心三命令跑通后再做。

---

## 8. 实施阶段(rollout)

- **Phase 1 — `go` 最小闭环**:拆任务 → dispatch → review diff → 合并 → 末尾验证 → resume 重试。(先单模型、不加对抗。)
- **Phase 2 — `spec` 对抗审核**:启/resume 独立 reviewer、批评可见、人裁决、冻结 PLAN。
- **Phase 3 — `review` 代码对抗审核**:复用 spec 引擎,两层维度(宏观功能 + diff 级)、finding schema、blocking/advisory/nit、diff-scoped、修复+复审闭环。
- **Phase 4 — 打磨**:熔断阈值、`needs_human` 人审 gate、大错冷启动 vs 小错 resume 策略、lint/CI 机械过滤层。
- **Phase 5(backlog)**:监控/用量观测。

CLI 只承担机制;每个 Phase 的「智力」以剧本形式加,CLI 不膨胀。

---

## 9. 例子一:用户怎么用(spec → go → review)

目标:把 `logger.log(...)` 迁移到分级 API。

```console
# ── spec:把方案敲对 ──
$ (你 ↔ Claude 聊出 v1 plan:一次性正则替换全部 137 处)
$ router spec                # 首轮:启 reviewer(codex),打印批评
[reviewer] revise: 12 处级别取决于业务语义,正则会误判;缺「无残留」校验
$ (让 Claude 改出 v2:机械/判断分离 + 无残留校验)
$ router spec                # 次轮:resume 同一 reviewer,只发变更
[reviewer] approve(warn: 考虑 deprecated 垫片)
$ (你满意 → 冻结 PLAN)

# ── go:拆解并执行 ──
$ router go
[decompose] t1 worker=codex 机械替换 125 处; t2 worker=main 12 处定级+changelog; t3 worker=haiku 类型定义
[t1] dispatch → diff → 主 review OK → 合并 ✅(不等 build)
[t2] 主会话 inline → 提交 ✅
[t3] dispatch → diff → 主 review OK → 合并 ✅
[verify] 末尾统一跑:无残留 grep + 编译 + 测试 → 绿 ✅

# ── review:测试绿后审代码(两层) ──
$ router review              # 启 reviewer(codex),喂本次全部 diff,打印 findings
[reviewer] 见「例子三」
$ (你判断 → blocking 的修 → 重跑测试 → resume reviewer 复审 → 满意收工)
```

---

## 10. 例子二:spec 多轮对抗审核怎么交流(reviewer 跨轮 resume)

**Round 1 —— `router spec` 首轮**(喂 v1 plan):
```yaml
verdict: revise
objections:
  - kind: hidden-risk
    argument: "v1 用一条正则替换全部 137 处,但 12 处级别取决于业务语义,正则无法判定,会误标。"
    suggestion: "机械可判的批量替换与需判断的少数,拆两步。"
  - kind: unverifiable
    argument: "验收只写『测试通过』;漏改/错级别时仍可能全绿,证明不了迁移完整。"
    suggestion: "加『grep 无 logger.log( 残留』作为完成判据。"
```
**你的裁决**:成立 → 让 Claude 改出 v2。

**Round 2 —— `router spec` 次轮**(resume 同一 reviewer,只发 v2 变更):
```yaml
verdict: approve
reason: "误标风险已通过机械/判断分离消除;判据含无残留+编译+测试。方案合理、可验。"
followups:
  - kind: nit
    severity: warn
    argument: "一次性删旧 logger.log,外部调用方会直接断。"
    suggestion: "(可选)方案里补:是否保留 deprecated 垫片过渡一版。"
```
**你的裁决**:approve;warn 记为后续 → 冻结 PLAN。
> reviewer 只评**方案本身**(风险/兼容/工程规范),**不评任务怎么拆**(那是 `go`)。

---

## 11. 例子三:review 代码对抗审核怎么交流(两层)

**Round 1 —— `router review` 首轮**(测试已绿,喂本次全部 diff):
```yaml
verdict: needs-changes        # review-effort: 3/5;是否改善代码健康:需改
findings:
  - level: functional         # ← 宏观/功能层:测试绿也照挖
    dimension: F4              # 根因还是症状
    severity: blocking
    location: { symbol: "logger.log 的所有调用点" }
    what: "只迁移了 src/api,但 logger.log 在 src/jobs 还有 8 处调用没动。"
    why: "根因没修在共享处,兄弟调用点仍用旧 API;需求『全量迁移』没真正达成。"
    suggestion: "grep 全仓 logger.log(,把 src/jobs 的 8 处一并迁移。"
    confidence: high
  - level: functional
    dimension: F7              # 独立正确性判断(不信作者测试)
    severity: blocking
    location: { file: "tests/logger_test.py", line: 42 }
    what: "test_migrated 只断言 logger 被调用,没断言级别;info 误写成 error 也照样绿。"
    why: "测试抓不住核心 bug(级别迁移错误),等于没测这个需求。"
    suggestion: "断言实际级别:assert record.levelname == 'WARNING'。"
    confidence: high
  - level: diff               # ← diff 级
    dimension: D2              # 失败模式
    severity: blocking
    location: { file: "src/api/handler.py", line: 128 }
    what: "logger.error(msg) 未处理 msg=None,旧 logger.log 对 None 是容忍的。"
    why: "迁移悄悄改了行为:None 现在抛异常,且测试没覆盖 None。"
    suggestion: "保留 None 容忍或显式校验;补 None 测试。"
    confidence: medium
  - level: diff
    dimension: D6              # 风格一致
    severity: nit
    location: { file: "src/utils/log.py", line: 15 }
    what: "这里用 f-string,周围文件都用 % 风格日志。"
    why: "与既有风格不一致(偏好,非对错)。"
    suggestion: "(nit)对齐周围 % 风格。"
    confidence: high
```
**你的裁决**:三条 blocking 成立(漏迁移 / 测试无效 / None 健壮性)→ 修;nit 采纳。
→ 重跑末尾测试(绿)→ `router review` 次轮:**resume 同一 reviewer**,只发修复 diff。
```yaml
verdict: approve              # review-effort: 1/5;是否改善代码健康:通过
note: "已核实:src/jobs 8 处已迁移、level 断言到位、None 分支补了处理与测试。三条 blocking 均真解决。"
```
**你的裁决**:approve → 收工。
> 注意:第一条(漏迁移)和第二条(测试无效)是**宏观/功能层**——测试全绿也照样被挖出来,正是「测试绿 ≠ 功能对」;机械项(f-string vs %)本应 lint 兜,这里降为 nit。
