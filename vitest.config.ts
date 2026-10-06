import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
    setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))]
  },
  resolve: {
    alias: {
      '$app/environment': fileURLToPath(new URL('./vitest.stubs.ts', import.meta.url)),
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  }
});
