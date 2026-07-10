# Implement slugify()

task: slugify

## Goal

Implement the exported `slugify(input)` function in `src/slugify.mjs` so that all
tests in `test/slugify.test.mjs` pass.

`slugify` converts an arbitrary string into a URL slug:
- lowercase everything,
- replace every run of non-alphanumeric characters with a single hyphen,
- trim leading and trailing hyphens.

## Definition of Done

- [ ] `slugify('Hello World') === 'hello-world'`
- [ ] `slugify('  Foo, Bar!  Baz ') === 'foo-bar-baz'`
- [ ] `slugify('already-clean') === 'already-clean'`
- [ ] Only `src/**` is changed; the test file is untouched.
