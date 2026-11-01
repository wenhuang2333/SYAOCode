import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts'), formats: ['es'] },
      rollupOptions: { external: ['electron'] },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      // preload 必须是 CJS（sandbox: true 时不支持 ESM preload）。
      lib: { entry: resolve(__dirname, 'src/preload/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
      rollupOptions: { external: ['electron'] },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { outDir: resolve(__dirname, 'dist/renderer'), rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [react()],
  },
});
