# Router Backlog(暂不实现,先记录)

> 明确要做、但**不在当前里程碑**的功能。当前先把核心 `spec` + `go`(+ `review`)跑通。

---

## 监控 / 用量观测:`router usage`

**动机**
1. 观测:**这一整个开发任务**花了多少、Codex/Claude 各花多少、卡在哪。
2. 优化:哪些子任务被优化了(派了便宜模型)、哪些没有,以及**怎么能更省**(给建议)。
3. 数据驱动:实测每类任务在各档模型上的清关率,指导「用哪档 / 该不该 route」。

**两类数,别混**
- **token = 实测**(从 executor 流里真拿到的,真数)。
- **成本/节省 = 估算**:靠**项目里维护的价目表**(从各家定价页抄下来存进仓库)`token × 单价` 算。**同一个活给便宜模型跑,token 数差不多,省的是「钱」(便宜模型每 token 更便宜),不是 token 数。**

**Router 的差异化(务必保住)**
- `usage.ts` 已在**每次 dispatch 从 executor 流里**抽 `{input, output, cached, model, costUsd}`(Claude 有 `total_cost_usd`;plan-Codex 为 null)。
- Router 能把用量**绑定到具体 task/run/executor**——这是 Orca 做不到的(它的用量扫描器和编排任务没 join,对不上号)。**这个 join 是核心优势。**

### 记录字段(用 Claude Code OTel / ccusage 的名字,两 executor 好归一)

**per 子任务/dispatch(原子行)**
- 身份:`dispatch_id, task_id, run_id, executor(claude|codex), model, auth_mode`。
- **`optimized`(bool)** = worker 是便宜模型(dispatch)→ ✅;`worker: main`/强模型 → 未优化。
- token 四维:`input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens`;有则 `reasoning_output_tokens`;派生 `total_tokens`。
- 成本(估):`price_derived_cost_usd`(token×价目表,总算)、`provider_cost_usd`(Claude 有则记,仅作对照)、`cost_source`。
- 执行信号(喂「优化建议」用):`wall_ms, exit_status, retries, resumes, was_escalated, escalated_from_model, review_round`。

**per 开发任务(run = 一次 spec/go/review)**:上面 rollup,按 `optimized` 拆(优化 vs 未优化 vs review);`dispatch_count, retry_count, escalation_count, review_rounds, pass`。

### 采集与存储
- 采集:Claude 读 print-mode `result`(`usage`+`total_cost_usd`+`modelUsage`);Codex 读 `turn.completed.usage`(注:`reasoning`/`cache_write` 暂不在 `--json` 流,在磁盘 rollout 里 → 解析 rollout 或标 `partial`,别显示 0)。
- 存储:`.router/runs/*.jsonl`(每 dispatch 一行,append-only,原子写)。
- **保留 7 天**:超过 7 天的 run 日志自动清理(简单起见只留近 7 天;若以后要做清关率统计再考虑留聚合)。

### `router usage` 展示(默认盯「当前开发任务」,不是按天)

> 插件开源:`router usage` 的**所有终端输出一律用英文**(下面 mockup 已是英文,中文仅为设计注释)。

**默认 `router usage` = 当前/最近这个开发任务(run)的逐子任务(英文输出):**
```
Task run #a3  "add iceberg map evolution"                 ✓ done · 12m
──────────────────────────────────────────────────────────────────────
Subtask          worker         optimized?   Tokens    (~cost est)
t1 migrate 125   codex          ✅ yes        124k      ~$0.30
t2 classify 12   main (opus)    —  no         48k       ~$0.60
t3 type defs     haiku          ✅ yes        20k       ~$0.05
review           opus           —  review     35k       ~$0.45
──────────────────────────────────────────────────────────────────────
TOTAL                                         227k      ~$1.40
Optimized saved (est): ~$1.6   (t1/t3 tokens re-priced at opus rate − actual; --explain-savings)
──────────────────────────────────────────────────────────────────────
💡 Suggestions:
  · t2 spent 48k on main — split out the mechanical part to save more
  · No retries, no escalations — healthy
```
compact 一行(可复用到 statusline,英文):
```
🧩 router · run #a3 $1.40 (4 subtasks) · 🤖 codex 2 / opus 2 · 💸 ~$1.6 saved (est)
```

