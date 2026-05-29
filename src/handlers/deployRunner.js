const { readConfig } = require('../services/gcs');
const {
  getLatestPRWithLabel,
  getLatestRelease,
  triggerAndWaitWorkflow,
  createRelease,
} = require('../services/github');
const { postMessage } = require('../services/slack');
const { bumpPatch } = require('../utils/version');

async function runDeploy(token, pendingOp) {
  const { groupName, channelId, userName } = pendingOp;
  const notify = (text) => postMessage(channelId, text);

  await notify(`🚀 *Deploy \`${groupName}\`* started by @${userName}`);

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    await notify(`❌ Failed to read config from GCS: ${err.message}`);
    return;
  }

  const group = config.groups?.[groupName];
  if (!group) {
    await notify(`❌ Group \`${groupName}\` not found in config`);
    return;
  }

  const steps = [...group].sort((a, b) => a.step - b.step);

  // Pre-fetch PR info and compute versions for all projects
  await notify(`🔍 Checking PRs and latest releases...`);

  const projectData = {};
  const skipped = [];

  for (const step of steps) {
    for (const proj of step.projects) {
      let pr, latestRelease;
      try {
        pr = await getLatestPRWithLabel(token, proj.repo, 'production');
      } catch (err) {
        await notify(`⚠️ \`${proj.name}\`: failed to fetch PRs — ${err.message}`);
        skipped.push(proj.name);
        continue;
      }

      if (!pr) {
        skipped.push(proj.name);
        continue;
      }

      try {
        latestRelease = await getLatestRelease(token, proj.repo);
      } catch (err) {
        await notify(`⚠️ \`${proj.name}\`: failed to fetch latest release — ${err.message}`);
        skipped.push(proj.name);
        continue;
      }

      projectData[proj.name] = {
        repo: proj.repo,
        workflows: proj.workflows,
        ref: pr.base.ref,
        pr,
        newVersion: bumpPatch(latestRelease?.tag_name),
      };
    }
  }

  if (skipped.length > 0) {
    await notify(
      `⚠️ Skipping (no PR labeled \`production\`): ${skipped.map((s) => `\`${s}\``).join(', ')}`
    );
  }

  const activeCount = Object.keys(projectData).length;
  if (activeCount === 0) {
    await notify(`❌ No projects to deploy. Aborting.`);
    return;
  }

  // Execute steps in order
  for (const step of steps) {
    const activeProjects = step.projects.filter((p) => projectData[p.name]);
    if (activeProjects.length === 0) {
      await notify(`⏭️ Step ${step.step}: all projects skipped`);
      continue;
    }

    await notify(
      `▶️ *Step ${step.step}*: ${activeProjects.map((p) => `\`${p.name}\``).join(', ')}`
    );

    let stepFailed = false;
    await Promise.all(
      activeProjects.map(async (proj) => {
        const { repo, workflows, ref } = projectData[proj.name];
        for (const workflow of workflows) {
          try {
            await notify(`  ⚙️ \`${proj.name}\`: triggering \`${workflow}\`...`);
            await triggerAndWaitWorkflow(token, repo, workflow, ref, (msg) =>
              notify(`  ${msg}`)
            );
            await notify(`  ✅ \`${proj.name}\`: \`${workflow}\` succeeded`);
          } catch (err) {
            await notify(`  ❌ \`${proj.name}\`: \`${workflow}\` failed — ${err.message}`);
            stepFailed = true;
            throw err;
          }
        }
      })
    ).catch(() => {
      stepFailed = true;
    });

    if (stepFailed) {
      await notify(`❌ Step ${step.step} failed. Deployment halted.`);
      return;
    }

    await notify(`✅ Step ${step.step} complete`);
  }

  // Create GitHub Releases
  await notify(`📦 Creating GitHub Releases...`);
  for (const [name, data] of Object.entries(projectData)) {
    try {
      const release = await createRelease(
        token,
        data.repo,
        data.newVersion,
        data.newVersion,
        `Deploy via Slack by @${userName}\n\nPR: ${data.pr.html_url}`
      );
      await notify(`  🏷️ \`${name}\`: ${data.newVersion} → ${release.html_url}`);
    } catch (err) {
      await notify(`  ⚠️ \`${name}\`: failed to create release — ${err.message}`);
    }
  }

  await notify(`🎉 Deploy \`${groupName}\` complete!`);
}

module.exports = { runDeploy };
