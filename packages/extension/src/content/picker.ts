import { buildSelector } from '../lib/selector';
import { extractStyles } from '../lib/styles';
import { redactText } from '../lib/redact';
import { truncate } from '../lib/ring-buffer';
import type { PickedElement } from '../lib/types';

/**
 * The element picker (INV-1147), injected into the tab on request. Hovering
 * outlines an element; a click records its selector, text (redacted, ≤200),
 * box in screenshot pixels and allowlisted computed styles; Esc cancels. The
 * overlay carries data-involute-capture so a capture can hide it, and the
 * click never reaches the page.
 */
const ATTRIBUTE = 'data-involute-capture';
const STATE_KEY = '__involuteCapturePicker';

type PickerWindow = Window & { [STATE_KEY]?: { stop: () => void } };

function start(): void {
  const host = window as PickerWindow;
  host[STATE_KEY]?.stop();

  const overlay = document.createElement('div');
  overlay.setAttribute(ATTRIBUTE, 'overlay');
  Object.assign(overlay.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', border: '2px solid #3e63dd',
    background: 'rgba(62, 99, 221, 0.12)', borderRadius: '2px', display: 'none', boxSizing: 'border-box',
  } satisfies Partial<CSSStyleDeclaration>);
  const label = document.createElement('div');
  label.setAttribute(ATTRIBUTE, 'label');
  Object.assign(label.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', background: '#3e63dd', color: '#fff',
    font: '12px/1.4 system-ui, sans-serif', padding: '2px 6px', borderRadius: '3px', display: 'none', maxWidth: '60vw',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  } satisfies Partial<CSSStyleDeclaration>);
  label.textContent = 'Click the element · Esc to cancel';
  document.documentElement.append(overlay, label);

  let hovered: Element | null = null;
  const own = (target: EventTarget | null) => target instanceof Element && target.hasAttribute(ATTRIBUTE);

  const onMove = (event: MouseEvent) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || own(target) || target === hovered) return;
    hovered = target;
    const rect = target.getBoundingClientRect();
    Object.assign(overlay.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    Object.assign(label.style, { display: 'block', left: `${Math.max(0, rect.left)}px`, top: `${rect.top > 24 ? rect.top - 22 : rect.bottom + 4}px` });
    label.textContent = `${target.tagName.toLowerCase()} · click to pick · Esc to cancel`;
  };

  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const onClick = (event: MouseEvent) => {
    swallow(event);
    const target = hovered ?? document.elementFromPoint(event.clientX, event.clientY);
    stop();
    if (!target || own(target)) {
      void chrome.runtime.sendMessage({ type: 'picker.cancelled' });
      return;
    }
    void chrome.runtime.sendMessage({ type: 'picker.picked', element: describeElement(target) });
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    swallow(event);
    stop();
    void chrome.runtime.sendMessage({ type: 'picker.cancelled' });
  };

  function stop() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('mouseup', swallow, true);
    document.removeEventListener('pointerdown', swallow, true);
    document.removeEventListener('pointerup', swallow, true);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    label.remove();
    delete host[STATE_KEY];
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('mousedown', swallow, true);
  document.addEventListener('mouseup', swallow, true);
  document.addEventListener('pointerdown', swallow, true);
  document.addEventListener('pointerup', swallow, true);
  document.addEventListener('keydown', onKey, true);
  host[STATE_KEY] = { stop };
}

/** Selector, text, box (screenshot pixels) and allowlisted styles of one element. */
export function describeElement(element: Element): PickedElement {
  const rect = element.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // Text the person can see; a form control's value is never read.
  const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
  const rawText = isField
    ? element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? ''
    : (element as HTMLElement).innerText ?? element.textContent ?? '';
  const text = truncate(redactText(rawText.replace(/\s+/g, ' ').trim()), 200);
  return {
    selector: buildSelector(element),
    text: text || null,
    box: {
      x: Math.round(rect.left * dpr),
      y: Math.round(rect.top * dpr),
      width: Math.round(rect.width * dpr),
      height: Math.round(rect.height * dpr),
    },
    styles: extractStyles(getComputedStyle(element)),
  };
}

start();
