const pendingOps = new Map();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

function storePending(state, data) {
  pendingOps.set(state, { ...data, expiresAt: Date.now() + TTL_MS });
  for (const [key, val] of pendingOps.entries()) {
    if (Date.now() > val.expiresAt) pendingOps.delete(key);
  }
}

function getPending(state) {
  const op = pendingOps.get(state);
  if (!op) return null;
  pendingOps.delete(state);
  if (Date.now() > op.expiresAt) return null;
  return op;
}

module.exports = { storePending, getPending };
