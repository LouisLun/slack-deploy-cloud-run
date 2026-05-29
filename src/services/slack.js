const { WebClient } = require('@slack/web-api');

let _client = null;

function getClient() {
  if (!_client) _client = new WebClient(process.env.SLACK_BOT_TOKEN);
  return _client;
}

async function sendEphemeral(channelId, userId, text) {
  return getClient().chat.postEphemeral({ channel: channelId, user: userId, text });
}

async function postMessage(channelId, text) {
  return getClient().chat.postMessage({ channel: channelId, text });
}

module.exports = { sendEphemeral, postMessage };
