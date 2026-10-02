import { Fragment, type ReactNode } from 'react';

/** Wraps every case-insensitive occurrence of a search word in <mark>. */
export function highlight(text: string, query: string): ReactNode {
  const needles = query
    .split(/\s+/)
    .map((word) => word.replace(/^"|"$/g, ''))
    .filter(Boolean);
  if (needles.length === 0) {
    return text;
  }
  const pattern = new RegExp(`(${needles.map(escapeRegExp).join('|')})`, 'gi');
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
