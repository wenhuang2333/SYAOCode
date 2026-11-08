// electron.vite.config.ts
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
var __electron_vite_injected_dirname = "/Users/zhanshishan/Desktop/SIYAO/SYCODE/DesktopCode/apps/desktop";
var electron_vite_config_default = defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      lib: { entry: resolve(__electron_vite_injected_dirname, "src/main/index.ts"), formats: ["es"] },
      rollupOptions: { external: ["electron"] }
    }
  },
  preload: {
    build: {
      outDir: "dist/preload",
      // preload 必须是 CJS（sandbox: true 时不支持 ESM preload）。
      lib: { entry: resolve(__electron_vite_injected_dirname, "src/preload/index.ts"), formats: ["cjs"], fileName: () => "index.cjs" },
      rollupOptions: { external: ["electron"] }
    }
  },
  renderer: {
    root: resolve(__electron_vite_injected_dirname, "src/renderer"),
    build: { outDir: resolve(__electron_vite_injected_dirname, "dist/renderer"), rollupOptions: { input: resolve(__electron_vite_injected_dirname, "src/renderer/index.html") } },
    plugins: [react()]
  }
});
export {
  electron_vite_config_default as default
};
