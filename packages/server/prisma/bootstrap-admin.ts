import { PrismaClient } from '@prisma/client';

import { ensureAdminUsers } from './admin-helpers.ts';
import { loadProjectEnvironment } from './env.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const emails = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : (process.env.ADMIN_EMAIL_ALLOWLIST ?? process.env.GOOGLE_OAUTH_ADMIN_EMAILS ?? '')
      .split(',');

  const admins = await ensureAdminUsers(prisma, emails);

  if (admins.length === 0) {
    throw new Error(
      'No admin emails were provided. Pass one or more emails as arguments or set ADMIN_EMAIL_ALLOWLIST.',
    );
  }

  process.stdout.write(`${JSON.stringify({ admins }, null, 2)}\n`);
}

main()
  .catch((error: unknown) => {
    console.error('Failed to bootstrap admin users.');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
