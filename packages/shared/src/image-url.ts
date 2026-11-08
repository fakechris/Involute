/**
 * Which picture addresses the product may render as an image.
 * Same-origin uploads, and https objects on S3, Aliyun OSS, Qiniu,
 * plus suffixes a deployment adds for a CDN in front of a bucket.
 * The server never fetches these URLs.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

const QINIU_SUFFIXES = ['.qiniucdn.com', '.clouddn.com', '.qiniudn.com', '.qbox.me', '.qnssl.com'];

/** A host suffix from configuration: a dotted name, without a scheme or path. */
export function normalizeImageHostSuffixes(values: readonly string[] | string | null | undefined): string[] {
  const raw = typeof values === 'string' ? values : (values ?? []).join(',');
  const suffixes: string[] = [];
  for (const part of raw.split(',')) {
    const suffix = part.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '');
    if (!suffix.includes('.') || /[\s/]/.test(suffix)) continue;
    if (!suffixes.includes(suffix)) suffixes.push(suffix);
  }
  return suffixes;
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function builtinHost(host: string): boolean {
  if (host === 's3.amazonaws.com' || host.endsWith('.s3.amazonaws.com')) return true;
  if (/^s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) return true;
  if (/(^|\.)s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) return true;
  if (host === 's3-accelerate.amazonaws.com' || host.endsWith('.s3-accelerate.amazonaws.com')) return true;
  if (host.endsWith('.amazonaws.com.cn') && host.includes('.s3')) return true;
  if (host.endsWith('.aliyuncs.com')) return true;
  return QINIU_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export interface RenderableImageOptions {
  /** Screenshot evidence may omit a file extension when the host is allowlisted. */
  allowExtensionless?: boolean;
  extraHosts?: readonly string[] | string | null;
}

/** True when the page may put this address in an img. Everything else stays a link. */
export function isRenderableImageUrl(raw: string, options: RenderableImageOptions = {}): boolean {
  const value = raw.trim();
  if (!value || value.length > 4096) return false;
  if (value.startsWith('/uploads/') && !value.startsWith('//')) {
    const path = value.split(/[?#]/)[0] ?? '';
    return /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path) && IMAGE_EXT.test(path);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const extra = normalizeImageHostSuffixes(options.extraHosts);
  if (!builtinHost(host) && !extra.some((suffix) => hostMatches(host, suffix))) return false;
  if (options.allowExtensionless) return true;
  const path = decodeURIComponent(url.pathname);
  return IMAGE_EXT.test(path);
}
