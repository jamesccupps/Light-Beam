'use strict';
// (1.20) The setup check's look at Windows: which scheduled tasks run a given server.js, and whether one starts when
// Windows does (before anyone signs in). PowerShell's Get-ScheduledTask as the server's own account (its own tasks are
// visible without admin). BEAM_TEST_BOOT_TASKS (a JSON file of { name, command, boot, enabled }) stands in for tests.
const { execFile } = require('node:child_process');
const fs = require('node:fs');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = New-Object System.Collections.Generic.List[object]
foreach ($t in @(Get-ScheduledTask | Where-Object { ($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -match 'server\.js' })) {
  $boot = [bool]($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })
  foreach ($a in $t.Actions) {
    $out.Add([ordered]@{ name = $t.TaskName; command = "$($a.Execute) $($a.Arguments)"; boot = $boot; enabled = ($t.State -ne 'Disabled') })
  }
}
ConvertTo-Json -InputObject $out.ToArray() -Compress -Depth 3
`;

// [{ name, command, boot, enabled }] for the tasks that run a server.js; rejects when PowerShell fails.
function serverTasks({ env = process.env } = {}) {
  if (env.BEAM_TEST_BOOT_TASKS) return fs.promises.readFile(env.BEAM_TEST_BOOT_TASKS, 'utf8').then(text => JSON.parse(text));
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().split(/\r?\n/).find(Boolean) || 'PowerShell failed'));
      try {
        const list = JSON.parse(stdout.toString().replace(/^\uFEFF/, '').trim() || '[]');
        resolve(Array.isArray(list) ? list : [list]);
      } catch (e) { reject(new Error(`PowerShell's answer wasn't readable: ${e.message}`)); }
    });
  });
}

// The task that starts `script` (a server.js path) at boot, else one that runs it otherwise, else null.
function taskFor(tasks, script) {
  const norm = s => String(s || '').replace(/\//g, '\\').toLowerCase();
  const mine = (tasks || []).filter(t => t.enabled !== false && norm(t.command).includes(norm(script)));
  return mine.find(t => t.boot) || mine[0] || null;
}

module.exports = { serverTasks, taskFor };
