import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Must stay false: the server project's setupFiles truncates the whole
    // test Postgres DB once per file, so two files can't safely run against
    // it at the same time.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['shared/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/**/*.test.ts'],
          setupFiles: ['./server/testDbSetup.ts'],
        },
      },
    ],
  },
})
