## What & why

<!-- What broke or was missing, what it cost, and how this change closes it.
     Measured numbers beat adjectives — see git log for the house style. -->

## Checklist

- [ ] `npm run check` passes (typecheck + core-purity guard + tests)
- [ ] Bug fix: the regression test **fails against the old code** (RED first)
- [ ] Touched `src/`: ran `npm run build` and committed the rebuilt `dist/router.js`
- [ ] Should reach installed plugins: bumped the version in **both** `package.json`
      and `.claude-plugin/plugin.json`, and added a `CHANGELOG.md` entry
- [ ] `core/` stays pure (no fs / child_process / process / clock / randomness)
