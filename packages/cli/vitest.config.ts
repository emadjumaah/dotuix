import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These tests spawn the built CLI as a subprocess; node startup + pack/sign
    // work can exceed the 5s default on a loaded CI machine. Give it headroom.
    testTimeout: 30_000,
  },
});
