const express = require('express');
const { getPending } = require('../utils/oauth');
const { exchangeCodeForToken } = require('../services/github');
const { runDeploy } = require('../handlers/deployRunner');
const { runHotfix } = require('../handlers/hotfixRunner');

const router = express.Router();

router.get('/github/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(htmlPage('Authorization Failed', `GitHub error: ${error}`));
  }

  if (!code || !state) {
    return res
      .status(400)
      .send(htmlPage('Bad Request', 'Missing required OAuth parameters.'));
  }

  const pendingOp = getPending(state);
  if (!pendingOp) {
    return res
      .status(400)
      .send(htmlPage('Expired', 'Authorization link has expired or was already used.'));
  }

  // Respond immediately so the browser can close; run deployment in background
  res.send(
    htmlPage('Authorization Successful', 'You can close this window. Deployment has started.')
  );

  let token;
  try {
    token = await exchangeCodeForToken(code);
  } catch (err) {
    console.error('OAuth token exchange failed:', err.message);
    return;
  }

  try {
    if (pendingOp.type === 'deploy') {
      await runDeploy(token, pendingOp);
    } else if (pendingOp.type === 'hotfix') {
      await runHotfix(token, pendingOp);
    }
  } catch (err) {
    console.error('Runner error:', err.message);
  } finally {
    // Discard token regardless of outcome
    token = null;
  }
});

function htmlPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
           justify-content: center; height: 100vh; margin: 0; background: #f0f0f0; }
    .card { text-align: center; padding: 2rem 3rem; border-radius: 12px;
            background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
    h2 { margin: 0 0 0.5rem; }
    p  { color: #555; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${title}</h2>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

module.exports = router;
