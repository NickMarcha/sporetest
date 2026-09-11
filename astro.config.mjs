import { defineConfig } from 'astro/config';

export default defineConfig({
  devToolbar: { enabled: false },
  vite: {
    // surface-nets uses Browserify-era dependencies inside the meshing worker.
    define: { global: 'globalThis' },
    resolve: { alias: { buffer: 'buffer/' } },
  },
});
