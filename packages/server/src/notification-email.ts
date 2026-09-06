import type { PrismaClient } from '@prisma/client';

import type { NotificationEmailEnvironment } from './environment.js';

// Small batching window: notifications produced by a burst of run reports
// collapse into one digest mail instead of one mail per event.
const BATCH_WINDOW_MS = 2 * 60_000;
const MAX_EMAIL_ATTEMPTS = 5;
const MAX_ITEMS_PER_MAIL = 20;
const MAX_RECIPIENTS_PER_SWEEP = 50;

export interface NotificationEmailRuntime {
  appOrigin: string;
  email: NotificationEmailEnvironment;
}

export interface OutgoingNotificationEmail {
  html: string;
  subject: string;
  text: string;
  to: string;
}

export type NotificationEmailSender = (mail: OutgoingNotificationEmail) => Promise<void>;

export function isNotificationEmailReady(runtime: NotificationEmailRuntime): boolean {
  return runtime.email.enabled && Boolean(runtime.email.host) && Boolean(runtime.email.from);
}

export function createNotificationEmailSender(runtime: NotificationEmailEnvironment): NotificationEmailSender {
  // Lazy import keeps nodemailer out of every code path that merely touches
  // notification rows.
  return async (mail) => {
    const { createTransport } = await import('nodemailer');
    const transport = createTransport({
      ...(runtime.user
        ? {
            auth: runtime.password
              ? { pass: runtime.password, user: runtime.user }
              : { user: runtime.user },
          }
        : {}),
      host: runtime.host ?? 'localhost',
      port: runtime.port,
      secure: runtime.port === 465,
    });
    await transport.sendMail({
      from: runtime.from ?? mail.to,
      html: mail.html,
      subject: mail.subject,
      text: mail.text,
      to: mail.to,
    });
  };
}

/**
 * Deliver one digest mail per user for unread, not-yet-emailed notifications.
 * Returns the number of users notified. Failures increment emailAttempts and
 * stay queued for the next sweep up to MAX_EMAIL_ATTEMPTS.
 */
export async function processNotificationEmails(
  prisma: PrismaClient,
  runtime: NotificationEmailRuntime,
  send: NotificationEmailSender,
): Promise<number> {
  if (!isNotificationEmailReady(runtime)) {
    return 0;
  }

  const cutoff = new Date(Date.now() - BATCH_WINDOW_MS);
  // Rows with a null user email cannot be mailed; the runtime guard below
  // skips them instead of filtering in SQL (nullable `not: null` shapes vary
  // across Prisma versions).
  const pending = await prisma.notification.findMany({
    include: {
      user: { select: { email: true, notificationPrefs: true } },
      work: { select: { identifier: true, id: true, title: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_RECIPIENTS_PER_SWEEP * MAX_ITEMS_PER_MAIL,
    where: {
      createdAt: { lt: cutoff },
      emailAttempts: { lt: MAX_EMAIL_ATTEMPTS },
      emailedAt: null,
    },
  });
  if (pending.length === 0) {
    return 0;
  }

  const byUser = new Map<string, typeof pending>();
  for (const notification of pending) {
    const prefs = notification.user.notificationPrefs as { emailNotifications?: unknown } | null;
    if (prefs && prefs.emailNotifications === false) {
      continue;
    }
    const bucket = byUser.get(notification.userId) ?? [];
    bucket.push(notification);
    byUser.set(notification.userId, bucket);
  }

  let notifiedUsers = 0;
  for (const [userId, notifications] of byUser) {
    const email = notifications[0]?.user.email;
    if (!email) {
      continue;
    }
    const items = notifications.slice(0, MAX_ITEMS_PER_MAIL);
    const mail = buildDigestMail(runtime.appOrigin, email, items);
    try {
      await send(mail);
    } catch (error) {
      console.error('Failed to send notification email.');
      console.error(error);
      await prisma.notification.updateMany({
        where: { id: { in: notifications.map((item) => item.id) } },
        data: { emailAttempts: { increment: 1 } },
      });
      continue;
    }
    await prisma.notification.updateMany({
      where: { id: { in: items.map((item) => item.id) } },
      data: { emailedAt: new Date() },
    });
    notifiedUsers += 1;
    if (byUser.size >= MAX_RECIPIENTS_PER_SWEEP && notifiedUsers >= MAX_RECIPIENTS_PER_SWEEP) {
      break;
    }
  }
  return notifiedUsers;
}

function buildDigestMail(
  appOrigin: string,
  to: string,
  notifications: Array<{
    payload: unknown;
    type: string;
    work: { identifier: string; id: string; title: string } | null;
  }>,
): OutgoingNotificationEmail {
  const subject = `Involute: ${notifications.length} work item${notifications.length === 1 ? '' : 's'} need your attention`;
  const lines = notifications.map((notification) => {
    if (notification.work) {
      return `- [${notification.work.identifier}] ${notification.work.title} — ${notification.type}`;
    }
    return `- ${notification.type}`;
  });
  const text = [
    'Work in Involute is waiting on a human decision.',
    '',
    ...lines,
    '',
    appOrigin,
  ].join('\n');
  const html = [
    '<p>Work in Involute is waiting on a human decision.</p>',
    '<ul>',
    ...notifications.map((notification) => {
      const label = notification.work
        ? `[${notification.work.identifier}] ${escapeHtml(notification.work.title)}`
        : notification.type;
      const href = notification.work ? `${appOrigin}/work/${notification.work.id}` : appOrigin;
      return `  <li><a href="${href}">${label}</a> — ${escapeHtml(notification.type)}</li>`;
    }),
    '</ul>',
  ].join('\n');
  return { html, subject, text, to };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Retention: drop read notifications after 90 days and unread ones after 180,
 * so the inbox cannot grow without bound on long-lived instances.
 */
export async function sweepStaleNotifications(prisma: PrismaClient, now = new Date()): Promise<number> {
  const readCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60_000);
  const unreadCutoff = new Date(now.getTime() - 180 * 24 * 60 * 60_000);
  const { count } = await prisma.notification.deleteMany({
    where: {
      OR: [
        { readAt: { lt: readCutoff } },
        { createdAt: { lt: unreadCutoff }, readAt: null },
      ],
    },
  });
  return count;
}
