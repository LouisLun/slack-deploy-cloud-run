const { readConfig } = require('../services/gcs');
const {
  getLatestPRWithLabel,
  getLatestRelease,
  triggerAndWaitWorkflow,
  createRelease,
} = require('../services/github');
const { postMessage } = require('../services/slack');
const { bumpPatch } = require('../utils/version');

async function runHotfix(token, pendingOp) {
  const { projectName, channelId, userName } = pendingOp;
  const notify = (text) => postMessage(channelId, text);

  await notify(`🔥 *Hotfix \`${projectName}\`* started by @${userName}`);

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    await notify(`❌ Failed to read config from GCS: ${err.message}`);
    return;
  }

  const project = config.projects?.[projectName];
  if (!project) {
    await notify(`❌ Project \`${projectName}\` not found in config`);
    return;
  }

  let pr;
  try {
    pr = await getLatestPRWithLabel(token, project.repo, 'hotfix');
  } catch (err) {
    await notify(`❌ Failed to fetch PRs for \`${project.repo}\`: ${err.message}`);
    return;
  }

  if (!pr) {
    await notify(
      `❌ No open PR labeled \`hotfix\` found in \`${project.repo}\`. Aborting.`
    );
    return;
  }

  let latestRelease;
  try {
    latestRelease = await getLatestRelease(token, project.repo);
  } catch (err) {
    await notify(`❌ Failed to fetch latest release: ${err.message}`);
    return;
  }

  const newVersion = bumpPatch(latestRelease?.tag_name);
  const ref = pr.base.ref;

  await notify(
    `🔍 PR #${pr.number}: "${pr.title}"\n   Branch: \`${ref}\` → Version: \`${newVersion}\``
  );

  for (const workflow of project.workflows) {
    try {
      await notify(`⚙️ Triggering \`${workflow}\`...`);
      await triggerAndWaitWorkflow(token, project.repo, workflow, ref, notify);
      await notify(`✅ \`${workflow}\` succeeded`);
    } catch (err) {
      await notify(`❌ \`${workflow}\` failed — ${err.message}`);
      return;
    }
  }

  try {
    const release = await createRelease(
      token,
      project.repo,
      newVersion,
      newVersion,
      `Hotfix via Slack by @${userName}\n\nPR: ${pr.html_url}`
    );
    await notify(`🏷️ Created release ${newVersion} → ${release.html_url}`);
  } catch (err) {
    await notify(`⚠️ Failed to create release: ${err.message}`);
  }

  await notify(`🎉 Hotfix \`${projectName}\` complete!`);
}

module.exports = { runHotfix };