**次要视图**:
- `router usage --list` → 近 7 天每个开发任务一行(run 级 rollup)。
- `router usage --run <id>` → 指定 run 的逐子任务明细。
- `router usage --by-model` → 便宜活 vs 强模型 review 分开看(`└─` 子行)。
- flags:`--json --no-cost --explain-savings --mode provider|derived|auto`。
- 列沿用 ccusage 词汇(Input/Output/Cache Read/Total/Cost),但**默认单元是 run,不是 day**;**无 $ 的 Codex 显示 `tokens`/`n/a`,绝不 `$0.00`**。

### 优化建议(从记录信号里推导;触发条件中文注释,**打印的字符串用英文**)
- 未优化但像机械(main 做、量大、glob 集中)→ `"<task>: mechanical work ran on main — route to a cheap model next time"`
- 重试多 → `"<task>: N retries — contract underspecified; sharpen it before dispatching"`
- 升级过(cheap→strong)→ `"<task>: escalated cheap→strong — under-specified; inline or use the strong model directly"`
- review 成本占比高 → `"review is a large share of cost — diff too big; split smaller or self-check first"`
- 无浪费 → `"No waste — healthy"`(别硬凑)

### 「省了多少」—— 只作估算,诚实呈现
公式:`counterfactual(优化任务的实际 token × 强模型单价) − actual(实际花费,含 review)`。
让它成为估算的假设(`--explain-savings` 全列):① 等 token 假设(强模型可能更少轮次/弱模型可能重试更多);② review 非免费,已净掉;③ 重试/升级要加进 actual(升级过的 run 可能负节省);④ list-price 估(plan 根本不按 token 计费);⑤ 质量没定价(便宜跑出更差代码有隐性成本)。
呈现:实际值主位;节省作 `~$X (est)` + 脚注 + 下钻;升级过/executor 本身是强模型 → `n/a`;措辞「estimated vs all-strong-model at list price」,不用「你省了」。

### provider 缺口
- **plan-Codex 无 $** → 用价目表 derived 或只显 token,永不 `$0.00`。
- **Codex `--json` 缺 cache-write/reasoning** → 解析 rollout 或标 `partial`。
- **流式低报成本**(aider 记载)→ 标 `derived`。

### 价目表(项目内维护 —— 就是你说的「从网站列表找花费存项目里」)
一个仓库内 JSON(per MTok,需定期核对):Claude Opus4.5+ $5/$25/$0.5cache-read;Sonnet4.5/4.6 $3/$15/$0.3;Haiku4.5 $1/$5/$0.1。GPT-5/gpt-5-codex $1.25/$10/$0.125cached(2026 年 OpenAI 旗舰已迭代,核对实际 slug)。`token × 该表` = 成本/节省估算的唯一来源。

**不在当前里程碑**:核心三命令跑通后再做。`usage.ts` 采集已在,先补**持久化(`.router/runs/*.jsonl`,留 7 天)+ per-run 展示 + 优化/未优化标注 + 建议**,「省量」估算最后加。

> 状态:`router usage`(读 metrics.jsonl → 英文表 + `--json`)与 `router list`(任务/残留 worktree,只读)**已实现并测试通过**;上面这些 per-run/优化标注/建议是后续增强。

---

## 清理:`router clean`(feature,暂不实现)

`router list` 已实现(只读,看残留)。`router clean` 是**破坏性**的(删 worktree,可能含未 land 的工作),按「破坏性操作先确认」原则单独做,fail-close:

- `router clean`(默认)= **只删安全的**:分支已合并进 HEAD(工作已保住)或 stale 注册;**未合并的保留**并列出来,提示 `--force`。
- `router clean --force` = 显式删所有残留 worktree(含未合并,明确破坏性 opt-in)。
- **绝不静默删未合并工作。**
- 需要一个 git 助手 `isAncestor(branch, HEAD)`(`git merge-base --is-ancestor`)判断是否已合并。

`land` 成功时已经清掉自己的 worktree(见 commands.ts),所以残留主要来自「dispatch 了但没 land」(失败/中途关闭)——正是要小心的那类。
