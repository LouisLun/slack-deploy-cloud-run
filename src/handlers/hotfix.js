const crypto = require('crypto');
const { storePending } = require('../utils/oauth');

async function handleHotfix(req, res) {
  const { text, channel_id, user_id, user_name } = req.body;
  const projectName = text.trim();

  if (!projectName) {
    return res.json({ response_type: 'ephemeral', text: 'Usage: `/hotfix <project-name>`' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  storePending(state, {
    type: 'hotfix',
    projectName,
    channelId: channel_id,
    userId: user_id,
    userName: user_name,
  });

  const callbackUrl = `${process.env.APP_BASE_URL}/auth/github/callback`;
  const authUrl =
    `https://github.com/login/oauth/authorize` +
    `?client_id=${process.env.GITHUB_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
    `&scope=repo+workflow` +
    `&state=${state}`;

  return res.json({
    response_type: 'ephemeral',
    text: `Hotfix project *${projectName}*: <${authUrl}|Click here to authorize GitHub>\n_Link expires in 10 minutes._`,
  });
}

module.exports = { handleHotfix };
