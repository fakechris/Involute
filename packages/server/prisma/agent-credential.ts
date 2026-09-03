import { PrismaClient } from '@prisma/client';

import { issueAgentCredential, parseAgentScopes } from '../src/agent-credentials.ts';
import { loadProjectEnvironment } from './env.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'create') {
    const [teamKey, name, email, expiresAtValue] = args;
    if (!teamKey || !name || !email) {
      throw new Error('Usage: agent:create <team-key> <name> <email> [expires-at] [--scopes read,propose,claim,report,update,link]');
    }
    const scopes = parseAgentScopes(readFlag(args, 'scopes'));
    const expiresAt = expiresAtValue && !expiresAtValue.startsWith('--') ? new Date(expiresAtValue) : null;
    const { credential, token } = await issueAgentCredential(prisma, {
      email,
      expiresAt,
      name,
      scopes,
      teamKey,
    });
    process.stdout.write(`${JSON.stringify({ credential, token }, null, 2)}\n`);
    process.stderr.write('Store the token now; only its hash is persisted.\n');
    return;
  }

  if (command === 'revoke') {
    const [credentialId] = args;
    if (!credentialId) throw new Error('Usage: agent:revoke <credential-id>');
    const credential = await prisma.agentCredential.update({
      where: { id: credentialId },
      data: { revokedAt: new Date() },
      select: { id: true, revokedAt: true, userId: true },
    });
    process.stdout.write(`${JSON.stringify({ credential }, null, 2)}\n`);
    return;
  }

  if (command === 'list') {
    const credentials = await prisma.agentCredential.findMany({
      select: {
        createdAt: true,
        expiresAt: true,
        id: true,
        name: true,
        revokedAt: true,
        scopes: true,
        user: { select: { email: true, id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    process.stdout.write(`${JSON.stringify({ credentials }, null, 2)}\n`);
    return;
  }

  throw new Error('Usage: agent-credential <create|revoke|list> ...');
}

main()
  .catch((error: unknown) => {
    console.error('Agent credential command failed.');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
