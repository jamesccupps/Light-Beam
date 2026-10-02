'use strict';
// Outbound HTTP(S) to another Beam (moves, import-from). Inside a container that uses Tailscale's userspace
// networking, tailnet addresses are reachable only through tailscaled's HTTP proxy (BEAM_TAILNET_PROXY, e.g.
// http://127.0.0.1:1055): requests to *.ts.net names and Tailscale addresses go through it (a CONNECT tunnel for
// https). Everything else connects directly.

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

function createOutbound({ proxy = '', isTailnetHost = () => false } = {}) {
  const proxyUrl = proxy ? new URL(proxy) : null;

  function tunnel(url, timeout) {
    return new Promise((resolve, reject) => {
      const target = `${url.hostname}:${url.port || 443}`;
      const req = http.request({ host: proxyUrl.hostname, port: proxyUrl.port || 80, method: 'CONNECT', path: target, headers: { Host: target }, timeout });
      req.on('connect', (res, socket) => {
        if (res.statusCode === 200) return resolve(socket);
        socket.destroy();
        reject(new Error(`the Tailscale proxy answered ${res.statusCode}`));
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  // Resolves to { status, ok, headers, stream, text(), json() } (stream is the response body as a Node stream).
  async function request(target, { method = 'GET', headers = {}, body, timeout = 20_000 } = {}) {
    const url = new URL(target);
    const secure = url.protocol === 'https:';
    const path = url.pathname + url.search;
    let send;
    let options = { method, headers: { ...headers }, timeout, agent: false };
    if (proxyUrl && isTailnetHost(url.hostname)) {
      if (secure) {
        const socket = await tunnel(url, timeout);
        send = http.request;
        options = { ...options, host: url.hostname, path, headers: { ...options.headers, Host: url.host }, createConnection: () => tls.connect({ socket, servername: url.hostname }) };
      } else {
        send = http.request;
        options = { ...options, host: proxyUrl.hostname, port: proxyUrl.port || 80, path: url.href, headers: { ...options.headers, Host: url.host } };
      }
    } else {
      send = secure ? https.request : http.request;
      options = { ...options, host: url.hostname, port: url.port || (secure ? 443 : 80), path, servername: url.hostname };
    }
    return new Promise((resolve, reject) => {
      const req = send(options, res => {
        const text = async () => {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          return Buffer.concat(chunks).toString('utf8');
        };
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers, stream: res, text, json: async () => JSON.parse(await text()) });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end(body);
    });
  }

  return { request, proxied: Boolean(proxyUrl) };
}

module.exports = { createOutbound };
