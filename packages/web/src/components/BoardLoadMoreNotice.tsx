interface BoardLoadMoreNoticeProps {
  errorMessage: string | null;
  hasMoreIssues: boolean;
  isLoadingMoreIssues: boolean;
  loadedCount?: number | undefined;
  totalCount?: number | undefined;
  scopeLabel?: string | undefined;
  onLoadMore: () => void;
}

export function BoardLoadMoreNotice({
  errorMessage,
  hasMoreIssues,
  isLoadingMoreIssues,
  loadedCount,
  totalCount,
  scopeLabel = '全团队共',
  onLoadMore,
}: BoardLoadMoreNoticeProps) {
  if (!hasMoreIssues && !errorMessage) {
    return null;
  }

  const noticeText = errorMessage
    ? errorMessage
    : loadedCount && totalCount
      ? `当前已加载前 ${loadedCount} 条工单（${scopeLabel} ${totalCount} 条）。点击加载剩余工单：`
      : '当前显示前一页工单。点击加载更多以继续浏览全量工单：';

  return (
    <section
      className={`shell-notice${errorMessage ? ' shell-notice--error' : ''}`}
      role={errorMessage ? 'alert' : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '6px 14px', margin: '0 var(--content-gutter)', flexShrink: 0 }}
    >
      <p style={{ margin: 0, fontSize: 13 }}>
        {noticeText}
      </p>
      {hasMoreIssues ? (
        <button
          type="button"
          className="board-load-more__button"
          disabled={isLoadingMoreIssues}
          onClick={onLoadMore}
        >
          {isLoadingMoreIssues ? 'Loading more issues…' : 'Load more issues'}
        </button>
      ) : null}
    </section>
  );
}
