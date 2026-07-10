# Minimal example: implement `slugify()`

A dependency-free task you can run end to end. The project ships an unimplemented
`slugify()` and a passing-once-fixed test suite; router drives an executor to make
the tests pass, verifies the diff mechanically, and lets you merge it.

```
examples/minimal/
  src/slugify.mjs        # unimplemented (the executor fills this in)
  test/slugify.test.mjs  # the mechanical gate (executor may NOT edit this)
  policy.yaml            # -> .router/policy.yaml   (node-only build/test, no deps)
  task.yaml              # -> .router/tasks/slugify/task.yaml
  TASK_CONTRACT.md       # -> .router/tasks/slugify/TASK_CONTRACT.md
```

## Run it

You need the `codex` (or `claude`) CLI authenticated, and `router` on your PATH
(`node /path/to/dist/router.js`). From a copy of this directory in its own git repo:

```sh
git init && git add -A && git commit -m "unimplemented slugify + tests"

router init                                   # creates .router/
cp policy.yaml .router/policy.yaml
router new slugify --title "Implement slugify()"
cp task.yaml         .router/tasks/slugify/task.yaml
cp TASK_CONTRACT.md  .router/tasks/slugify/TASK_CONTRACT.md
git add -A && git commit -m "router: policy + slugify task"   # policy is read from git

router validate slugify        # freezes base_sha = HEAD, checks the contract
router queue slugify
router run slugify             # detached; the executor edits src/ in an isolated worktree
router status slugify          # poll until PASSED or FAILED
router result slugify          # the 6-check verifier report
router merge slugify           # fast-forwards the verified diff into your branch
```

If the executor's diff fails any check (build, test, scope, secret scan, contract
hash), the task ends FAILED and nothing is merged. Your working tree is never
touched until `router merge`.

See `../../docs/quickstart.md` for the full walkthrough and what each step guarantees.
