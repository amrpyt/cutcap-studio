const test = require('node:test');
const assert = require('node:assert/strict');

const { isCutSpeed, buildKeepRanges, RevisionGuard } = require('../shared.js');

test('v1 cut chunks accept current speed 0 and legacy 99999', () => {
  assert.equal(isCutSpeed(0), true);
  assert.equal(isCutSpeed(99999), true);
  assert.equal(isCutSpeed(1), false);
  assert.equal(isCutSpeed(2), false);
});

test('buildKeepRanges keeps only manually disabled valid cuts', () => {
  const cuts = [
    { start: 1, end: 2, enabled: true },
    { start: 3, end: 4.5, enabled: false },
    { start: 9, end: 8, enabled: false },
  ];
  assert.deepEqual(buildKeepRanges(cuts), [{ start: 3, end: 4.5 }]);
});

test('RevisionGuard rejects stale async results after settings change', () => {
  const revision = new RevisionGuard();
  const startedAt = revision.snapshot();
  assert.equal(revision.isCurrent(startedAt), true);
  revision.bump();
  assert.equal(revision.isCurrent(startedAt), false);
});
