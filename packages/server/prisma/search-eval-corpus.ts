export interface EvalDocument {
  id: string;
  title: string;
  description?: string;
}

export interface EvalQuery {
  query: string;
  relevant: readonly string[];
}

export const documents: readonly EvalDocument[] = [
  { id: 'work-export', title: '工单导出', description: '导出已关闭的工单用于月度统计。' },
  { id: 'work-import', title: '工单导入失败重试' },
  { id: 'work-watch', title: '订阅工单状态变化' },
  { id: 'invoice', title: '人工单据归档' },
  { id: 'invoice-repeat', title: '人工单据改为人工单据批量录入' },
  { id: 'sync-tool', title: '同步工具安装说明' },
  { id: 'credential', title: '项目令牌轮换', description: '更新 API 凭据，不中断同步任务。' },
  { id: 'vault-key', title: '凭据快照恢复', description: '从备份找回 API 凭据。' },
  { id: 'contract', title: '合同审批', description: '编辑验收标准并记录审批意见。' },
  { id: 'candidate', title: '候选队列的批量审批' },
  { id: 'candidate-sort', title: '候选队列排序不稳定' },
  { id: 'board', title: '看板拖拽', description: '修复在列之间移动卡片时的跳动。' },
  { id: 'board-filter', title: '保存看板筛选条件' },
  { id: 'audit', title: '审计日志分页' },
  { id: 'audit-export', title: '下载权限变更', description: '导出权限变更的审计日志。' },
  { id: 'deploy-rollback', title: '部署失败后回滚', description: '断网时执行回滚。' },
  { id: 'deploy-plan', title: '灰度发布看板' },
  { id: 'evidence', title: '可信证据验证' },
  { id: 'evidence-split', title: '操作有证据', description: '提交后验证写操作的结果。' },
  { id: 'attachment', title: '附件上传超时' },
  { id: 'attachment-meta', title: '提取附件文本供全文检索' },
  { id: 'webhook', title: 'Webhook 签名轮换' },
  { id: 'webhook-fail', title: 'Webhook 投递失败自动重试' },
  { id: 'quote', title: '检索转义引号与百分号' },
  { id: 'assignment', title: '分配负责人' },
  { id: 'unassign', title: '取消分配负责人' },
  { id: 'reindex', title: '向量索引重建', description: '使用后台任务重新索引历史记录。' },
  { id: 'total', title: '记录总数异常' },
  { id: 'search-metrics', title: '全文检索延迟指标' },
  { id: 'idempotency', title: '导入任务幂等键冲突' },
  { id: 'idempotency-note', title: '同步任务去重', description: '相同的幂等键只创建一次事件。' },
  { id: 'outbox', title: '事件发件箱积压' },
  { id: 'clipboard', title: '剪贴板复制失败' },
  { id: 'rare-term', title: '启用澄石栈回填', description: '澄石栈是虚构的项目代号。' },
  { id: 'rare-term-other', title: '清理旧的澄石栈任务' },
  { id: 'retention', title: '审核历史记录的保留期限' },
  { id: 'export-format', title: '导出 CSV 时保留换行' },
  { id: 'timezone', title: '时区设置导致日期显示异常' },
  { id: 'notifications', title: '发送候选审批通知' },
  { id: 'long-history', title: '恢复已归档工单的长期历史记录' },
  { id: 'catalog', title: '令牌池告警', description: '显示当前可用令牌数。' },
  { id: 'faq', title: '全文检索帮助', description: '如何检索审计日志、附件和评论。' },
];

export const queries: readonly EvalQuery[] = [
  { query: '工单', relevant: ['work-export', 'work-import', 'work-watch', 'long-history'] },
  { query: '工单导入', relevant: ['work-import'] },
  { query: '工单 导出', relevant: ['work-export'] },
  { query: '候选审批', relevant: ['candidate', 'notifications'] },
  { query: '候选队列', relevant: ['candidate', 'candidate-sort'] },
  { query: '看板', relevant: ['board', 'board-filter', 'deploy-plan'] },
  { query: '看板拖拽', relevant: ['board'] },
  { query: '审计日志', relevant: ['audit', 'audit-export'] },
  { query: '证据验证', relevant: ['evidence', 'evidence-split'] },
  { query: '附件', relevant: ['attachment', 'attachment-meta'] },
  { query: '全文检索', relevant: ['attachment-meta', 'quote', 'search-metrics', 'faq'] },
  { query: 'Webhook 签名', relevant: ['webhook'] },
  { query: 'api 凭据', relevant: ['credential', 'vault-key'] },
  { query: 'CSV 导出', relevant: ['export-format'] },
  { query: '项目令牌', relevant: ['credential'] },
  { query: '分配负责人', relevant: ['assignment', 'unassign'] },
  { query: '幂等键', relevant: ['idempotency', 'idempotency-note'] },
  { query: '澄石栈', relevant: ['rare-term', 'rare-term-other'] },
  { query: '回滚', relevant: ['deploy-rollback'] },
  { query: '搜', relevant: [] },
];
