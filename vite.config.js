import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: { outDir: '../dist', emptyOutDir: true, target: 'esnext' },
  // host: true listens on all interfaces so the game is reachable at the VPS IP
  server: { host: true, port: 5173, strictPort: true, fs: { allow: ['..'] } },
});
