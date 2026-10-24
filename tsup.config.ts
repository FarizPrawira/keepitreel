import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'transcribe/index': 'src/transcribe/index.ts',
    'video/index': 'src/video/index.ts',
    'publish/index': 'src/publish/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // The CJS build needs import.meta.url, which transcribe uses to find python/transcribe.py.
  shims: true,
  target: 'node22',
});
