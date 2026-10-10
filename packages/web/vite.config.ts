import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { withInvoluteVersion } from './src/lib/build-version';

export default defineConfig({
  plugins: [
    react(),
    // <meta name="involute-version"> carries the build's source SHA (INV-1146).
    { name: 'involute-version-meta', transformIndexHtml: (html) => withInvoluteVersion(html, process.env.INVOLUTE_BUILD_SHA) },
  ],
});
