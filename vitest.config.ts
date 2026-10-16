import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Load native/WebAssembly packages directly with Node (transforming the 10 MB OpenCV bundle is very slow).
    server: { deps: { external: [/@techstark\/opencv-js/, /onnxruntime-node/, /sharp/, /heic-decode/] } },
  },
});
