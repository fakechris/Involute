import { useState } from 'react';
import { isRenderableImageUrl } from '@turnkeyai/involute-shared';

import { extraImageHosts } from '../image-hosts';
import { ImageViewer } from './ImageViewer';

interface SafeImageProps {
  src: string;
  alt: string;
  className?: string;
  /** Screenshot evidence may omit a file extension when the host is allowlisted. */
  allowExtensionless?: boolean;
  /** Parent opens one shared viewer (a file name and its thumbnail). */
  onOpen?: () => void;
}

function isSafeHref(src: string): boolean {
  const value = src.trim();
  if (value.startsWith('/uploads/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * An image when the address is one this product may render (a same-origin
 * upload, or an https object on an allowlisted bucket). A click enlarges it
 * on this page. Anything else, and a picture that fails to load, stays a
 * link. The server never fetches the URL.
 */
export function SafeImage({ src, alt, className, allowExtensionless = false, onOpen }: SafeImageProps) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const renderable = !failed && isRenderableImageUrl(src, { allowExtensionless, extraHosts: extraImageHosts() });
  if (!renderable) {
    if (!isSafeHref(src)) return <span>{alt}</span>;
    return (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || src}
      </a>
    );
  }

  function openViewer() {
    if (onOpen) {
      onOpen();
      return;
    }
    setOpen(true);
  }

  return (
    <>
      <button type="button" className="safe-image" aria-label={alt || 'View image'} onClick={openViewer}>
        <img
          className={className}
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </button>
      {open ? <ImageViewer src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
