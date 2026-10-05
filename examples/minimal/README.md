# Minimal example: let codex implement `slugify()`

A dependency-free piece of work you can run end to end. The project ships an unimplemented
`slugify()` and a test suite that passes once it is implemented; `router write` hands it to codex
with a brief, and you review what it committed.

```
examples/minimal/
  src/slugify.mjs        # unimplemented (the writer fills this in)
  test/slugify.test.mjs  # the specification (the brief says not to edit it)
  BRIEF.md               # what the writer is asked to do
```

## Run it

You need the `codex` CLI logged in, and `router` resolvable (see `docs/quickstart.md` for the
one-line alias). From a copy of this directory in its own git repo:

```sh
git init && git add -A && git commit -m "unimplemented slugify + tests"

router write slugify --brief BRIEF.md     # codex commits on the current branch; prints the base
git diff <base>..HEAD                     # review exactly what it did
node --test                               # verify it yourself -- its report is a claim
router resume slugify --feedback "..."    # only if something is wrong: same codex session
```

The writer refuses to start over uncommitted changes, so commit first. Merging -- or discarding
the commits -- is yours.

In normal use you would not run these by hand: tell `/router:go` "let codex write this part" and
the main session writes the brief, launches the writer, and reviews the result.
