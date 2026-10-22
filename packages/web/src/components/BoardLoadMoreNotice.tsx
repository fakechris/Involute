import { Btn } from './Primitives';

interface BoardLoadMoreNoticeProps {
  errorMessage: string | null;
  hasMoreIssues: boolean;
  isLoadingMoreIssues: boolean;
  loadedCount?: number | undefined;
  totalCount?: number | undefined;
  /** What the total counts, e.g. "in this project" / "in this team". */
  scopeLabel?: string | undefined;
  onLoadMore: () => void;
}

export function BoardLoadMoreNotice({
  errorMessage,
  hasMoreIssues,
  isLoadingMoreIssues,
  loadedCount,
  totalCount,
  scopeLabel = 'in this team',
  onLoadMore,
}: BoardLoadMoreNoticeProps) {
  if (!hasMoreIssues && !errorMessage) {
    return null;
  }

  const noticeText = errorMessage
    ? errorMessage
    : loadedCount && totalCount
      ? `Showing the first ${loadedCount} of ${totalCount} issues ${scopeLabel}.`
      : 'Showing the first page of issues.';

  return (
    <section
      className={errorMessage ? 'load-more-notice load-more-notice--error' : 'load-more-notice'}
      role={errorMessage ? 'alert' : undefined}
    >
      <p className="load-more-notice__text">{noticeText}</p>
      {hasMoreIssues ? (
        <Btn variant="subtle" disabled={isLoadingMoreIssues} onClick={onLoadMore}>
          {isLoadingMoreIssues ? 'Loading more issues…' : 'Load more issues'}
        </Btn>
      ) : null}
    </section>
  );
}
