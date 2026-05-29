# slack-deploy-cloud-run

A Node.js HTTP server deployed on Google Cloud Run that handles Slack Slash Commands and orchestrates GitHub deployment workflows via `workflow_dispatch`.

---

## Slash Commands

| Command | Description |
|---|---|
| `/deploy <group>` | Deploy all projects in a group, following step order |
| `/hotfix <project>` | Deploy a single hotfix for a project |
| `/deploy-config list` | List current groups and projects from GCS config |

---

## Environment Variables

| Variable | Description |
|---|---|
| `SLACK_SIGNING_SECRET` | Found in your Slack App → Basic Information |
| `SLACK_BOT_TOKEN` | `xoxb-` token from Slack App → OAuth & Permissions |
| `GITHUB_CLIENT_ID` | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret |
| `GCS_BUCKET_NAME` | GCS bucket that holds the config file |
| `GCS_CONFIG_FILE_PATH` | Path to the config JSON file inside the bucket (e.g. `deploy-config.json`) |
| `APP_BASE_URL` | Public URL of this Cloud Run service (e.g. `https://slack-deploy-xyz-uc.a.run.app`) — used to construct the GitHub OAuth callback URL |
| `PORT` | Port to listen on (default `8080`) |

Copy `.env.example` to `.env` for local development.

---

## GCS Config File Format

Upload a JSON file to GCS with the following structure:

```json
{
  "groups": {
    "production": [
      {
        "step": 1,
        "projects": [
          { "name": "restful", "repo": "myorg/restful", "workflows": ["release-cd.yml"] },
          { "name": "wms",     "repo": "myorg/wms",     "workflows": ["release-cd.yml", "notify.yml"] },
          { "name": "console", "repo": "myorg/console", "workflows": ["release-cd.yml"] }
        ]
      },
      {
        "step": 2,
        "projects": [
          { "name": "website", "repo": "myorg/website", "workflows": ["release-cd.yml"] }
        ]
      }
    ]
  },
  "projects": {
    "restful": { "repo": "myorg/restful", "workflows": ["release-cd.yml"] },
    "wms":     { "repo": "myorg/wms",     "workflows": ["release-cd.yml", "notify.yml"] },
    "console": { "repo": "myorg/console", "workflows": ["release-cd.yml"] },
    "website": { "repo": "myorg/website", "workflows": ["release-cd.yml"] }
  }
}
```

- **`groups`** — used by `/deploy`. Each group is an array of steps.
- **`projects`** — used by `/hotfix`. A flat map of project name → repo + workflows.
- Projects can appear in both sections independently.
- The config is read fresh from GCS on every command — no caching.

---

## Step Flow Logic (`/deploy`)

```
Group: production
  ├─ Step 1 ──────────────────────────────── (all triggered in parallel)
  │    ├─ restful:  release-cd.yml
  │    ├─ wms:      release-cd.yml → notify.yml  (sequential within project)
  │    └─ console:  release-cd.yml
  │         ↓ wait for ALL step-1 projects to finish
  └─ Step 2
       └─ website:  release-cd.yml
```

- Projects **within the same step** run in parallel (`Promise.all`).
- Workflows **within the same project** run sequentially — each one waits for the previous to reach `completed` status.
- The next step only starts after every project in the current step succeeds.
- If any workflow fails (non-`success` conclusion), the deploy halts and reports the error to Slack.
- Projects with no matching `production`-labeled PR are skipped; the rest proceed normally.

### Version numbering

- Reads the latest GitHub Release for each repo.
- Increments the patch component: `v1.2.3` → `v1.2.4`.
- If the repo has no releases yet, starts at `v0.0.1`.

---

## Hotfix Flow (`/hotfix <project>`)

1. User runs `/hotfix <project>` in any channel.
2. Bot sends an ephemeral message with a GitHub OAuth link.
3. User clicks the link and authorizes.
4. Server:
   - Reads config from GCS, validates the project exists in `projects`.
   - Finds the latest open PR labeled `hotfix` (case-insensitive) in the project repo.
   - Computes next patch version from the latest release.
   - Runs each workflow in `projects.<name>.workflows` sequentially, waiting for each to complete.
   - Creates a GitHub Release on success.
