import type { CommitmentStatus, Issue, IssueSeverity } from '@prisma/client';

import { buildReadableIssueWhere } from './access-control.js';
import type { GraphQLContext } from './auth.js';
import { incidentNeedsPostmortem } from './incident-closure.js';
import { INCIDENT_TIME_FIELDS, type IncidentTimeField } from './incident-timestamps.js';
import { INCIDENT_LABEL_NAME } from './labels.js';
import { workTimelineFor, type TimelineEntry } from './work-activity-timeline.js';

/**
 * The postmortem (INV-1126, docs/postmortem.md): six sections, drafted from
 * what the server already knows — the incident, its impact timestamps, the
 * timeline entries someone starred as key events (INV-1116) and the follow-ups
 * derived from it — and completed by a person or agent, then attached to the
 * incident as a file (INV-1003). A SEV1/SEV2 incident cannot close without it.
 */
export const POSTMORTEM_SECTIONS = ['摘要', '影响', '时间线', '促成因素', '教训', 'Follow-ups'] as const;

/** Incident impact timestamps (INV-1125), labelled for the draft. */
const TIMESTAMP_LABELS: Record<IncidentTimeField, string> = {
  impactStartedAt: '影响开始',
  detectedAt: '发现',
  mitigatedAt: '缓解',
  resolvedAt: '解决',
};

export interface PostmortemTimestamp {
  field: string;
  label: string;
  at: Date | null;
}

export interface PostmortemFollowUp {
  identifier: string;
  title: string;
  commitmentStatus: CommitmentStatus;
  stateName: string;
}

export interface PostmortemDraftInput {
  identifier: string;
  title: string;
  severity: IssueSeverity | null;
  description: string | null;
  stateName: string;
  declaredAt: Date;
  isIncident: boolean;
  timestamps: PostmortemTimestamp[];
  starred: TimelineEntry[];
  followUps: PostmortemFollowUp[];
}

export function incidentTimestamps(work: Pick<Issue, IncidentTimeField>): PostmortemTimestamp[] {
  return INCIDENT_TIME_FIELDS.map((field) => ({ field, label: TIMESTAMP_LABELS[field], at: work[field] }));
}

const utc = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const actorName = (entry: TimelineEntry) => (entry.actor ? entry.actor.name ?? entry.actor.email ?? entry.actor.id : '系统');

