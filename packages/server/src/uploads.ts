import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultUploadsDirectory = resolve(fileURLToPath(import.meta.url), '../../uploads');

export function getUploadsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.INVOLUTE_UPLOADS_DIR?.trim();
  return configured ? resolve(configured) : defaultUploadsDirectory;
}
