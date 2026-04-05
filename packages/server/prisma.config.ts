import { defineConfig } from 'prisma/config';

import { loadProjectEnvironment } from './prisma/env.ts';

loadProjectEnvironment();

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://involute:involute@127.0.0.1:5434/involute?schema=public',
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --experimental-strip-types prisma/seed.ts',
  },
  schema: 'prisma/schema.prisma',
});
