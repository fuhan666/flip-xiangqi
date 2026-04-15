import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const R3F_RUNTIME_PACKAGES = [
  '@react-three/fiber',
  'its-fine',
  'react-use-measure',
  'suspend-react',
  'zustand',
];

function hasModulePath(id: string, pkg: string): boolean {
  return id.indexOf(`/node_modules/${pkg}/`) !== -1;
}

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (hasModulePath(id, 'three')) {
            return 'three-core';
          }

          if (R3F_RUNTIME_PACKAGES.some((pkg) => hasModulePath(id, pkg))) {
            return 'r3f-runtime';
          }

          if (hasModulePath(id, 'react') || hasModulePath(id, 'react-dom') || hasModulePath(id, 'scheduler')) {
            return 'react-vendor';
          }

          return undefined;
        },
      },
    },
  },
});
