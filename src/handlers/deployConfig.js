const { readConfig } = require('../services/gcs');

async function handleDeployConfig(req, res) {
  const { text } = req.body;
  const subcommand = text.trim().toLowerCase();

  if (subcommand !== 'list') {
    return res.json({ response_type: 'ephemeral', text: 'Usage: `/deploy-config list`' });
  }

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    return res.json({
      response_type: 'ephemeral',
      text: `❌ Failed to read config: ${err.message}`,
    });
  }

  const lines = ['*Groups:*'];

  for (const [groupName, steps] of Object.entries(config.groups || {})) {
    lines.push(`  *${groupName}*`);
    const sorted = [...steps].sort((a, b) => a.step - b.step);
    for (const step of sorted) {
      lines.push(`    Step ${step.step}:`);
      for (const p of step.projects) {
        lines.push(`      • \`${p.name}\` (${p.repo}) → ${p.workflows.join(', ')}`);
      }
    }
  }

  lines.push('', '*Projects:*');
  for (const [name, proj] of Object.entries(config.projects || {})) {
    lines.push(`  • \`${name}\` (${proj.repo}) → ${proj.workflows.join(', ')}`);
  }

  return res.json({ response_type: 'ephemeral', text: lines.join('\n') });
}

module.exports = { handleDeployConfig };
