/**
 * Shared WhatsApp connection state.
 * Imported by both index.ts (writer) and web-server.ts (reader)
 * to expose live WA status to the dashboard without circular deps.
 */

export type WhatsAppStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'needs_qr';

export interface WhatsAppState {
  status: WhatsAppStatus;
  qrString: string | null; // Raw QR string for client-side rendering
  qrDataUrl: string | null; // PNG data URL (kept for compatibility)
  qrExpiresAt: number | null; // Unix ms when the current QR expires (~60s)
}

export const waState: WhatsAppState = {
  status: 'connecting',
  qrString: null,
  qrDataUrl: null,
  qrExpiresAt: null,
};
