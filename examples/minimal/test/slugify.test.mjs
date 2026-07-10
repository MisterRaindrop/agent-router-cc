// The mechanical gate. The executor may edit src/** (allowed_globs) but NOT this
// file (it is outside allowed_globs and protected as a test_glob), so it cannot
// "pass" by weakening the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.mjs';

test('lowercases and hyphenates words', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('strips punctuation and collapses separators', () => {
  assert.equal(slugify('  Foo, Bar!  Baz '), 'foo-bar-baz');
});

test('is idempotent on an already-clean slug', () => {
  assert.equal(slugify('already-clean'), 'already-clean');
});
