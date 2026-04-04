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
      className={`board-message${errorMessage ? ' board-message--error' : ''}`}
      role={errorMessage ? 'alert' : undefined}
    >
      <p>
        {errorMessage ??
          'Showing the current page of issues. Load more to continue browsing this team.'}
      </p>
      {hasMoreIssues ? (
        <button
          type="button"
          className="issue-comment-composer__submit"
          disabled={isLoadingMoreIssues}
          onClick={onLoadMore}
        >
          {isLoadingMoreIssues ? 'Loading more issues…' : 'Load more issues'}
        </button>
      ) : null}
    </section>
  );
}
