const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('launcher starts server.js by absolute path so cleanup can identify it safely', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'start-gui.bat'), 'utf8');
  assert.match(bat, /node\s+""%~dp0server\.js""/i);
});

test('cleanup verifies the port owner and exact server path before killing a PID', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'cleanup-old-instances.ps1'), 'utf8');
  assert.match(ps, /\$ServerScript\s*=/);
  assert.match(ps, /Get-NetTCPConnection/);
  assert.match(ps, /OwningProcess/);
  assert.equal(/HealthVerified/.test(ps), false);
});

test('startup cleanup does not blindly delete every recent preview from other instances', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'cleanup-old-instances.ps1'), 'utf8');
  assert.match(ps, /LastWriteTime/);
  assert.match(ps, /AddDays\(-1\)/);
});
