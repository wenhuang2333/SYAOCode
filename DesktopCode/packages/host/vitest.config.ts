import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 这些是**集成**测试：大量用例要 spawn `git` 子进程、起本地 HTTP stub、
    // 开真实 WebSocket。vitest 默认 5 s 对它们太紧，并行负载下会偶发超时，
    // 而每次超时的用例并不固定（谁的 git 调用排在后面谁超时）——
    // 那是抖动，不是测试写得慢。放宽超时不会削弱任何断言。
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
