import { useEffect, useId, useRef, useState, type FormEvent, type FormHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { Btn } from './Primitives';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogShellProps {
  /** `side`: a drawer from the right (long forms). `modal`: centred, max 520px (short forms). */
  variant: 'side' | 'modal';
  title: ReactNode;
  eyebrow?: ReactNode | undefined;
  /** The dialog's accessible name; defaults to the title when it is a string. */
  ariaLabel?: string | undefined;
  onClose: () => void;
  /** Label of the header Close button (default "Close"). */
  closeLabel?: string | undefined;
  /** Accessible name of the backdrop, which also closes. */
  backdropLabel?: string | undefined;
  /** Right-aligned actions, kept visible while the body scrolls. */
  footer?: ReactNode | undefined;
  /** When given, body and footer are one `<form>`, so a submit button in the footer submits it. */
  onSubmit?: ((event: FormEvent<HTMLFormElement>) => void) | undefined;
  formProps?: Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'children'> | undefined;
  formRef?: Ref<HTMLFormElement> | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * The one dialog container (docs/design-system.md §3.5): header (eyebrow,
 * title, Close), a padded scrolling body and a sticky right-aligned footer.
 * Escape and the backdrop close it; focus is trapped inside while it is open
 * and returns to where it was when it closes.
 */
export function DialogShell({
  variant,
  title,
  eyebrow,
  ariaLabel,
  onClose,
  closeLabel = 'Close',
  backdropLabel,
  footer,
  onSubmit,
  formProps,
  formRef,
  className,
  children,
}: DialogShellProps) {
  const frameRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  // Captured during the first render, before any child effect moves focus in.
  const [returnFocusTo] = useState<Element | null>(() => (typeof document === 'undefined' ? null : document.activeElement));

  useEffect(() => {
    const frame = frameRef.current;
    if (frame && !frame.contains(document.activeElement)) {
      const first = frame.querySelector<HTMLElement>(FOCUSABLE.split(',').map((selector) => `.dialog-shell__body ${selector}`).join(',')) ?? frame;
      first.focus();
    }
    return () => {
      if (returnFocusTo instanceof HTMLElement && returnFocusTo.isConnected) {
        returnFocusTo.focus();
      }
    };
  }, [returnFocusTo]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      // A popover inside (mention list, picker) that handled Escape keeps the dialog open.
      if (event.defaultPrevented) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !frameRef.current) {
      return;
    }
    const focusables = Array.from(frameRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const name = ariaLabel ?? (typeof title === 'string' ? title : undefined);
  const body = <div className="dialog-shell__body">{children}</div>;
  const footerNode = footer ? <div className="dialog-shell__footer">{footer}</div> : null;

  return (
    <div
      className={['dialog-shell', `dialog-shell--${variant}`, className].filter(Boolean).join(' ')}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      aria-labelledby={name ? undefined : titleId}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className="dialog-shell__backdrop"
        aria-label={backdropLabel ?? `Close ${name ?? 'dialog'}`}
        tabIndex={-1}
        onClick={onClose}
      />
      <section className="dialog-shell__frame" ref={frameRef} tabIndex={-1}>
        <header className="dialog-shell__header">
          <div className="dialog-shell__heading">
            {eyebrow ? <p className="dialog-shell__eyebrow">{eyebrow}</p> : null}
            <h2 className="dialog-shell__title" id={titleId}>{title}</h2>
          </div>
          <Btn variant="ghost" size="md" onClick={onClose}>{closeLabel}</Btn>
        </header>
        {onSubmit ? (
          <form {...formProps} ref={formRef} className="dialog-shell__form" onSubmit={onSubmit}>
            {body}
            {footerNode}
          </form>
        ) : (
          <>
            {body}
            {footerNode}
          </>
        )}
      </section>
    </div>
  );
}
