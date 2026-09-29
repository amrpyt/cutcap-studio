(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AEGShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isCutSpeed(value) {
    const speed = Number(value);
    return speed === 0 || speed >= 99999;
  }

  function buildKeepRanges(cuts) {
    return (Array.isArray(cuts) ? cuts : [])
      .filter(c => c && c.enabled === false && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end)) && Number(c.end) > Number(c.start) && Number(c.start) >= 0)
      .slice(0, 3000)
      .map(c => ({ start: Number(c.start), end: Number(c.end) }));
  }

  class RevisionGuard {
    constructor() { this.value = 0; }
    snapshot() { return this.value; }
    bump() { return ++this.value; }
    isCurrent(snapshot) { return snapshot === this.value; }
  }

  return { isCutSpeed, buildKeepRanges, RevisionGuard };
});
