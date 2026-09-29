const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../server.js');

const ROOT = path.join(__dirname, '..');

test('media tokens keep two browser selections isolated', async () => {
  const port = 38991;
  const a = path.join(__dirname, 'media-a.txt');
  const b = path.join(__dirname, 'media-b.txt');
  fs.writeFileSync(a, 'AAA');
  fs.writeFileSync(b, 'BBB');

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    const select = async file => {
      const response = await fetch(`http://127.0.0.1:${port}/api/set-video-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    const first = await select(a);
    const second = await select(b);
    assert.ok(first.mediaToken);
    assert.ok(second.mediaToken);
    assert.notEqual(first.mediaToken, second.mediaToken);

    const firstMedia = await fetch(`http://127.0.0.1:${port}/api/media?token=${encodeURIComponent(first.mediaToken)}`);
    const secondMedia = await fetch(`http://127.0.0.1:${port}/api/media?token=${encodeURIComponent(second.mediaToken)}`);
    assert.equal(await firstMedia.text(), 'AAA');
    assert.equal(await secondMedia.text(), 'BBB');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.unlinkSync(a);
    fs.unlinkSync(b);
  }
});

test('server serves the UI JavaScript as a separate file', async () => {
  const port = 38992;
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /class App/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('long local jobs are not closed by the default five-minute HTTP timeout', async () => {
  const server = createServer();
  assert.equal(server.requestTimeout, 0);
  assert.equal(server.timeout, 0);
  const port = 38993;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/job-result?jobId=not-running`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'unknown');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
