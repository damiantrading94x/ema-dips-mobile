import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base so the built app works from any path (GitHub Pages,
  // a static host, or served straight off the desktop server).
  base: './',
  server: { host: true, port: 5180 },
});
