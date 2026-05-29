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

Push to `main` triggers `.github/workflows/deploy.yml` automatically — it builds the Docker image, pushes to Artifact Registry, and deploys to Cloud Run.

### One-time GCP Setup

#### 1. Create Artifact Registry repository

```bash
gcloud artifacts repositories create slack-deploy \
  --repository-format=docker \
  --location=asia-east1
```

#### 2. Create a service account for CI

```bash
gcloud iam service-accounts create github-actions-sa \
  --display-name="GitHub Actions Deploy SA"

SA_EMAIL=github-actions-sa@<PROJECT_ID>.iam.gserviceaccount.com

gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/run.developer"

gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/iam.serviceAccountUser"
```

#### 3. Set up Workload Identity Federation

```bash
PROJECT_NUMBER=$(gcloud projects describe <PROJECT_ID> --format='value(projectNumber)')

# Create pool
gcloud iam workload-identity-pools create github-pool \
  --location=global \
  --display-name="GitHub Actions Pool"

# Create provider
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='LouisLun/slack-deploy-cloud-run'"

# Bind service account
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/LouisLun/slack-deploy-cloud-run"
```

#### 4. Add GitHub repository secrets

Go to **GitHub → repo → Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `GCP_PROJECT_ID` | your GCP project ID |
| `WIF_PROVIDER` | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `WIF_SERVICE_ACCOUNT` | `github-actions-sa@<PROJECT_ID>.iam.gserviceaccount.com` |

### First Deploy (manual)

Run this once to create the Cloud Run service with all environment variables. Subsequent deploys are handled by CI.

```bash
PROJECT_ID=your-gcp-project-id
REGION=asia-east1
IMAGE=asia-east1-docker.pkg.dev/$PROJECT_ID/slack-deploy/slack-deploy-cloud-run:latest

gcloud run deploy slack-deploy-cloud-run \
  --image $IMAGE \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --set-secrets "SLACK_SIGNING_SECRET=SLACK_SIGNING_SECRET:latest,\
SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest,\
GITHUB_CLIENT_ID=GITHUB_CLIENT_ID:latest,\
GITHUB_CLIENT_SECRET=GITHUB_CLIENT_SECRET:latest" \
  --set-env-vars "GCS_BUCKET_NAME=<bucket>,\
GCS_CONFIG_FILE_PATH=deploy-config.json,\
APP_BASE_URL=https://<service-url>"
```

> Use `--set-secrets` (Secret Manager) for sensitive values instead of `--set-env-vars`.
> `--max-instances 1` is required because OAuth state is stored in-memory.

### Get the service URL

```bash
gcloud run services describe slack-deploy-cloud-run \
  --region asia-east1 \
  --format 'value(status.url)'
```

Set this as `APP_BASE_URL` in the Cloud Run service and update the GitHub OAuth App callback URL.

### CI/CD Flow

```
git push main
  └─ GitHub Actions
       ├─ Authenticate via Workload Identity Federation
       ├─ docker build → asia-east1-docker.pkg.dev/.../slack-deploy-cloud-run:<sha>
       ├─ docker push
       └─ gcloud run deploy --image ...<sha>
```

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
