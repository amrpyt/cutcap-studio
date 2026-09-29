const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { runProcess, buildEditArgs, addWatermarkToTimeline, cancelJob, acquireOutputLock, commitRenderedOutput, registerPreview, getPreviewFile, cleanupExpiredPreviews, PREVIEW_TTL_MS } = require('../server.js');

test('runProcess keeps stdout and stderr separate', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('OUT');process.stderr.write('ERR')"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'OUT');
  assert.equal(result.stderr, 'ERR');
});

test('buildEditArgs is pinned to the explicit source and preserves keep ranges', () => {
  const args = buildEditArgs({
    mode: 'render', threshold: 4, marginBefore: .2, marginAfter: .4,
    smoothCut: .35, smoothClip: .1,
    keepRanges: [{ start: 3, end: 4.5 }],
  }, 'D:\\video-a.mp4');
  assert.equal(args[0], 'D:\\video-a.mp4');
  assert.deepEqual(args.slice(-2), ['--keep', '3.000000sec,4.500000sec']);
});

test('watermark is added to the Auto-Editor timeline at the UI size and position', () => {
  const timeline = { resolution: [1280, 720], v: [[{ src: 'video.mp4', start: 0, dur: 300, offset: 0, stream: 0 }]] };
  addWatermarkToTimeline(timeline, {
    path: 'logo.png',
    transform: { x: .02, y: .03, scale: 12, opacity: 80 },
  }, { raw: { video: [{ resolution: [1536, 1024] }] } });
  assert.equal(timeline.v.length, 2);
  assert.deepEqual(timeline.v[1], [{
    src: 'logo.png', start: 0, dur: 300, offset: 0, stream: 0,
    effects: ['pos:25.600:21.600:0.100000', 'opacity:0.800000'],
  }]);
});

test('cancellation requested before child registration still cancels that job', async () => {
  const jobId = `early-cancel-${Date.now()}`;
  assert.equal(cancelJob(jobId), true);
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { jobId });
  assert.equal(result.cancelled, true);
});

test('only one render may own the same output path at a time', () => {
  const output = path.join(os.tmpdir(), `ae-lock-${crypto.randomUUID()}.mp4`);
  const release = acquireOutputLock(output);
  assert.throws(() => acquireOutputLock(output), err => err && err.statusCode === 409);
  release();
  const releaseAgain = acquireOutputLock(output);
  releaseAgain();
});

test('successful render commit replaces an old destination only after temp is complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-commit-'));
  const output = path.join(dir, 'final.mp4');
  const temp = path.join(dir, 'temp.mp4');
  fs.writeFileSync(output, 'OLD');
  fs.writeFileSync(temp, 'NEW');
  try {
    commitRenderedOutput(temp, output);
    assert.equal(fs.readFileSync(output, 'utf8'), 'NEW');
    assert.equal(fs.existsSync(temp), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idle preview lease expires and removes its temp file', () => {
  const file = path.join(os.tmpdir(), `ae-preview-test-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(file, 'preview');
  const token = registerPreview(file, 1000);
  assert.equal(getPreviewFile(token, 2000), file);
  cleanupExpiredPreviews(2000 + PREVIEW_TTL_MS + 1);
  assert.equal(getPreviewFile(token), '');
  assert.equal(fs.existsSync(file), false);
});
