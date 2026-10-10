/**
 * The Involute Capture extension (INV-1144). Its manifest carries a fixed
 * public key, so an unpacked install always has this ID; the connect page
 * sends a token to no other extension. More IDs (a store build, a fork) can
 * be allowed with VITE_INVOLUTE_EXTENSION_IDS, comma separated.
 */
export const CAPTURE_EXTENSION_ID = 'gggpgjhcjmonhaipcmeeaejlncgihbge';

export function allowedExtensionIds(): string[] {
  const extra = (import.meta.env.VITE_INVOLUTE_EXTENSION_IDS as string | undefined) ?? '';
  return [CAPTURE_EXTENSION_ID, ...extra.split(',').map((id) => id.trim()).filter(Boolean)];
}

/** What the page sends to the extension; the extension checks sender.origin before keeping it. */
export interface ExtensionConnectMessage {
  type: 'involute.connect';
  token: string;
  server: string;
  person: { id: string; name: string | null; email: string | null };
  expiresAt: string;
}
