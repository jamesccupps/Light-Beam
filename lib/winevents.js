'use strict';
// (1.18) This server's own PC's history: the System log records a PC's Beam app sends (lib/history.js WANTED), read
// here with PowerShell's Get-WinEvent as the server's own account (no admin needed: Windows lets users and batch
// logons read the System log). At start, so a power loss on the server's own PC is known, and alerted, before anyone
// signs in there and its Beam app starts. BEAM_TEST_OWN_EVENTS (a JSON file of records) stands in for Windows in tests.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { WANTED } = require('./history');

function xpathFor(log, sinceIso) {
  const kinds = Object.entries(WANTED[log]).map(([provider, ids]) => `(Provider[@Name='${provider}'] and (${ids.map(i => `EventID=${i}`).join(' or ')}))`);
  return `*[System[(${kinds.join(' or ')}) and TimeCreated[@SystemTime>='${sinceIso}']]]`;
}

// Each record as the Beam app sends it: values as text, dates as ISO (UTC), byte arrays as "hex:…".
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = New-Object System.Collections.Generic.List[object]
try { $events = @(Get-WinEvent -LogName System -FilterXPath $env:BEAM_HISTORY_XPATH -MaxEvents 600) }
catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $events = @() } else { throw } }
foreach ($e in $events) {
  $data = New-Object System.Collections.Generic.List[string]
  foreach ($p in $e.Properties) {
    $v = $p.Value
    if ($v -is [datetime]) { $data.Add($v.ToUniversalTime().ToString('o')) }
    elseif ($v -is [byte[]]) { $data.Add('hex:' + (($v | Select-Object -First 64 | ForEach-Object { $_.ToString('x2') }) -join '')) }
    elseif ($null -eq $v) { $data.Add('') }
    else { $data.Add([string]$v) }
  }
  $out.Add([ordered]@{ log = 'System'; id = $e.Id; provider = $e.ProviderName; time = $e.TimeCreated.ToUniversalTime().ToString('o'); rec = $e.RecordId; data = $data.ToArray() })
}
ConvertTo-Json -InputObject $out.ToArray() -Compress -Depth 3
`;

// The records since `since` (ISO), newest 600 at most. Rejects when PowerShell fails or takes over a minute.
function readOwnEvents({ since, env = process.env } = {}) {
  if (env.BEAM_TEST_OWN_EVENTS) {
    return fs.promises.readFile(env.BEAM_TEST_OWN_EVENTS, 'utf8').then(text => JSON.parse(text));
  }
  const xpath = xpathFor('System', new Date(since).toISOString());
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env: { ...env, BEAM_HISTORY_XPATH: xpath }, timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().split(/\r?\n/).find(Boolean) || 'PowerShell failed'));
      try {
        const list = JSON.parse(stdout.toString().replace(/^\uFEFF/, '').trim() || '[]');
        resolve(Array.isArray(list) ? list : [list]);
      } catch (e) { reject(new Error(`PowerShell's answer wasn't readable: ${e.message}`)); }
    });
  });
}

module.exports = { readOwnEvents, xpathFor };
