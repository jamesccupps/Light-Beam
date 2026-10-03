// The app's direct connection to Beam Family (1.9.0): one per page, made when a big file is to be sent and kept while
// it's in use. Files go straight to the server over it (WebRTC; on the same network it stays inside it, elsewhere it
// skips Tailscale's relay); when it doesn't come up, or drops, the rest goes over https from where the server got to.
import { api } from './api.js';
import { state } from './store.js';

export const DIRECT_MIN = 8 * 1024 * 1024; // (smaller files aren't worth the few seconds a connection takes)
const SEND = 64 * 1024;
const READ = 1024 * 1024;
const HIGH = 4 * 1024 * 1024;

let conn = null;
let connecting = null;
let failedAt = 0;

export const directAvailable = () => Boolean(state.direct) && 'RTCPeerConnection' in window && Date.now() - failedAt > 60_000;

// The connection, made if need be; null if it can't be (it isn't tried again for a minute then).
export function directConnection() {
  if (conn && conn.pc.connectionState === 'connected' && conn.ctl.readyState === 'open') return Promise.resolve(conn);
  if (!connecting) {
    connecting = open().then(c => { conn = c; return c; }, () => { failedAt = Date.now(); conn = null; return null; }).finally(() => { connecting = null; });
  }
  return connecting;
}

async function open() {
  const stun = state.direct?.stun || [];
  const pc = new RTCPeerConnection({ iceServers: stun.length ? [{ urls: stun }] : [] });
  const ctl = pc.createDataChannel('beam');
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
      setTimeout(resolve, 2500);
    });
    const { sdp } = await api('/api/direct', { method: 'POST', body: { sdp: pc.localDescription.sdp } });
    await pc.setRemoteDescription({ type: 'answer', sdp });
    await new Promise((resolve, reject) => {
      if (ctl.readyState === 'open') return resolve();
      ctl.onopen = resolve;
      setTimeout(() => reject(new Error('No direct connection came up')), 10_000);
    });
  } catch (err) {
    pc.close();
    throw err;
  }
  pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && conn?.pc === pc) conn = null; });
  return { pc, ctl };
}

// Sends the rest of an upload over the connection, from item.offset on. item.offset follows what the server has kept
// (it says so every 2 MB); resolves when it's all there, rejects if the connection can't take it (the caller goes on
// over https from the server's offset).
export function sendDirect(c, item, file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const dc = c.pc.createDataChannel(JSON.stringify({ op: 'put', upload: item.id, offset: item.offset }));
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1024 * 1024;
    let finished = false;
    const end = (err, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      try { dc.close(); } catch {}
      if (err) reject(err); else resolve(value);
    };
    const onAbort = () => end(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', onAbort);
    dc.onmessage = e => {
      if (typeof e.data !== 'string') return;
      const j = JSON.parse(e.data);
      if (j.error) return end(new Error(j.error));
      if (j.done) { item.offset = file.size; onProgress?.(); return end(null, { done: true }); }
      if (Number.isFinite(j.offset)) {
        // (an offset before anything was sent: the server has another one; the caller goes on from that over https)
        if (j.offset !== item.offset && !dc.sentAny) { item.offset = j.offset; return end(new Error('Another offset')); }
        item.offset = j.offset;
        onProgress?.();
      }
    };
    dc.onclose = () => end(new Error('The direct connection closed'));
    dc.onopen = async () => {
      let pos = item.offset;
      try {
        while (pos < file.size && !finished) {
          const buf = new Uint8Array(await file.slice(pos, Math.min(file.size, pos + READ)).arrayBuffer());
          for (let at = 0; at < buf.length && !finished; at += SEND) {
            if (dc.readyState !== 'open') return;
            dc.send(buf.subarray(at, Math.min(buf.length, at + SEND)));
            dc.sentAny = true;
            if (dc.bufferedAmount > HIGH) await new Promise(r => { dc.onbufferedamountlow = r; setTimeout(r, 1000); });
          }
          pos += buf.length;
        }
      } catch (err) {
        end(err);
      }
    };
  });
}
