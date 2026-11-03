import { useApolloClient } from '@apollo/client/react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { WORK_PREVIEWS_QUERY } from '../work/queries';
import type { WorkPreview, WorkPreviewsQueryData, WorkPreviewsQueryVariables } from '../work/types';
import { findWorkReferences, workReferenceKey } from '../work/work-reference';
import { Badge } from './status';
import { StatusIcon } from './StatusIcon';

/**
 * Work references in prose (INV-1466).
 *
 * A description names other work all the time — "depends on INV-267", "the
 * decision is INV-683". Until now those names were dead text: a reader had
 * to go and look the number up. This component turns them into links: the
 * reference shows what it points at when the reader hovers it, and a click
 * opens the work item in a new tab so the page they are reading stays put.
 *
 * Three properties make it usable everywhere rather than on one page:
 *
 * - **The shape is generic.** "Letters, a dash, digits" — `INV-1446`,
 *   `LUM-398` and any other project's key all match; the server decides
 *   whether one names a work item, and the ones that do not (`UTF-8`) stay
 *   plain words.
 * - **One request per page.** Every reference on the page asks the server
 *   the same question, so the answers are collected and sent as one batch
 *   instead of one request per reference.
 * - **Nothing is shown that may not be read.** The server only answers with
 *   work the reader may open, so a reference to someone else's item stays a
 *   word.
 */

/** How long the app waits for more references before asking the server. */
const BATCH_DELAY_MS = 40;

/** The most references the server answers in one request (issue-preview.ts). */
const MAX_PREVIEW_IDENTIFIERS = 100;

interface WorkReferenceStore {
  /** The references the server answered, by reference key. */
  previews: Map<string, WorkPreview>;
  /** References already asked about, so the server is asked only once. */
  asked: Set<string>;
  /** References a reader has met, waiting to be asked about. */
  waiting: Set<string>;
  /** Bumped on every change, so subscribers know to look again. */
  version: number;
  request: (key: string) => void;
  subscribe: (listener: () => void) => () => void;
  notify: () => void;
}

const WorkReferenceContext = createContext<WorkReferenceStore | null>(null);

