import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Serve the built web app from the API process when INVOLUTE_WEB_DIST is set
 * (single-container deployments). SPA routing: extensionless paths fall back
 * to index.html; unknown asset paths 404. Returns false when the path is not
 * handled so the request falls through to GraphQL.
 */
export function handleWebStatic(
  webDistDir: string,
  pathname: string,
  response: ServerResponse,
): boolean {
  const rootDir = resolve(webDistDir);
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0')) {
    return false;
  }

  const relative = decoded.replace(/^\/+/, '');
  const candidate = normalize(join(rootDir, relative));
  if (!candidate.startsWith(rootDir)) {
    response.statusCode = 404;
    response.end('Not found');
    return true;
  }

  let filePath = candidate;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    if (extname(decoded)) {
      response.statusCode = 404;
      response.end('Not found');
      return true;
    }
    // SPA fallback.
    filePath = join(rootDir, 'index.html');
    if (!existsSync(filePath)) {
      response.statusCode = 404;
      response.end('Not found');
      return true;
    }
  }

  const stat = statSync(filePath);
  const ext = extname(filePath).toLowerCase();
  response.statusCode = 200;
  response.setHeader('content-type', MIME_TYPES[ext] ?? 'application/octet-stream');
  response.setHeader('content-length', stat.size);
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader(
    'cache-control',
    ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  );
  createReadStream(filePath).pipe(response);
  return true;
}
