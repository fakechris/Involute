import { describe, expect, it } from 'vitest';

import { impactExcerpt, incidentTimestamps, renderPostmortemDraft } from './postmortem.ts';
import type { TimelineEntry } from './work-activity-timeline.ts';

// INV-1212: the draft's timeline and impact quote, shaped like the real
// retroactively declared incident INV-1207 (declared 2026-10-15, impact on
// 2026-10-10 01:55–02:10 UTC, three-section description).
const DECLARED = new Date('2026-10-15T06:46:36.824Z');
const DESCRIPTION = [
  '### 1. 目标与架构定位',
  '2026-10-09 约 18:50 PDT，批量删除 29 个容器与 23 个镜像。',
  '',
  '影响（本机开发环境，非生产）：',
  '- qdrant 向量数据约 1.76GB 不可恢复；',
  '',
  '### 2. 核心功能与交付范围',
  '- 时间（PDT，约值）：18:50 用户请求',
  '',
  '### 3. 验收标准与验证方案',
  '- 复盘（6 节）作为附件挂上。',
].join('\n');

function starred(key: string, at: string, summary: string): TimelineEntry {
  return {
    key, kind: 'STATE', at: new Date(at), actor: null, actorKind: null, summary, detail: null, url: null,
    changes: [], revision: null, sourceId: key, star: null,
  } as TimelineEntry;
}

function draft(overrides: { description?: string | null; starredEntries?: TimelineEntry[]; withTimestamps?: boolean } = {}) {
  const timestamps = incidentTimestamps(
    overrides.withTimestamps === false
      ? { impactStartedAt: null, detectedAt: null, mitigatedAt: null, resolvedAt: null }
      : {
          impactStartedAt: new Date('2026-10-10T01:55:00.000Z'),
          detectedAt: new Date('2026-10-10T02:00:00.000Z'),
          mitigatedAt: new Date('2026-10-10T02:05:00.000Z'),
          resolvedAt: new Date('2026-10-10T02:10:00.000Z'),
        },
  );
  return renderPostmortemDraft({
    identifier: 'INV-1207', title: 'OrbStack 误删', severity: 'SEV2',
    description: overrides.description === undefined ? DESCRIPTION : overrides.description,
    stateName: 'In Review', declaredAt: DECLARED, isIncident: true, timestamps,
    starred: overrides.starredEntries ?? [
      starred('a', '2026-10-15T06:46:36.824Z', 'Created'),
      starred('b', '2026-10-15T06:51:47.717Z', 'Resolved at set'),
    ],
    followUps: [],
  });
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  const next = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

describe('postmortem draft (INV-1212)', () => {
  it('merges the impact timestamps into the timeline, sorted with starred entries by time', () => {
    const markdown = draft();
    expect(markdown).toContain('## 3. 时间线（自动：影响时间戳 + 标星条目）');
    const timeline = section(markdown, '## 3. 时间线');
    const rows = timeline.split('\n').filter((line) => /^\| \d{4}-/.test(line));
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.slice(2, 22))).toEqual([
      '2026-10-10 01:55 UTC', '2026-10-10 02:00 UTC', '2026-10-10 02:05 UTC', '2026-10-10 02:10 UTC',
      '2026-10-15 06:46 UTC', '2026-10-15 06:51 UTC',
    ]);
    expect(rows[0]).toContain('影响开始');
    expect(rows[0]).toContain('影响时间戳');
    expect(rows[1]).toContain('发现');
    expect(rows[2]).toContain('缓解');
    expect(rows[3]).toContain('解决');
    expect(rows[4]).toContain('Created');
    expect(rows[4]).toContain('标星条目');
  });

  it('lists recorded timestamps even without starred entries, and skips unrecorded ones', () => {
    const timeline = section(
      renderPostmortemDraft({
        identifier: 'INV-1', title: 'x', severity: 'SEV3', description: null, stateName: 'In Progress', declaredAt: DECLARED,
        isIncident: true, starred: [], followUps: [],
        timestamps: incidentTimestamps({ impactStartedAt: new Date('2026-10-10T01:55:00Z'), detectedAt: null, mitigatedAt: null, resolvedAt: null }),
      }),
      '## 3. 时间线',
    );
    const rows = timeline.split('\n').filter((line) => /^\| \d{4}-/.test(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('影响开始');
    expect(timeline).toContain('尚无标星条目');
  });

  it('keeps the no-entries hint when there is nothing to list', () => {
    const timeline = section(draft({ starredEntries: [], withTimestamps: false }), '## 3. 时间线');
    expect(timeline).toContain('尚无标星条目');
    expect(timeline).not.toContain('| 时间 |');
  });

  it('quotes only the impact part of a three-section description', () => {
    const impact = section(draft(), '## 2. 影响');
    expect(impact).toContain('> 2026-10-09 约 18:50 PDT，批量删除 29 个容器与 23 个镜像。');
    expect(impact).toContain('> - qdrant 向量数据约 1.76GB 不可恢复；');
    expect(impact).not.toContain('###');
    expect(impact).not.toContain('复盘（6 节）作为附件挂上');
    expect(impact).not.toContain('用户请求');
  });

  it('extracts the impact excerpt: section 1 body, text before the first heading, or the whole description', () => {
    expect(impactExcerpt(DESCRIPTION)).toBe('2026-10-09 约 18:50 PDT，批量删除 29 个容器与 23 个镜像。\n\n影响（本机开发环境，非生产）：\n- qdrant 向量数据约 1.76GB 不可恢复；');
    expect(impactExcerpt('数据库不可写\n\n### 备注\n其他')).toBe('数据库不可写');
    expect(impactExcerpt('全站 502，持续 10 分钟')).toBe('全站 502，持续 10 分钟');
    expect(impactExcerpt('### 背景\n只有一个别的标题')).toBe('### 背景\n只有一个别的标题');
    expect(impactExcerpt('  ')).toBeNull();
    expect(impactExcerpt(null)).toBeNull();
  });
});
