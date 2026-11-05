/**
 * Web Serial transport for the grbl streamer (Chrome and Edge; not Safari, Firefox only partly).
 * The person picks the port in the browser's own dialog; nothing is opened without that.
 */
import type { Transport } from '@swarf/grbl';

interface SerialPortLike {
  open(opts: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}
interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

export const serialSupported = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator;

export async function openSerial(baudRate = 115200): Promise<Transport & { label: string }> {
  const serial = (navigator as unknown as { serial: SerialLike }).serial;
  const port = await serial.requestPort();
  await port.open({ baudRate });
  const writer = port.writable!.getWriter();
  const reader = port.readable!.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let cb: (t: string) => void = () => {};
  let closed = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) cb(dec.decode(value, { stream: true }));
      }
    } catch {
      // the device went away; close() below tidies up
    }
  })();
  const info = port.getInfo?.() ?? {};
  return {
    label: info.usbVendorId ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}` : 'serial port',
    write: async (data: string) => {
      if (!closed) await writer.write(enc.encode(data));
    },
    onData: (f) => (cb = f),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await reader.cancel();
        reader.releaseLock();
        writer.releaseLock();
        await port.close();
      } catch {
        // already gone
      }
    },
  };
}
