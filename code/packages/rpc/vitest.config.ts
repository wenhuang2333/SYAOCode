import { defineConfig } from 'vitest/config';

/**
 * Coverage for the governance kernel (03 §7.1: line coverage >= 85%).
 *
 * The audit (05 §10.1) noted the target was unverifiable because there was no
 * coverage tooling. The threshold is enforced here so a change that stops
 * exercising a branch fails the gate instead of quietly lowering it.
 *
 * Run with: corepack pnpm --filter @syaocode/rpc run test:coverage
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        // Branches carry the governance edge cases; 80 keeps it honest without
        // demanding a test for every unreachable defensive arm.
        branches: 80,
      },
    },
  },
});
