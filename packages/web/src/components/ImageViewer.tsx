import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';

import { Btn } from './Primitives';

const ZOOMS = [50, 75, 100, 125, 150, 200, 300, 400] as const;

function clampZoom(index: number): number {
  return Math.min(ZOOMS.length - 1, Math.max(0, index));
}

/**
 * Full-page view of one already-rendered image. Zoom and rotation are data
 * attributes so the transform stays in CSS. Drag writes --image-x / --image-y
 * on the element. Escape is captured on the window so a board peek behind
 * this dialog stays open.
 */
export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [zoomIndex, setZoomIndex] = useState(ZOOMS.indexOf(100));
  const [turn, setTurn] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  function resetPan() {
    const img = imgRef.current;
    if (!img) return;
    img.style.setProperty('--image-x', '0px');
    img.style.setProperty('--image-y', '0px');
  }

  function stepZoom(direction: 1 | -1) {
    setZoomIndex((index) => clampZoom(index + direction));
    resetPan();
  }

  function turnBy(delta: number) {
    setTurn((value) => (value + delta + 4) % 4);
    resetPan();
  }

  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = bodyOverflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoomIndex((index) => clampZoom(index + 1));
        resetPan();
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoomIndex((index) => clampZoom(index - 1));
        resetPan();
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"])')];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      resetPan();
      setZoomIndex((index) => clampZoom(index + (event.deltaY < 0 ? 1 : -1)));
    }
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  function readPan(name: string): number {
    const raw = imgRef.current?.style.getPropertyValue(name) ?? '';
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : 0;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLImageElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { x: readPan('--image-x'), y: readPan('--image-y'), px: event.clientX, py: event.clientY };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom does not track active pointers.
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLImageElement>) {
    const start = drag.current;
    if (!start) return;
    event.currentTarget.style.setProperty('--image-x', `${start.x + event.clientX - start.px}px`);
    event.currentTarget.style.setProperty('--image-y', `${start.y + event.clientY - start.py}px`);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLImageElement>) {
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture was never taken.
    }
  }

  const zoom = ZOOMS[zoomIndex] ?? 100;
  const label = alt || 'Image';

  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={dialogRef}>
      <button type="button" className="image-viewer__backdrop" aria-label="Close image" tabIndex={-1} onClick={() => onCloseRef.current()} />
      <div className="image-viewer__bar">
        <Btn onClick={() => turnBy(-1)}>Rotate left</Btn>
        <Btn onClick={() => turnBy(1)}>Rotate right</Btn>
        <Btn disabled={zoomIndex === 0} onClick={() => stepZoom(-1)}>Zoom out</Btn>
        <span className="image-viewer__zoom">{zoom}%</span>
        <Btn disabled={zoomIndex === ZOOMS.length - 1} onClick={() => stepZoom(1)}>Zoom in</Btn>
        <Btn onClick={() => onCloseRef.current()}>Close</Btn>
      </div>
      <div className="image-viewer__stage">
        <img
          ref={imgRef}
          className="image-viewer__img"
          src={src}
          alt={label}
          data-zoom={zoom}
          data-turn={turn}
          referrerPolicy="no-referrer"
          draggable={false}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
    </div>,
    document.body,
  );
}
