import { defineConfig } from 'prisma/config';

import { loadProjectEnvironment } from './prisma/env.ts';

loadProjectEnvironment();
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required.');
}

export default defineConfig({
  datasource: {
    url: databaseUrl,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --experimental-strip-types prisma/seed.ts',
  },
  schema: 'prisma/schema.prisma',
});
