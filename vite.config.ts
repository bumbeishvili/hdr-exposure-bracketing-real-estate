import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the built dist/ also works from a plain static server.
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
