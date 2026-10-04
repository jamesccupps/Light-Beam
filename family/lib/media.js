'use strict';
// Videos that play everywhere (1.10.0; the user: "we need to convert it to a format that an iphone can play" and "make
// videos that are streamed or played from the chat browser into a compatible version too"). A phone's HDR video (the
// Pixel: HEVC 10-bit HLG) didn't open on an iPhone, not even in VLC. Like Google Photos, the original is kept and a copy
// is made that every phone and browser plays: H.264 High, standard color (HDR tone-mapped to BT.709, 8-bit), at most
// 1080 on the short side, ~5 Mbit/s (light enough to stream through the public link), AAC stereo, the index first. The
// chat's viewer and a fast link's page play that copy; a download still gets the original. A video that already plays
// everywhere (H.264, 8-bit, SDR, MP4, not too heavy) is played as it is.
//
// ffmpeg: BEAM_FAMILY_FFMPEG (its path, or "off"), else "ffmpeg" on the PATH; ffprobe next to it. Without one, videos
// play as they are. One video at a time, at below-normal priority; the graphics card's H.264 encoder (NVENC) when it
// works here, else x264, else OpenH264. Measured on Desktop (RTX 3060, Ryzen 5 5600G): an HDR video ~3× its length
// (the tone mapping runs on the CPU), an ordinary one ~7×.
//
// attachments.play: null (not looked at), 'working' (queued or being made), 'ready' (play/<id>.mp4), 'original' (it
// plays as it is), 'failed'.

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { httpError, sendFile, contentDisposition } = require('./http');

const STUCK_MS = 5 * 60e3;          // an ffmpeg that says nothing this long is stopped
const MAX_RATE = 8e6;               // heavier than this (bits/s): a lighter copy, to stream through the public link
const HDR = new Set(['smpte2084', 'arib-std-b67']);
const VIDEO_NAME = /\.(mp4|m4v|mov|mkv|webm|avi|3gp|3g2|mts|m2ts|ts|hevc|wmv|flv)$/i;
const PLAY_CSP = "default-src 'none'; media-src 'self'; sandbox";

// A program's answer; rejects only when it couldn't run at all (not there, or stopped by the timeout).
function run(file, args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const lastLine = text => String(text).trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) || '';
const mb = n => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
const isVideo = a => /^video\//.test(a.mime) || VIDEO_NAME.test(a.name);
// "Wedding.mov" → "Wedding (plays everywhere).mp4"
const playName = a => `${a.name.replace(/\.[^.]{1,8}$/, '')} (plays everywhere).mp4`;

