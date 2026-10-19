import { defineConfig } from 'vitest/config'

// Kept separate from the application's source-test configuration so benchmark
// execution remains an explicit opt-in command.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts'],
  },
})
