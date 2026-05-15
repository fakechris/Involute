interface BoardLoadMoreNoticeProps {
  errorMessage: string | null;
  hasMoreIssues: boolean;
  isLoadingMoreIssues: boolean;
  onLoadMore: () => void;
}

export function BoardLoadMoreNotice({
  errorMessage,
  hasMoreIssues,
  isLoadingMoreIssues,
  onLoadMore,
}: BoardLoadMoreNoticeProps) {
  if (!hasMoreIssues && !errorMessage) {
    return null;
  }

  return (
    <section
      className={`shell-notice${errorMessage ? ' shell-notice--error' : ''}`}
      role={errorMessage ? 'alert' : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '6px 14px', margin: '0 var(--content-gutter)', flexShrink: 0 }}
    >
      <p style={{ margin: 0, fontSize: 11 }}>
        {errorMessage ??
          'Showing the current page of issues. Load more to continue browsing this team.'}
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
