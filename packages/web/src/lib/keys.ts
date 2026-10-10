/**
 * `/` and `?` by the physical key as well as by the character. With a Chinese
 * input method in punctuation mode that key types 、 and ？, so `event.key`
 * is never '/' or '?' and the shortcuts did nothing.
 */
export function isSlashKey(event: KeyboardEvent): boolean {
  return event.key === '/' || (event.code === 'Slash' && !event.shiftKey);
}

export function isQuestionKey(event: KeyboardEvent): boolean {
  return event.key === '?' || event.key === '？' || (event.code === 'Slash' && event.shiftKey);
}
