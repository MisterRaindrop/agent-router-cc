// The router task 'slugify' asks an executor to implement this function so the
// tests in test/slugify.test.mjs pass. It ships intentionally unimplemented.
export function slugify(input) {
  throw new Error('not implemented');
}
