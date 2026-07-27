---
description: Execute the plan we just discussed -- dispatch clear subtasks to cheaper models, then YOU review and verify in the real environment before merge
allowed-tools: Bash, Read, Edit, Write, Task
---
The user has finished planning WITH YOU in this conversation and now wants router to
execute. Do NOT re-plan from scratch or shell a separate planner -- YOU decompose the
plan you both just agreed on, using the full context you already have.

**Division of labor.** The **router CLI** owns only the mechanism it alone can provide:
an isolated `git worktree`, process supervision, and fast *environment-free* gates on the
diff (it applies cleanly, stays within `allowed_globs`, leaks no secrets). **YOU (Opus)**
own every judgment -- how to split the work, whether a diff is correct, whether it needs
verifying, and, crucially, **running the real build/tests yourself in this session's real
environment** (you have Bash, Docker, and the full toolchain; the sandboxed executor does
not). A cheap model can clear a shallow gate while being lazy or wrong, so verification --
and the pass/fail verdict -- stays with you, never with the executor and never compressed.

1. **Decompose** the agreed plan into the smallest **well-defined, serially-ordered**
   subtasks (one executor runs at a time; land a prerequisite before dispatching a task
   that depends on it). For each CLEAR task (an average cheaper model could finish it from
   the contract alone), author it by running this with a real id/title substituted in
   (`<id>`/`<title>` are placeholders -- do NOT run it verbatim):

   `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" new <id> --title "<title>"`

   then edit `.router/tasks/<id>/task.yaml`: set `allowed_globs` to the smallest scope, and
   **leave `verify: []`** -- you run the real build/tests later, so the CLI should apply only
   its environment-free gates, not a build/test command. Make each task's Definition of Done
   include **writing tests for the code it changes** (the cheap model produces a first cut;
   you vet them). Pin the cheapest capable model with `worker: { kind: claude, model: haiku }`
   (or `sonnet`) for a genuinely simple task; leave `worker` unset to let router quota-balance
   codex vs claude.

   **Touchpoint 1:** show the user the task list -- each clear task with its scope, target
   model, and the note that it carries its own tests; each unclear task -- and wait for their
   go-ahead.

2. **Run the clear tasks one at a time, in dependency order:**
   `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" dispatch <id> --json`
   router picks the executor with more real remaining quota, runs it in an isolated worktree,
   and clears the environment-free gates (diff applies + scope + secret scan). **Then YOU read
   the diff and review it:** is the implementation correct? did it drift from the change you
   specified? **are the tests real assertions rather than hollow or hardcoded stubs?** is the
   changed code actually covered? Judge the risk. Then branch:
   - **Low-risk and the review is clean** -> `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" land <id>`
     to merge it into your working branch, then move to the next task. (Don't run its build/tests
     now -- the mandatory final gate in step 4 covers low-risk work.)
   - **Review is doubtful, the change is high-risk, or it drifted** -> verify it now, yourself,
     in the real environment: run the relevant build/tests with Bash (invoke Docker/CI exactly
     as this project requires). **Read the entire output yourself and judge it -- do not
     compress it, and do not let a cheap model decide pass/fail.** Pass -> land. Fail -> find the
     root cause, write a sharper, more specific contract, and re-dispatch (once; if it still
     fails, take the task over yourself). For correctness-critical paths, write or harden the
     tests yourself rather than trusting the executor's.

3. **Touchpoint 2:** handle any UNCLEAR task directly with the user (clarify, then implement it
   yourself). Never dispatch it to a cheap model.

4. **Touchpoint 3 -- final acceptance (mandatory; you do all of it yourself):** once every clear
   task has landed and every unclear task is done:
   - **Work out how to build and test this project yourself** by reading `package.json` /
     `Makefile` / CI config / etc. The user does not supply build/test commands and there is no
     manifest -- discover them.
   - Confirm **every changed line is covered by a test** (key paths and all modified code; aim for
     complete coverage, allowing only what genuinely cannot be covered). Fill any gap -- write the
     missing tests yourself, or dispatch a focused test-writing task (which must then pass too).
   - **Run the full-chain CI/build/tests in the real environment** (Docker included). **Read the
     complete output yourself, uncompressed, and decide** whether everything ran and passed.
   - Only when the whole chain is green **and** your review is satisfied do you report "done" to
     the user, with the combined diffs and roughly the tokens saved. If anything fails, return to
     the step-2 fix loop. **Land nothing the user has not approved.**

You planned, decomposed, reviewed, verified in the real environment, and merged; the cheap models
did the execution -- that is the token saving.

Bookends (optional, independent second opinions): run `/router:spec` **before** `go` to
adversarially review the plan, and `/router:review` **after** the final tests pass to
adversarially review the code.
