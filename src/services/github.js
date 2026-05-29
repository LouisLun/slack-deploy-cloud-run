const axios = require('axios');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function client(token) {
  return axios.create({
    baseURL: 'https://api.github.com',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    timeout: 30000,
  });
}

async function exchangeCodeForToken(code) {
  const res = await axios.post(
    'https://github.com/login/oauth/access_token',
    {
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    },
    { headers: { Accept: 'application/json' } }
  );
  if (res.data.error) {
    throw new Error(`GitHub OAuth error: ${res.data.error_description}`);
  }
  return res.data.access_token;
}

async function getLatestPRWithLabel(token, repo, label) {
  const [owner, repoName] = repo.split('/');
  const { data } = await client(token).get(`/repos/${owner}/${repoName}/pulls`, {
    params: { state: 'open', sort: 'updated', direction: 'desc', per_page: 100 },
  });
  return (
    data.find((pr) =>
      pr.labels.some((l) => l.name.toLowerCase() === label.toLowerCase())
    ) || null
  );
}

async function getLatestRelease(token, repo) {
  const [owner, repoName] = repo.split('/');
  try {
    const { data } = await client(token).get(
      `/repos/${owner}/${repoName}/releases/latest`
    );
    return data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function triggerAndWaitWorkflow(token, repo, workflow, ref, onProgress) {
  const [owner, repoName] = repo.split('/');
  const api = client(token);

  // Record max run ID before dispatch so we can identify the new run
  let maxIdBefore = 0;
  try {
    const { data } = await api.get(
      `/repos/${owner}/${repoName}/actions/workflows/${workflow}/runs`,
      { params: { per_page: 1, event: 'workflow_dispatch' } }
    );
    if (data.workflow_runs?.length > 0) {
      maxIdBefore = data.workflow_runs[0].id;
    }
  } catch (_) {}

  await api.post(
    `/repos/${owner}/${repoName}/actions/workflows/${workflow}/dispatches`,
    { ref }
  );

  // Wait up to 90s for new run to appear
  let runId = null;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    try {
      const { data } = await api.get(
        `/repos/${owner}/${repoName}/actions/workflows/${workflow}/runs`,
        { params: { per_page: 5, event: 'workflow_dispatch' } }
      );
      const newRun = data.workflow_runs?.find((r) => r.id > maxIdBefore);
      if (newRun) {
        runId = newRun.id;
        break;
      }
    } catch (_) {}
  }

  if (!runId) {
    throw new Error(
      `Workflow \`${workflow}\` in \`${repo}\` did not start within 90s`
    );
  }

  // Poll until complete — up to 30 minutes
  for (let i = 0; i < 180; i++) {
    const { data: run } = await api.get(
      `/repos/${owner}/${repoName}/actions/runs/${runId}`
    );
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') {
        throw new Error(
          `Workflow \`${workflow}\` in \`${repo}\` finished with conclusion: \`${run.conclusion}\``
        );
      }
      return run;
    }
    if (onProgress) await onProgress(`⏳ \`${workflow}\` (${repo}): ${run.status}`);
    await sleep(10000);
  }

  throw new Error(
    `Workflow \`${workflow}\` in \`${repo}\` timed out after 30 minutes`
  );
}

async function createRelease(token, repo, tagName, name, body) {
  const [owner, repoName] = repo.split('/');
  const { data } = await client(token).post(
    `/repos/${owner}/${repoName}/releases`,
    { tag_name: tagName, name, body, draft: false, prerelease: false }
  );
  return data;
}

module.exports = {
  exchangeCodeForToken,
  getLatestPRWithLabel,
  getLatestRelease,
  triggerAndWaitWorkflow,
  createRelease,
};
