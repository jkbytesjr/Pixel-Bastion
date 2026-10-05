import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { open: false },
  // three.js is ~600 kB of the bundle and the game ~100 kB (~190 kB gzipped in all); it loads in one go anyway.
  build: { chunkSizeWarningLimit: 950 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
