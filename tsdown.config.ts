import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'node',
  outDir: 'lib',
  // Host DSH provides these at runtime. Do not bundle unpublished packages.
  deps: {
    neverBundle: [/^@deepseek-ai\//],
  },
})
