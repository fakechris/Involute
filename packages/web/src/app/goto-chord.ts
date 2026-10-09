/**
 * True between `g` and the next key (INV-1087): single-letter page shortcuts
 * (S, P, A, I, L, F …) leave that key to the navigation chord, so `g s` goes
 * to Settings instead of also opening the status picker.
 */
let pending = false;
export function setGotoChordPending(value: boolean): void {
  pending = value;
}
export function isGotoChordPending(): boolean {
  return pending;
}
