const express = require('express');
const { verifySlackRequest } = require('../middleware/slackVerify');
const { handleDeploy } = require('../handlers/deploy');
const { handleHotfix } = require('../handlers/hotfix');
const { handleDeployConfig } = require('../handlers/deployConfig');

const router = express.Router();

router.use(verifySlackRequest);

router.post('/deploy', async (req, res) => {
  try {
    await handleDeploy(req, res);
  } catch (err) {
    console.error('POST /slack/deploy error:', err);
    res.json({ response_type: 'ephemeral', text: `Internal error: ${err.message}` });
  }
});

router.post('/hotfix', async (req, res) => {
  try {
    await handleHotfix(req, res);
  } catch (err) {
    console.error('POST /slack/hotfix error:', err);
    res.json({ response_type: 'ephemeral', text: `Internal error: ${err.message}` });
  }
});

router.post('/deploy-config', async (req, res) => {
  try {
    await handleDeployConfig(req, res);
  } catch (err) {
    console.error('POST /slack/deploy-config error:', err);
    res.json({ response_type: 'ephemeral', text: `Internal error: ${err.message}` });
  }
});

module.exports = router;
