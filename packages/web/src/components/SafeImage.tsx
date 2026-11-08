import { useState } from 'react';
import { isRenderableImageUrl } from '@turnkeyai/involute-shared';

import { extraImageHosts } from '../image-hosts';

interface SafeImageProps {
  src: string;
  alt: string;
  className?: string;
  /** Screenshot evidence may omit a file extension when the host is allowlisted. */
  allowExtensionless?: boolean;
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
 * upload, or an https object on an allowlisted bucket). Anything else, and a
 * picture that fails to load, stays a link. The server never fetches the URL.
 */
export function SafeImage({ src, alt, className, allowExtensionless = false }: SafeImageProps) {
  const [failed, setFailed] = useState(false);
  const renderable = !failed && isRenderableImageUrl(src, { allowExtensionless, extraHosts: extraImageHosts() });
  if (!renderable) {
    if (!isSafeHref(src)) return <span>{alt}</span>;
    return (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || src}
      </a>
    );
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      <img
        className={className}
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </a>
  );
}
