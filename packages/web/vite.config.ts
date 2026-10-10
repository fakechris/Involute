import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { withInvoluteVersion } from './src/lib/build-version';

// In production the web app and the API share an origin. In local development
// they do not, and the Capture extension (INV-1147) sends GraphQL to the
// origin it was connected from — set INVOLUTE_DEV_API_PROXY to the server
// (e.g. http://127.0.0.1:4200) to serve /graphql and /uploads from the dev server.
const apiProxy = process.env.INVOLUTE_DEV_API_PROXY;

export default defineConfig({
  ...(apiProxy ? { server: { proxy: { '/graphql': apiProxy, '/uploads': apiProxy } } } : {}),
  plugins: [
    react(),
    // <meta name="involute-version"> carries the build's source SHA (INV-1146).
    { name: 'involute-version-meta', transformIndexHtml: (html) => withInvoluteVersion(html, process.env.INVOLUTE_BUILD_SHA) },
  ],
});