function createStore(): WorkReferenceStore {
  const previews = new Map<string, WorkPreview>();
  const asked = new Set<string>();
  const waiting = new Set<string>();
  const listeners = new Set<() => void>();

  const notify = () => {
    store.version += 1;
    for (const listener of listeners) listener();
  };

  const store: WorkReferenceStore = {
    previews,
    asked,
    waiting,
    version: 0,
    request(key) {
      if (asked.has(key) || waiting.has(key)) return;
      waiting.add(key);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify,
  };

  return store;
}

/**
 * Holds the references the page has met and asks the server about all of
 * them at once. Mount it once, above the routes.
 */
export function WorkReferenceProvider({ children }: { children: ReactNode }) {
  const store = useMemo(createStore, []);
  const client = useApolloClient();

  // Re-render when a reference is met, so the batch below picks it up.
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version);

  useEffect(() => {
    if (store.waiting.size === 0) return;
    const timer = window.setTimeout(() => {
      const batch = [...store.waiting];
      store.waiting.clear();
      for (const key of batch) store.asked.add(key);
      // Only the references not asked about yet, in pieces the server answers
      // whole: it reads the first MAX_PREVIEW_IDENTIFIERS of a request, so a
      // growing list would leave every later reference unanswered (INV-1537).
      for (let start = 0; start < batch.length; start += MAX_PREVIEW_IDENTIFIERS) {
        const chunk = batch.slice(start, start + MAX_PREVIEW_IDENTIFIERS);
        client
          .query<WorkPreviewsQueryData, WorkPreviewsQueryVariables>({
            query: WORK_PREVIEWS_QUERY,
            variables: { identifiers: chunk },
          })
          .then(({ data }) => {
            if (!data) return;
            for (const preview of data.issuePreviews) {
              store.previews.set(workReferenceKey(preview.reference), preview);
            }
            if (data.issuePreviews.length > 0) store.notify();
          })
          .catch(() => {
            // The server could not answer; the next reader to meet these asks again.
            for (const key of chunk) store.asked.delete(key);
          });
      }
    }, BATCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [client, store, store.version]);

  return <WorkReferenceContext.Provider value={store}>{children}</WorkReferenceContext.Provider>;
}

/** The store, or null when the page has no provider (nothing resolves then). */
function useWorkReferenceStore(): WorkReferenceStore | null {
  return useContext(WorkReferenceContext);
}

export interface WorkReferenceProps {
  /** The reference as written, e.g. `INV-1446`. */
  reference: string;
}

/**
 * One reference in prose. It becomes a link once the server says it names a
 * work item; until then — and forever, when it names none — it stays the
 * word it was.
 */
export function WorkReference({ reference }: WorkReferenceProps) {
  const store = useWorkReferenceStore();
  const key = workReferenceKey(reference);

  useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? () => store.version : () => 0,
    () => 0,
  );

  useEffect(() => {
    store?.request(key);
  }, [store, key]);

  const preview = store?.previews.get(key) ?? null;
  if (!preview) return <>{reference}</>;
  return <WorkReferenceLink preview={preview} label={reference} />;
}

/** The link and the card it opens on hover. */
function WorkReferenceLink({ preview, label }: { preview: WorkPreview; label: string }) {
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => () => cancelClose(), []);

  // The card lives outside the text it belongs to, so a clamped description
  // (a card on Candidates, Needs you or In Review) cannot cut it off. It is
  // placed against the viewport instead, and follows the reference while the
  // reader scrolls.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const anchor = anchorRef.current;
      const popup = popupRef.current;
      if (!anchor || !popup) return;
      const anchorRect = anchor.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const margin = 8;
      let left = anchorRect.left;
      if (left + popupRect.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - popupRect.width - margin);
      }
      let top = anchorRect.bottom + 6;
      if (top + popupRect.height > window.innerHeight - margin) {
        top = Math.max(margin, anchorRect.top - popupRect.height - 6);
      }
      popup.style.setProperty('--work-reference-top', `${top}px`);
      popup.style.setProperty('--work-reference-left', `${left}px`);
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <span className="work-reference">
      <a
        ref={anchorRef}
        className="work-reference__link"
        href={`/issue/${preview.identifier}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={open ? popupId : undefined}
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
        onFocus={() => {
          cancelClose();
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
      >
        {label}
      </a>
      {open
        ? createPortal(
            <div
              ref={popupRef}
              className="work-reference__popover"
              id={popupId}
              role="tooltip"
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              <div className="work-reference__head">
                <span className="work-reference__id mono">{preview.identifier}</span>
                <StatusIcon stateName={preview.stateName} size={12} />
                <span className="work-reference__state">{preview.stateName}</span>
              </div>
              <div className="work-reference__title">{preview.title}</div>
              {preview.excerpt ? <div className="work-reference__excerpt">{preview.excerpt}</div> : null}
              <div className="work-reference__meta">
                {preview.typeLabel ? (
                  <Badge tone="neutral" mono>
                    {preview.typeLabel}
                  </Badge>
                ) : null}
                <span className="work-reference__kind">{preview.kind}</span>
                {preview.repository ? <span className="work-reference__repo mono">{preview.repository}</span> : null}
                <span className="work-reference__team">{preview.teamKey}</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

/**
 * Plain text with its references linked — the gadget for surfaces that do
 * not render markdown (a list row's summary, a notification's body).
 */
export function WorkReferenceText({ text }: { text: string }) {
  const matches = findWorkReferences(text);
  if (matches.length === 0) return <>{text}</>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) parts.push(text.slice(cursor, match.start));
    parts.push(<WorkReference key={`${match.reference}-${index}`} reference={match.reference} />);
    cursor = match.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function noopSubscribe() {
  return () => {};
}
