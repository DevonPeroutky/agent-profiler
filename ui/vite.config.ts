import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { transcriptApi } from './vite-plugin-transcript-api';

export default defineConfig({
  plugins: [react(), transcriptApi()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: { port: 5173 },
  preview: { port: 5173 },
});
