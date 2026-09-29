const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { runProcess } = require('../server.js');
const { isCutSpeed } = require('../shared.js');

function writeFixtureWav(file) {
  const rate = 8000;
  const seconds = 2;
  const samples = Buffer.alloc(rate * seconds * 2);
  for (let i = rate; i < rate * seconds; i++) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * (i - rate) / rate) * 12000);
    samples.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, samples]));
}

test('bundled Auto-Editor v1 output marks silence as a cut understood by the GUI', async (t) => {
  const id = crypto.randomUUID();
  const input = path.join(os.tmpdir(), `ae-gui-test-${id}.wav`);
  const output = path.join(os.tmpdir(), `ae-gui-test-${id}.v1`);
  const exe = path.join(__dirname, '..', 'auto-editor-windows-x86_64.exe');
  if (!fs.existsSync(exe)) return t.skip('Auto-Editor binary is not bundled in the repository.');
  writeFixtureWav(input);
  try {
    const result = await runProcess(exe, [input, '--edit', 'audio:threshold=4%', '--margin', '0s,0s', '--smooth', '0s,0s', '--export', 'v1', '-o', output], { cwd: path.dirname(input) });
    assert.equal(result.code, 0, result.output);
    const timeline = JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, ''));
    const cutSpeeds = (timeline.chunks || []).map(chunk => Number(chunk[2])).filter(isCutSpeed);
    assert.ok(cutSpeeds.length > 0, JSON.stringify(timeline));
    assert.ok(cutSpeeds.every(speed => speed === 0 || speed >= 99999), `unexpected cut speed: ${cutSpeeds.join(', ')}`);
  } finally {
    for (const file of [input, output]) try { fs.unlinkSync(file); } catch {}
  }
});
