import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000 },
  build: {
    rollupOptions: { output: { manualChunks(id) {
      if (/node_modules\/(echarts|zrender)\//.test(id)) return 'charts';
      if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
      if (id.includes('/node_modules/zod/')) return 'validation';
      if (id.includes('/node_modules/@tanstack/')) return 'tables';
      if (id.includes('/node_modules/@radix-ui/')) return 'dialogs';
    } } },
    // ECharts' selected canvas renderers are a single cacheable chart bundle.
    chunkSizeWarningLimit: 650,
  },
});
