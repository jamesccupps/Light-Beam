// Test helper (Http2StreamTest starts it): an HTTP/2 cleartext (prior knowledge) SSE endpoint, to check EventStream's
// heartbeat over h2 (the phone talks to `tailscale serve`, which speaks h2). The scenario is chosen with `mode`.
//   grow: hello, a ping 600 ms later, then 2.5 s of silence, then an item, then the end.
//   dead: hello, then silence (the stream stays open) until the client gives up.
const http2 = require('http2');
const port = Number(process.argv[2] || 8882);
const log = (...a) => console.log(new Date().toISOString(), ...a);

const server = http2.createServer();
server.on('stream', (stream, headers) => {
  const url = new URL(headers[':path'], 'http://x');
  const mode = url.searchParams.get('mode') || '';
  log('stream', headers[':method'], url.pathname, 'mode=' + mode);
  stream.on('close', () => log('closed', mode, 'rstCode=' + stream.rstCode));
  stream.on('error', e => log('error', mode, e.message));
  if (url.pathname !== '/api/events') {
    stream.respond({ ':status': 404, 'content-type': 'application/json' });
    return stream.end('{"error":"Not found"}');
  }
  stream.respond({ ':status': 200, 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const send = (event, data) => { if (!stream.destroyed) stream.write(`event: ${event}\ndata: ${data}\n\n`); };
  send('hello', '{"stream":"s1","mode":"foreground","ping":1}');
  if (mode === 'grow') {
    setTimeout(() => send('ping', '{"poke":true}'), 600);
    setTimeout(() => { send('item', '{}'); if (!stream.destroyed) stream.end(); }, 600 + 2500);
  }
  // dead: never writes again
});
server.listen(port, '127.0.0.1', () => log('h2c SSE on', port));
