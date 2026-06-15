import { useEffect, useRef } from 'react';

export type WsEvent =
  | { kind: 'qr'; dataUrl: string }
  | { kind: 'connection'; state: string }
  | { kind: 'message'; chatJid: string; message: import('./api').FeedMessage }
  | { kind: 'decision'; chatJid: string; ts: number; tier: string; decision: string; reason: string }
  | { kind: 'action'; chatJid: string; ts: number; action: { type: string; text?: string; emoji?: string } }
  | { kind: 'stats'; stats: Record<string, number> }
  | { kind: 'fact'; chatJid: string; memberJid: string; fact: string; category: string | null }
  | { kind: 'voice'; chatJid: string; count: number }
  | { kind: 'report'; count: number }
  | { kind: 'sticker'; id: number; description: string | null }
  | { kind: 'status'; status: import('./api').Status };

/** Auto-reconnecting WebSocket subscription. */
export function useWs(onEvent: (e: WsEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (msg) => {
        try { handler.current(JSON.parse(msg.data)); } catch { /* ignore */ }
      };
      ws.onopen = () => { retry = 1000; };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
    };
    connect();

    return () => { closed = true; ws?.close(); };
  }, []);
}
