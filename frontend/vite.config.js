import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../docs/assets/javascripts/reactflow',
    emptyOutDir: false,
    rollupOptions: {
      input: 'src/index.jsx',
      output: {
        entryFileNames: 'bundle.reactflow.js',
        format: 'iife',
        name: 'ReactFlowBundle',
      },
    },
  },
});
