import { defineConfig } from 'astro/config';

export default defineConfig({
  // Deployed as a GitHub Pages project site, so assets live under /sporetest/.
  site: 'https://nickmarcha.github.io',
  base: '/sporetest',
  devToolbar: { enabled: false },
  vite: {
    // surface-nets uses Browserify-era dependencies inside the meshing worker.
    define: { global: 'globalThis' },
    resolve: { alias: { buffer: 'buffer/' } },
  },
});
