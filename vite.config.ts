import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  },
  test: {
    /**
     * The suites run in plain Node.js: there is no jsdom / happy-dom installed,
     * and the few tests that need a DOM build their own mock (see
     * `createMockDOM()` in the playback suites).
     */
    environment: 'node',
    /** Explicit imports only: `import { describe, it, expect } from 'vitest'`. */
    globals: false,
    /** Only the unit/integration suites of this package are picked up. */
    include: ['src/tests/**/*.test.ts'],
    /**
     * `src/tests/browser/**` is the REAL browser harness: plain Node scripts
     * (`.mjs`) driven by `npm run test:browser` with a real Chrome. They are
     * not vitest suites and must never be collected by vitest.
     */
    exclude: [
      'src/tests/browser/**',
      'node_modules/**',
      'dist/**',
      '**/*.d.ts',
    ],
    /**
     * The 10-minute playback simulation (`playback-acceptance.test.ts`) needs
     * ~1.6 s of wall clock; the extra headroom absorbs slow CI machines.
     */
    testTimeout: 15_000,
    hookTimeout: 15_000,
    /**
     * Coverage is configured but NOT enabled by default.
     * The provider package is not installed yet: run
     * `npm i -D @vitest/coverage-v8` before using `vitest run --coverage`.
     */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/tests/**',
        'src/main.tsx',
        'dist/**',
        '**/*.d.ts',
        '**/node_modules/**',
      ],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
});