function createMedia(ctx) {
  const { db, hub, log, config, dirs } = ctx;
  const playPath = id => path.join(dirs.play, `${id}.mp4`);
  let tools = null;           // { ffmpeg, ffprobe, encoder, zscale, colorspace } once found
  const queue = [];
  let current = null;         // { id, child, cancelled }
  let busy = false;
  let stopped = false;
  const progress = new Map(); // id → 0..1 while it's being made

  // Which ffmpeg, and what it can do here.
  async function detect() {
    const want = config.ffmpeg;
    if (want === 'off') { log.info('Videos play as they are (BEAM_FAMILY_FFMPEG=off)'); return null; }
    const ffmpeg = want || 'ffmpeg';
    const ffprobe = want ? path.join(path.dirname(want), path.basename(want).replace(/ffmpeg/i, 'ffprobe')) : 'ffprobe';
    let encoders = '';
    let filters = '';
    try {
      encoders = (await run(ffmpeg, ['-hide_banner', '-encoders'])).stdout;
      filters = (await run(ffmpeg, ['-hide_banner', '-filters'])).stdout;
      await run(ffprobe, ['-hide_banner', '-version']);
    } catch {
      log.info(`Videos play as they are: no ffmpeg${want ? ` at ${want}` : ' (BEAM_FAMILY_FFMPEG sets where it is)'}`);
      return null;
    }
    const has = (list, name) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(list);
    let encoder = null;
    if (has(encoders, 'h264_nvenc')) {
      // (the graphics card's encoder only if it really works here: a fifth of a second of black)
      const t = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], 30_000).catch(() => null);
      if (t?.code === 0) encoder = 'h264_nvenc';
    }
    encoder ||= has(encoders, 'libx264') ? 'libx264' : has(encoders, 'libopenh264') ? 'libopenh264' : null;
    if (!encoder || !has(encoders, 'aac')) { log.info('Videos play as they are: this ffmpeg has no H.264 or AAC encoder'); return null; }
    const found = { ffmpeg, ffprobe, encoder, zscale: has(filters, 'zscale') && has(filters, 'tonemap'), colorspace: has(filters, 'colorspace') };
    // (1.12.1) the graphics card can still fail on a video (busy, a driver reset, wider than 4096): that one is made
    // again on the processor
    if (encoder === 'h264_nvenc') found.fallback = has(encoders, 'libx264') ? 'libx264' : has(encoders, 'libopenh264') ? 'libopenh264' : null;
    log.info(`Videos that play everywhere: on (${encoder === 'h264_nvenc' ? 'the graphics card’s H.264 encoder' : encoder}${found.zscale ? '' : found.colorspace ? ', HDR without tone mapping' : ', HDR as it is'})`);
    return found;
  }

  async function probe(file) {
    const r = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'ffprobe couldn’t read it');
    const j = JSON.parse(r.stdout);
    const streams = j.streams || [];
    return { v: streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic), a: streams.find(s => s.codec_type === 'audio'), format: j.format || {} };
  }

  // Plays on every phone and browser as it is, and streams well through the public link.
  function playsEverywhere({ v, a, format }) {
    const rate = Number(format.bit_rate) || 0;
    return v.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(v.pix_fmt) && !HDR.has(v.color_transfer)
      && /mp4|mov/.test(format.format_name || '') && (!a || ['aac', 'mp3'].includes(a.codec_name))
      && Math.min(Number(v.width) || 0, Number(v.height) || 0) <= 1080 && rate > 0 && rate <= MAX_RATE;
  }

  function videoFilters({ v }) {
    // (the short side at most 1080, even sizes; quoted: the commas are the expressions')
    const fit = "scale=w='if(lte(iw,ih),trunc(min(iw,1080)/2)*2,-2)':h='if(lte(iw,ih),-2,trunc(min(ih,1080)/2)*2)'";
    if (HDR.has(v.color_transfer) && tools.zscale) {
      return { vf: `${fit},zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`, sdr: true };
    }
    if (HDR.has(v.color_transfer) && tools.colorspace) return { vf: `${fit},colorspace=all=bt709:iall=bt2020:itrc=bt2020-10:format=yuv420p`, sdr: true };
    return { vf: `${fit},format=yuv420p`, sdr: false };
  }

  function encoderArgs(encoder) {
    if (encoder === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '5M', '-maxrate', '7M', '-bufsize', '10M', '-profile:v', 'high'];
    if (encoder === 'libx264') return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '7M', '-bufsize', '10M', '-profile:v', 'high'];
    return ['-c:v', 'libopenh264', '-profile:v', 'high', '-coder', 'cabac', '-rc_mode', 'bitrate', '-b:v', '5M', '-maxrate', '7M', '-threads', '6', '-slices', '6'];
  }

  // Its message's conversation sees the new state at once (the viewer, Play).
  function announce(id) {
    const a = db.get('SELECT * FROM attachments WHERE id = ?', id);
    const m = a?.message_id && db.get('SELECT * FROM messages WHERE id = ?', a.message_id);
    if (!m || m.deleted_at) return;
    const c = db.get('SELECT * FROM channels WHERE id = ?', m.channel_id);
    hub.emit(ctx.chat.audience(c), 'msg-edit', { message: ctx.chat.messagesJson([m])[0] });
  }

  function settle(id, state, size = null) {
    if (!db.get('SELECT id FROM attachments WHERE id = ?', id)) return;
    db.run('UPDATE attachments SET play = ?, play_size = ? WHERE id = ?', state, size, id);
    announce(id);
  }

  async function convert(a, encoder = tools.encoder, known = null) {
    const src = ctx.files.filePath(a.id);
    const info = known || await probe(src);
    if (!info.v) return settle(a.id, 'original'); // (no picture: nothing to make)
    if (playsEverywhere(info)) return settle(a.id, 'original');
    const duration = Number(info.format.duration) || Number(info.v.duration) || 0;
    const { vf, sdr } = videoFilters(info);
    const tmp = `${playPath(a.id)}.tmp`;
    const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', vf, '-fpsmax', '60', ...encoderArgs(encoder),
      ...(sdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', tmp];
    const started = Date.now();
    const child = spawn(tools.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    current = { id: a.id, child, cancelled: false };
    const job = current;
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let said = Date.now();
    let errors = '';
    child.stderr.on('data', d => { errors = (errors + d).slice(-4000); });
    child.stdout.on('data', d => {
      said = Date.now();
      const times = [...String(d).matchAll(/out_time_us=(\d+)/g)];
      if (times.length && duration) progress.set(a.id, Math.min(0.99, Number(times.at(-1)[1]) / 1e6 / duration));
    });
    const watch = setInterval(() => { if (Date.now() - said > STUCK_MS) { errors += '\n(stopped: nothing for 5 minutes)'; child.kill(); } }, 30e3);
    watch.unref?.();
    const code = await new Promise(resolve => { child.on('close', resolve); child.on('error', () => resolve(-1)); });
    clearInterval(watch);
    current = null;
    progress.delete(a.id);
    if (job.cancelled) { await fsp.rm(tmp, { force: true }).catch(() => {}); return; }
    if (code !== 0) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (encoder === 'h264_nvenc' && tools.fallback && !stopped && db.get('SELECT id FROM attachments WHERE id = ?', a.id)) {
        log.info(`The graphics card couldn’t make a version of ${a.name} that plays everywhere (${lastLine(errors) || `ffmpeg stopped (${code})`}): making it on the processor`);
        return convert(a, tools.fallback, info);
      }
      log.warn(`Couldn’t make a version of ${a.name} that plays everywhere: ${lastLine(errors) || `ffmpeg stopped (${code})`}`);
      return settle(a.id, 'failed');
    }
    // (removed while it was being made: gone with it)
    if (!db.get('SELECT id FROM attachments WHERE id = ?', a.id)) { await fsp.rm(tmp, { force: true }).catch(() => {}); return; }
    await fsp.rename(tmp, playPath(a.id));
    const size = (await fsp.stat(playPath(a.id))).size;
    settle(a.id, 'ready', size);
    const s = Math.round((Date.now() - started) / 1000);
    log.info(`Made a version of ${a.name} that plays everywhere: ${mb(a.size)} → ${mb(size)} in ${s < 90 ? `${s} s` : `${Math.round(s / 60)} min`}`);
  }

  async function pump() {
    if (busy || !tools) return;
    busy = true;
    try {
      while (queue.length && !stopped) {
        const id = queue.shift();
        const a = db.get('SELECT * FROM attachments WHERE id = ?', id);
        if (!a || a.received < a.size || !a.size) continue;
        try {
          await convert(a);
        } catch (err) {
          current = null;
          progress.delete(id);
          log.warn(`Couldn’t make a version of ${a.name} that plays everywhere: ${err.message}`);
          settle(id, 'failed');
        }
      }
    } finally {
      busy = false;
    }
  }

  // A video that has all come in (or is still to be looked at after a restart) gets its copy, one at a time.
  function add(a) {
    if (!tools || !a || !isVideo(a) || a.received < a.size || !a.size) return;
    if (queue.includes(a.id) || current?.id === a.id) return;
    queue.push(a.id);
    db.run("UPDATE attachments SET play = 'working', play_size = NULL WHERE id = ?", a.id);
    announce(a.id);
    pump();
  }

  // The file is going (its message deleted, an upload dropped): its copy goes too, and a copy being made stops.
  function forget(id) {
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    if (current?.id === id) { current.cancelled = true; try { current.child.kill(); } catch {} }
    return Promise.all([playPath(id), `${playPath(id)}.tmp`].map(f => fsp.rm(f, { force: true }).catch(() => {})));
  }

  async function start() {
    tools = await detect();
    if (!tools) return;
    // Videos from before (or one a restart cut off), newest first.
    for (const a of db.all("SELECT * FROM attachments WHERE (play IS NULL OR play = 'working') AND received >= size AND size > 0 ORDER BY created_at DESC")) {
      if (isVideo(a)) add(a);
      else if (a.play === 'working') db.run('UPDATE attachments SET play = NULL WHERE id = ?', a.id);
    }
  }

  function stop() {
    stopped = true;
    // (left as 'working': the next start makes it again)
    if (current) { current.cancelled = true; try { current.child.kill(); } catch {} }
  }

  // For the API: an attachment's state as its JSON says it.
  function stateOf(a, base) {
    if (!a.play) return {};
    const out = { play: a.play };
    if (a.play === 'ready' || a.play === 'original') out.playUrl = `${base}/play`;
    if (a.play === 'ready' && a.play_size) out.playSize = a.play_size;
    if (a.play === 'working') out.playProgress = Math.round((progress.get(a.id) || 0) * 100) / 100;
    return out;
  }

  // The copy (or the original, when that already plays everywhere), with Range for seeking; ?download: to keep.
  async function sendPlay(req, res, a, url, extra = {}) {
    if (a.received < a.size) throw httpError(409, 'That file hasn’t finished uploading');
    const ready = a.play === 'ready';
    if (!ready && a.play !== 'original') throw httpError(404, a.play === 'working' ? 'Not ready yet' : 'There’s no version of this that plays everywhere');
    const keep = url.searchParams.has('download');
    await sendFile(req, res, ready ? playPath(a.id) : ctx.files.filePath(a.id), {
      type: ready ? 'video/mp4' : a.mime,
      etag: `"${a.id}.p${ready ? a.play_size : a.size}"`,
      headers: {
        'Content-Disposition': contentDisposition(keep ? 'attachment' : 'inline', ready ? playName(a) : a.name),
        'Content-Security-Policy': PLAY_CSP,
        'Cache-Control': 'private, no-cache',
        ...extra,
      },
    });
  }

  // GET /api/files/:id/play[?download]
  async function playFile(req, res, { id }, url) {
    const user = ctx.people.requireUser(req);
    await sendPlay(req, res, ctx.files.visibleAttachment(user, id), url);
  }

  return {
    start, stop, add, forget, stateOf, sendPlay, isVideo,
    enabled: () => Boolean(tools),
    routes: [['GET', '/api/files/:id/play', playFile]],
  };
}

module.exports = { createMedia, isVideo, playName };
