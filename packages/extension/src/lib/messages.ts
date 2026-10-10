import type { OperationName } from '../api/operations';
import type { PageInfo, PickedElement, RecorderSnapshot } from './types';

/** Messages from the extension's own pages (panel, options) to the background (INV-1147). */
export type PanelRequest =
  | { type: 'capture.take'; tabId: number }
  | { type: 'capture.get'; tabId: number }
  | { type: 'picker.start'; tabId: number }
  | { type: 'graphql'; name: OperationName; variables: Record<string, unknown> }
  | { type: 'connection.get' }
  | { type: 'connection.clear' }
  | { type: 'recorder.sync' };

export interface CaptureResult {
  tabId: number;
  /** PNG data URL of the visible tab, full resolution. */
  screenshot: string;
  page: PageInfo;
  recorder: RecorderSnapshot | null;
  takenAt: number;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

/** Messages from the picker in the page. */
export type PickerMessage = { type: 'picker.picked'; element: PickedElement } | { type: 'picker.cancelled' };

/** Send a request to the background and unwrap its reply. */
export async function ask<T>(request: PanelRequest): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(request)) as Reply<T> | undefined;
  if (!reply) throw new Error('The extension background did not answer. Reload the extension and try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
