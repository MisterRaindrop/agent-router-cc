# Minimal example: implement `slugify()`

A dependency-free task you can run end to end. The project ships an unimplemented
`slugify()` and a passing-once-fixed test suite; router dispatches an executor to make
the tests pass, verifies the diff mechanically, and lets you merge it.

```
examples/minimal/
  src/slugify.mjs        # unimplemented (the executor fills this in)
  test/slugify.test.mjs  # the mechanical gate (executor may NOT edit it -- out of scope)
  task.yaml              # the task contract (scope + verify) -> .router/tasks/slugify/
  TASK_CONTRACT.md       # the goal handed to the executor
```

## Run it

You need the `codex` (or `claude`) CLI authenticated, and `router` on your PATH
(`node /path/to/dist/router.js`). From a copy of this directory in its own git repo --
no `init`, no policy, no commit:

```sh
git init && git add -A && git commit -m "unimplemented slugify + tests"

router new slugify --title "Implement slugify()"    # auto-creates .router/
cp task.yaml        .router/tasks/slugify/task.yaml   # scope + verify: [["node","--test"]]
cp TASK_CONTRACT.md .router/tasks/slugify/TASK_CONTRACT.md

router dispatch slugify        # runs the executor in an isolated worktree, then verifies
router result slugify          # the per-check report (diff/scope/secret/verify)
router land slugify            # merge the verified diff into your branch
```

If the diff fails any check (scope, secret scan, or the `verify` command), the dispatch
is FAILED and nothing merges. Your working tree is untouched until `router land`.

See `../../docs/quickstart.md` for the full walkthrough (and the `/router:go` loop where
Opus decomposes + reviews).
