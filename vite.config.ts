import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, strictPort: true },
  build: {
    rolldownOptions: {
      input: {
        app: 'index.html',
        about: 'about.html',
        privacy: 'privacy.html',
        terms: 'terms.html',
      },
    },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000 },
});
