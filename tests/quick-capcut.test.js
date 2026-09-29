const test = require('node:test');
const assert = require('node:assert/strict');
const { QUICK_DEFAULTS } = require('../quick-capcut.js');

test('one-command CapCut mode uses zero margins and stable anti-micro-cut defaults', () => {
  assert.deepEqual(QUICK_DEFAULTS, {
    marginBefore: 0,
    marginAfter: 0,
    smoothCut: 0.35,
    smoothClip: 0.10,
  });
});
