import { PrismaClient } from '@prisma/client';

import { loadProjectEnvironment } from './env.ts';
import { seedDatabase } from './seed-helpers.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await seedDatabase(prisma);
}

main()
  .catch((error: unknown) => {
    console.error('Failed to seed database.');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
