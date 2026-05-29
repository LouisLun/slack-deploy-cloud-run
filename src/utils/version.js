function bumpPatch(tagName) {
  if (!tagName) return 'v0.0.1';
  const match = tagName.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return 'v0.0.1';
  const [, major, minor, patch] = match;
  return `v${major}.${minor}.${Number(patch) + 1}`;
}

module.exports = { bumpPatch };