export function renderPostmortemDraft(input: PostmortemDraftInput): string {
  const lines: string[] = [];
  const [summary, impact, timeline, factors, lessons, followUps] = POSTMORTEM_SECTIONS;
  lines.push(`# 复盘：${input.identifier} ${input.title}`, '');
  lines.push(
    `> 草稿，由 Involute 生成于 ${utc(new Date())}。补全标 TODO 的段落后作为附件挂到 ${input.identifier}` +
      (input.isIncident && incidentNeedsPostmortem(input.severity) ? `（${input.severity} 事故收尾必须有复盘附件）。` : '。'),
    '',
  );

  lines.push(`## 1. ${summary}`, '', '<!-- TODO：两三句话：发生了什么、谁受影响、如何恢复。 -->', '');
  lines.push(`- 工单：${input.identifier} · 严重度 ${input.severity ?? '未设置'} · 当前状态 ${input.stateName}`, '');

  lines.push(`## 2. ${impact}`, '');
  lines.push(`- 申报时间：${utc(input.declaredAt)}`);
  for (const stamp of input.timestamps) lines.push(`- ${stamp.label}：${stamp.at ? utc(stamp.at) : '未记录'}`);
  lines.push('', '申报时的影响描述：', '');
  const described = input.description?.trim();
  lines.push(described ? described.split('\n').map((line) => `> ${line}`).join('\n') : '> （无）', '');
  lines.push('<!-- TODO：影响范围（用户数、功能、数据）、持续时长、是否违反 SLA。 -->', '');

  lines.push(`## 3. ${timeline}（自动，取标星条目）`, '');
  if (input.starred.length === 0) {
    lines.push('尚无标星条目。用 `work_timeline(action: "star", entry_key)` 或事故页时间线的星标标记关键事件，再重新生成草稿。', '');
  } else {
    lines.push('| 时间 | 事件 | 操作者 |', '|---|---|---|');
    for (const entry of input.starred) {
      const detail = entry.detail?.trim() ? ` — ${entry.detail.trim().slice(0, 200)}` : '';
      lines.push(`| ${utc(entry.at)} | ${cell(entry.summary + detail)} | ${cell(actorName(entry))} |`);
    }
    lines.push('');
  }

  lines.push(`## 4. ${factors}`, '', '<!-- TODO：列出多个促成因素（技术、流程、沟通、监控），不追单一根因；写事实，不追责个人。 -->', '- ', '- ', '');

  lines.push(`## 5. ${lessons}`, '', '- 做得好的：', '- 需要改进的：', '- 侥幸之处：', '');

  lines.push(`## 6. ${followUps}`, '');
  if (input.followUps.length === 0) {
    lines.push(
      `尚无 follow-up。把可执行点以 ISSUE 提出并 DERIVED_FROM ${input.identifier}（\`work_propose(related_work_id: "${input.identifier}", related_work_type: "DERIVED_FROM")\`），或在事故描述中写明"无可执行点"——否则事故不能进入 Done。`,
      '',
    );
  } else {
    for (const item of input.followUps) {
      const status = item.commitmentStatus === 'COMMITTED' ? item.stateName : item.commitmentStatus === 'CANDIDATE' ? '待承诺（Candidates）' : '已拒绝';
      lines.push(`- ${item.identifier} ${item.title} — ${status}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface PostmortemDraft {
  workId: string;
  identifier: string;
  isIncident: boolean;
  severity: IssueSeverity | null;
  postmortemRequired: boolean;
  timestamps: PostmortemTimestamp[];
  starredCount: number;
  timelineTruncated: boolean;
  followUps: PostmortemFollowUp[];
  filename: string;
  markdown: string;
}

/** The draft for work the viewer may read (MCP work_timeline action "postmortem_draft"). */
export async function postmortemDraftFor(context: GraphQLContext, idOrIdentifier: string): Promise<PostmortemDraft> {
  // Reads the starred entries with the viewer's read check (INV-1116).
  const timeline = await workTimelineFor(context, idOrIdentifier, { starredOnly: true });
  const work = await context.prisma.issue.findUniqueOrThrow({
    where: { id: timeline.workId },
    include: { labels: { select: { name: true } }, state: { select: { name: true } } },
  });
  const readable = buildReadableIssueWhere(context);
  const derived = await context.prisma.workLink.findMany({
    where: { type: 'DERIVED_FROM', toId: work.id, ...(readable ? { from: readable } : {}) },
    select: { from: { select: { identifier: true, title: true, commitmentStatus: true, state: { select: { name: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  const followUps = derived.map(({ from }) => ({ identifier: from.identifier, title: from.title, commitmentStatus: from.commitmentStatus, stateName: from.state.name }));
  const isIncident = work.labels.some((label) => label.name.toLowerCase() === INCIDENT_LABEL_NAME.toLowerCase());
  const timestamps = incidentTimestamps(work);
  const markdown = renderPostmortemDraft({
    identifier: work.identifier,
    title: work.title,
    severity: work.severity,
    description: work.description,
    stateName: work.state.name,
    declaredAt: work.createdAt,
    isIncident,
    timestamps,
    starred: timeline.entries,
    followUps,
  });
  return {
    workId: work.id,
    identifier: work.identifier,
    isIncident,
    severity: work.severity,
    postmortemRequired: isIncident && incidentNeedsPostmortem(work.severity),
    timestamps,
    starredCount: timeline.entries.length,
    timelineTruncated: timeline.truncated,
    followUps,
    filename: `postmortem-${work.identifier}.md`,
    markdown,
  };
}
