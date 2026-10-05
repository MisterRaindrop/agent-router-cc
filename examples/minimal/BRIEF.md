# Implement slugify()

**Goal.** Implement the exported `slugify(input)` in `src/slugify.mjs`: lowercase everything,
replace every run of non-alphanumeric characters with a single hyphen, trim leading and trailing
hyphens.

**Invariants.** The export name and signature stay as they are.

**Frozen interfaces.** `test/slugify.test.mjs` is the specification. Do not edit it.

**Definition of done.** `node --test` passes, including:
- `slugify('Hello World') === 'hello-world'`
- `slugify('  Foo, Bar!  Baz ') === 'foo-bar-baz'`
- `slugify('already-clean') === 'already-clean'`

**Blast radius.** `src/slugify.mjs` only.

**Stop conditions.** If the tests contradict the rules above, stop and report CONTRACT_CONFLICT.
