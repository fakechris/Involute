import { PrismaClient } from '@prisma/client';

import { issueAgentCredential, parseAgentScopes } from '../src/agent-credentials.ts';
import { deactivateActor, transferActorOwner } from '../src/actor-lifecycle.ts';
import { provisionServiceActor } from '../src/service-actors.ts';
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
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = rawArgs.filter((arg) => arg !== '--');

  if (command === 'create') {
    const [teamKey, name, email, expiresAtValue] = args;
    if (!teamKey || !name || !email) {
      throw new Error('Usage: agent:create <team-key> <name> <email> [expires-at] --owner <human-email> [--scopes ...] [--handle mia] [--runtime lumenbox] [--description ...]');
    }
    const scopes = parseAgentScopes(readFlag(args, 'scopes'));
    const expiresAt = expiresAtValue && !expiresAtValue.startsWith('--') ? new Date(expiresAtValue) : null;
    const { credential, token } = await issueAgentCredential(prisma, {
      description: readFlag(args, 'description'),
      email,
      expiresAt,
      handle: readFlag(args, 'handle'),
      name,
      ownerId: await resolveOwnerId(readFlag(args, 'owner')),
      runtime: readFlag(args, 'runtime'),
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
        teamId: true,
        user: { select: { email: true, id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    process.stdout.write(`${JSON.stringify({ credentials }, null, 2)}\n`);
    return;
  }

  if (command === 'deactivate') {
    const [handleOrId] = args;
    if (!handleOrId) throw new Error('Usage: agent:deactivate <handle|id> --by <human-email> [--reason ...]');
    const by = await requireHuman(readFlag(args, 'by'));
    const actor = await findActor(handleOrId);
    const updated = await deactivateActor(prisma, {
      actorId: actor.id,
      by: { actorId: by.id, actorKind: 'HUMAN' },
      reason: readFlag(args, 'reason'),
    });
    process.stdout.write(`${JSON.stringify({ actor: { deactivatedAt: updated.deactivatedAt, handle: updated.handle, id: updated.id } }, null, 2)}\n`);
    return;
  }

  if (command === 'transfer-owner') {
    const [handleOrId] = args;
    if (!handleOrId) throw new Error('Usage: agent:transfer-owner <handle|id> --to <human-email> --by <human-email> [--reason ...]');
    const by = await requireHuman(readFlag(args, 'by'));
    const to = await requireHuman(readFlag(args, 'to'));
    const actor = await findActor(handleOrId);
    const updated = await transferActorOwner(prisma, {
      actorId: actor.id,
      by: { actorId: by.id, actorKind: 'HUMAN' },
      newOwnerId: to.id,
      reason: readFlag(args, 'reason'),
    });
    process.stdout.write(`${JSON.stringify({ actor: { handle: updated.handle, id: updated.id, ownerId: updated.ownerId } }, null, 2)}\n`);
    return;
  }

  if (command === 'service') {
    const [name] = args;
    const handle = readFlag(args, 'handle');
    if (!name || !handle) throw new Error('Usage: agent:service <name> --handle <handle> --owner <human-email> [--description ...] [--email ...]');
    const owner = await requireHuman(readFlag(args, 'owner'));
    const created = await provisionServiceActor(prisma, {
      description: readFlag(args, 'description'),
      email: readFlag(args, 'email'),
      handle,
      name,
      ownerId: owner.id,
    });
    process.stdout.write(`${JSON.stringify({ actor: created }, null, 2)}\n`);
    return;
  }

  throw new Error('Usage: agent-credential <create|revoke|list|deactivate|transfer-owner|service> ...');
}

async function resolveOwnerId(email: string | null): Promise<string> {
  if (!email) {
    throw new Error('--owner <human-email> is required: a new agent needs a human accountable for it.');
  }
  return (await requireHuman(email)).id;
}

async function requireHuman(email: string | null): Promise<{ id: string }> {
  if (!email) throw new Error('A human email is required.');
  const human = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { actorKind: true, deactivatedAt: true, id: true },
  });
  if (!human || human.actorKind !== 'HUMAN' || human.deactivatedAt) {
    throw new Error(`No active HUMAN actor with email ${email}.`);
  }
  return { id: human.id };
}

async function findActor(handleOrId: string): Promise<{ id: string }> {
  const byHandle = await prisma.user.findUnique({ where: { handle: handleOrId.replace(/^@/, '').toLowerCase() }, select: { id: true } });
  if (byHandle) return byHandle;
  const byId = await prisma.user.findUnique({ where: { id: handleOrId }, select: { id: true } }).catch(() => null);
  if (byId) return byId;
  throw new Error(`No actor with handle or id ${handleOrId}.`);
}

main()
  .catch((error: unknown) => {
    console.error('Agent credential command failed.');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
