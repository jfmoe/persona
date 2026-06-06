import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each integration test spawns a real `persona` subprocess under a temp HOME,
    // so give them generous headroom over the unit-test default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
