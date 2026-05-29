const crypto = require('crypto');
const { storePending } = require('../utils/oauth');

async function handleDeploy(req, res) {
  const { text, channel_id, user_id, user_name } = req.body;
  const groupName = text.trim();

  if (!groupName) {
    return res.json({ response_type: 'ephemeral', text: 'Usage: `/deploy <group-name>`' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  storePending(state, {
    type: 'deploy',
    groupName,
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
    text: `Deploy group *${groupName}*: <${authUrl}|Click here to authorize GitHub>\n_Link expires in 10 minutes._`,
  });
}

module.exports = { handleDeploy };
