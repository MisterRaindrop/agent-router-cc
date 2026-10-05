// The specification. BRIEF.md tells the writer not to edit this file, and the review
// checks that it did not: a writer that "passes" by weakening the test has not passed.
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