5. All progress is posted in real time to the originating Slack channel.
6. The GitHub token is discarded immediately after use.

---

## GitHub OAuth Flow

All commands follow the same authorization pattern:

1. Bot sends an ephemeral Slack message with a GitHub OAuth URL (valid 10 minutes).
2. User clicks → GitHub authorization page.
3. GitHub redirects to `GET /auth/github/callback?code=...&state=...`.
4. Server exchanges the code for a token, runs the deployment, then discards the token.
5. The browser receives an HTML confirmation page and can be closed.

The OAuth state parameter ties the callback to the original Slack context (user, channel, command arguments). State entries expire after 10 minutes and are deleted on first use.

> **Note:** The OAuth state store is in-memory. For multi-instance Cloud Run deployments set `--min-instances=1` and `--max-instances=1`, or replace `src/utils/oauth.js` with a shared store (Cloud Memorystore / Firestore).

---

## GitHub OAuth App Setup

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in:
   - **Application name**: `Slack Deploy Bot` (or any name)
   - **Homepage URL**: your Cloud Run service URL
   - **Authorization callback URL**: `https://<APP_BASE_URL>/auth/github/callback`
3. Click **Register application**.
4. Copy **Client ID** → `GITHUB_CLIENT_ID`.
5. Generate a **Client Secret** → `GITHUB_CLIENT_SECRET`.

The OAuth scope requested is `repo` + `workflow`, which allows reading PRs/releases and triggering `workflow_dispatch`.

---

## Cloud Run Deployment

### Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated.
- A GCS bucket with the config JSON uploaded.
- The Cloud Run service account must have the `storage.objects.get` role on the bucket.

### 1. Build and push the container

```bash
PROJECT_ID=your-gcp-project-id
IMAGE=gcr.io/$PROJECT_ID/slack-deploy-cloud-run

docker build -t $IMAGE .
docker push $IMAGE
```

Or use Cloud Build:

```bash
gcloud builds submit --tag $IMAGE
```

### 2. Deploy to Cloud Run

```bash
gcloud run deploy slack-deploy-cloud-run \
  --image $IMAGE \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --set-env-vars "SLACK_SIGNING_SECRET=...,\
SLACK_BOT_TOKEN=...,\
GITHUB_CLIENT_ID=...,\
GITHUB_CLIENT_SECRET=...,\
GCS_BUCKET_NAME=...,\
GCS_CONFIG_FILE_PATH=deploy-config.json,\
APP_BASE_URL=https://<service-url>"
```

> Use `--max-instances 1` to avoid OAuth state issues with the in-memory store.
> For secrets, prefer `--set-secrets` with Secret Manager over `--set-env-vars`.

### 3. Note the service URL

```bash
gcloud run services describe slack-deploy-cloud-run \
  --region us-central1 \
  --format 'value(status.url)'
```

Set this as `APP_BASE_URL` and update the GitHub OAuth App callback URL.

---

## Slack App Setup

1. Create a new app at [api.slack.com/apps](https://api.slack.com/apps).
2. Under **Slash Commands**, add:
   - `/deploy` → Request URL: `https://<APP_BASE_URL>/slack/deploy`
   - `/hotfix` → Request URL: `https://<APP_BASE_URL>/slack/hotfix`
   - `/deploy-config` → Request URL: `https://<APP_BASE_URL>/slack/deploy-config`
3. Under **OAuth & Permissions**, add Bot Token Scopes:
   - `chat:write` — post messages to channels
   - `chat:write.public` — post to channels the bot hasn't joined
4. Install the app to your workspace and copy the **Bot User OAuth Token** → `SLACK_BOT_TOKEN`.
5. Under **Basic Information**, copy **Signing Secret** → `SLACK_SIGNING_SECRET`.

---

## Local Development

```bash
cp .env.example .env
# fill in .env values

npm install
npm run dev
```

Use [ngrok](https://ngrok.com/) or similar to expose localhost and set the Slack slash command URLs and GitHub OAuth callback URL to your ngrok URL during development.
