---
description: Send feedback to a codex write's same session, so it keeps what it learned about the repository instead of starting cold
argument-hint: <write-id> --feedback "<everything that is wrong>"
allowed-tools: Bash, Read
---
Continue the codex session of an earlier `router write`. Treat `$ARGUMENTS` as
`<write-id> --feedback "<text>"`; if either is missing, ask for it and stop.

Run it **in the background** (`run_in_background`) -- a resume can outlast the 10-minute
foreground limit -- and continue when it completes:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" resume $ARGUMENTS
```

Before running it, check the feedback is **complete**: every finding in this one round, because
each resume re-sends the whole accumulated session (`references/codex-writer.md` has the
measurements). If what is left is a few mechanical lines, make them yourself instead. This is at
most the second resume of that write; a third means taking the work over or bringing it to the
user.

When it finishes:

- **`RESUME DID NOT RE-ATTACH`** -> codex reported a different session, or none. It was not a
  continuation: treat whatever it did as a fresh, unreviewed run.
- **It refuses** over a different branch or a dirty tree -> check out the branch it ran on, commit
  or stash your own changes, and run it again. Do not work around it.
- Otherwise read the new commits (`git diff <base>..HEAD`, the `base` it prints) exactly as you
  review your own work, and continue with `/router:go`'s Touchpoint 3.
