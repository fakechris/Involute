import { describe, expect, it } from 'vitest';

import { isRenderableImageUrl, normalizeImageHostSuffixes } from './image-url.js';

describe('isRenderableImageUrl', () => {
  it('renders same-origin uploads and the three object stores, including presigned query strings', () => {
    expect(isRenderableImageUrl('/uploads/abc.png')).toBe(true);
    expect(isRenderableImageUrl('/uploads/abc.png?x=1')).toBe(true);
    expect(isRenderableImageUrl('https://bucket.s3.amazonaws.com/a.png')).toBe(true);
    expect(isRenderableImageUrl('https://s3.amazonaws.com/bucket/a.jpg')).toBe(true);
    expect(isRenderableImageUrl('https://bucket.s3.us-west-2.amazonaws.com/a.jpeg')).toBe(true);
    expect(isRenderableImageUrl('https://bucket.s3-accelerate.amazonaws.com/a.gif')).toBe(true);
    expect(isRenderableImageUrl('https://bucket.s3.cn-north-1.amazonaws.com.cn/a.webp')).toBe(true);
    expect(isRenderableImageUrl('https://bucket.oss-cn-hangzhou.aliyuncs.com/a.png?OSSAccessKeyId=x&Signature=y')).toBe(true);
    expect(isRenderableImageUrl('https://cdn.example.qiniucdn.com/a.png?e=1&token=2')).toBe(true);
    expect(isRenderableImageUrl('https://img.clouddn.com/a.jpg')).toBe(true);
    expect(isRenderableImageUrl('https://img.qiniudn.com/a.gif')).toBe(true);
    expect(isRenderableImageUrl('https://img.qbox.me/a.webp')).toBe(true);
    expect(isRenderableImageUrl('https://img.qnssl.com/a.png')).toBe(true);
  });

  it('leaves other addresses as links, including svg, http, and extensionless buckets', () => {
    expect(isRenderableImageUrl('/uploads/note.svg')).toBe(false);
    expect(isRenderableImageUrl('/uploads/note.md')).toBe(false);
    expect(isRenderableImageUrl('http://bucket.s3.amazonaws.com/a.png')).toBe(false);
    expect(isRenderableImageUrl('https://example.com/a.png')).toBe(false);
    expect(isRenderableImageUrl('https://bucket.s3.amazonaws.com.evil.com/a.png')).toBe(false);
    expect(isRenderableImageUrl('https://evil.com/uploads/a.png')).toBe(false);
    expect(isRenderableImageUrl('javascript:alert(1)')).toBe(false);
    expect(isRenderableImageUrl('https://bucket.oss-cn-hangzhou.aliyuncs.com/a')).toBe(false);
    expect(isRenderableImageUrl('https://user:pass@bucket.s3.amazonaws.com/a.png')).toBe(false);
  });

  it('renders an extensionless screenshot only on an allowlisted host, and accepts a CDN suffix', () => {
    expect(isRenderableImageUrl('https://cdn.example.qiniucdn.com/shot', { allowExtensionless: true })).toBe(true);
    expect(isRenderableImageUrl('https://example.com/shot', { allowExtensionless: true })).toBe(false);
    expect(isRenderableImageUrl('https://img.cdn.example.com/a.png', { extraHosts: 'cdn.example.com, com' })).toBe(true);
    expect(isRenderableImageUrl('https://img.other.com/a.png', { extraHosts: ['cdn.example.com'] })).toBe(false);
    expect(normalizeImageHostSuffixes('*.img.example.cn, com, /bad')).toEqual(['img.example.cn']);
  });
});
