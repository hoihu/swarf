/**
 * WebSocket transport for networked grblHAL boards (Ethernet/WiFi builds with the WebSocket
 * daemon on, port $307, usually 81). Some builds expect a subprotocol (e.g. "arduino"): it can be
 * given after the address. Text and binary frames are both read as text.
 */
import type { Transport } from '@swarf/grbl';

export function openWebSocket(url: string, protocol?: string): Promise<Transport & { label: string }> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    ws.binaryType = 'arraybuffer';
    const dec = new TextDecoder();
    let cb: (t: string) => void = () => {};
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`No answer from ${url}. Is the controller on the network, with its WebSocket server on ($307)?`));
    }, 5000);
    ws.onmessage = (ev) => cb(typeof ev.data === 'string' ? ev.data : dec.decode(ev.data as ArrayBuffer, { stream: true }));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Could not connect to ${url}.`));
    };
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        label: new URL(url).host,
        write: async (data: string) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        onData: (f) => (cb = f),
        close: async () => ws.close(),
      });
    };
  });
}
