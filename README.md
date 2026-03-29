# Portal Stabilisation Automation

Automated reporting, owner reminders, and Slack-to-Asana task conversion for the Portal Stabilisation project.

## What it does

| Feature | Schedule | Destination |
|---|---|---|
| Executive summary report | Mon–Fri 8am, 10am, 12pm, 2pm, 4pm, 6pm AEST | #portal-product-feedback |
| Owner progress reminders | Mon–Fri 9:30am, 11:30am, 1:30pm, 3:30pm, 5:30pm AEST | Direct message to each owner |
| Auto-convert Dali/Pete posts → Asana tasks | Every 15 mins, always on | Portal Stabilisation project |

---

## Deployment on Railway (free, ~5 mins)

### Step 1 — Create a Slack Bot

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it `Portal Bot`, select your workspace
3. Go to **OAuth & Permissions** → scroll to **Scopes** → add these **Bot Token Scopes**:
   - `chat:write`
   - `channels:history`
   - `users:read`
   - `im:write`
   - `groups:read`
4. Click **Install to Workspace** → copy the **Bot User OAuth Token** (starts with `xoxb-`)
5. Invite the bot to `#portal-product-feedback`: type `/invite @Portal Bot` in that channel

### Step 2 — Get your API keys

**Anthropic API key:**
- Go to https://console.anthropic.com → API Keys → Create key
- Copy it (starts with `sk-ant-`)

**Asana Personal Access Token:**
- Go to https://app.asana.com/0/my-apps
- Click **Create new token** → name it "Portal Automation" → copy it

### Step 3 — Deploy to Railway

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
   - Or click **Deploy from local** and upload this folder as a zip
2. Once deployed, go to your project → **Variables** tab
3. Add all variables from `.env.example` with your real values:

```
ANTHROPIC_API_KEY     = sk-ant-...
ASANA_ACCESS_TOKEN    = your-asana-token
SLACK_BOT_TOKEN       = xoxb-...
SLACK_CHANNEL_ID      = C0AC8P92G3B
ASANA_PROJECT_GID     = 1213802028079816
TIMEZONE              = Australia/Sydney
```

4. Railway will auto-deploy. Check **Logs** tab — you should see:
```
✓ Asana connected — 27 open tasks found
✓ Slack connected
✓ All systems go
```

That's it. The bot runs 24/7 on Railway's free tier (500 hrs/month).

---

## Alternative: Deploy to Render (also free)

1. Go to https://render.com → **New** → **Web Service**
2. Connect your GitHub repo or use **Deploy from existing code**
3. Set **Start Command** to `npm start`
4. Add environment variables in the **Environment** tab
5. Deploy

---

## Running locally (for testing)

```bash
# Install dependencies
npm install

# Copy and fill in your env file
cp .env.example .env
# Edit .env with your real values

# Run
npm start
```

---

## Owner–Slack mapping

| Name | Asana GID | Slack ID |
|---|---|---|
| Pete | 1213776006274031 | U06MSUARQ77 |
| Saber | 1213778917763529 | U09FT29J3LH |
| Mahit | 1210457965895022 | U07UXL3FX37 |
| Chayan | 1213779385519783 | U06S0T3UFFB |

To add more owners, edit the `OWNERS` constant in `index.js`.

---

## Auto-task conversion

The bot polls `#portal-product-feedback` every 15 minutes and scans for new messages from **Dali** (`U06LB8LJ50R`) and **Pete** (`U06MSUARQ77`). If Claude determines a message contains actionable feedback, it automatically:

1. Creates an Asana task in Portal Stabilisation with the structured template
2. Assigns it to the suggested owner
3. Posts a confirmation back in the channel with a link to the task

To watch additional users, add them to the `WATCH_USERS` constant in `index.js`.
