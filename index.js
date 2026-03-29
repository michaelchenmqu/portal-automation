require("dotenv").config();
const cron = require("node-cron");
const axios = require("axios");

// ─────────────────────────────────────────────
// CONFIG — all values from .env
// ─────────────────────────────────────────────
const {
  ANTHROPIC_API_KEY,
  ASANA_ACCESS_TOKEN,
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,         // #portal-product-feedback = C0AC8P92G3B
  ASANA_PROJECT_GID,        // Portal Stabilisation = 1213802028079816
  TIMEZONE,                 // Australia/Sydney
} = process.env;

const PROJECT_GID   = ASANA_PROJECT_GID  || "1213802028079816";
const CHANNEL_ID    = SLACK_CHANNEL_ID   || "C0AC8P92G3B";
const TZ            = TIMEZONE           || "Australia/Sydney";
const ASANA_BASE    = "https://app.asana.com/api/1.0";
const ASANA_TASK_URL = (gid) => `https://app.asana.com/0/${PROJECT_GID}/${gid}/f`;

// Owner map: Asana GID → { name, slack }
const OWNERS = {
  "1213776006274031": { name: "Pete",   slack: "U06MSUARQ77" },
  "1213778917763529": { name: "Saber",  slack: "U09FT29J3LH" },
  "1210457965895022": { name: "Mahit",  slack: "U07UXL3FX37" },
  "1213779385519783": { name: "Chayan", slack: "U06S0T3UFFB" },
};

// Slack IDs to watch for auto-task conversion
const WATCH_USERS = {
  "U06LB8LJ50R": "Dali",
  "U06MSUARQ77": "Pete",
};

// Track last processed message ts to avoid duplicates
let lastProcessedTs = (Date.now() / 1000 - 3600).toString(); // start 1hr ago

// ─────────────────────────────────────────────
// ASANA HELPERS
// ─────────────────────────────────────────────
async function asanaGet(path, params = {}) {
  const res = await axios.get(`${ASANA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${ASANA_ACCESS_TOKEN}` },
    params,
  });
  return res.data.data;
}

async function asanaPost(path, body) {
  const res = await axios.post(`${ASANA_BASE}${path}`, { data: body }, {
    headers: { Authorization: `Bearer ${ASANA_ACCESS_TOKEN}` },
  });
  return res.data.data;
}

async function fetchAllTasks() {
  const tasks = await asanaGet(`/projects/${PROJECT_GID}/tasks`, {
    opt_fields: "gid,name,completed,assignee,assignee.name,custom_fields,notes,due_on",
    limit: 100,
  });
  return tasks.filter((t) => !t.completed);
}

function getTaskScope(task) {
  if (!task.custom_fields) return "General";
  const scopeField = task.custom_fields.find((f) => f.gid === "1213815702340197");
  return scopeField?.text_value || "General";
}

function getTaskStatus(task) {
  if (!task.custom_fields) return "Open";
  const statusField = task.custom_fields.find((f) => f.gid === "1213802028079845");
  return statusField?.display_value || "Open";
}

function getProgressUpdate(task) {
  if (!task.custom_fields) return null;
  const progressField = task.custom_fields.find((f) => f.gid === "1213802028079850");
  return progressField?.text_value || null;
}

// ─────────────────────────────────────────────
// SLACK HELPERS
// ─────────────────────────────────────────────
async function slackPost(channel, text, blocks = null) {
  const body = { channel, text };
  if (blocks) body.blocks = blocks;
  const res = await axios.post("https://slack.com/api/chat.postMessage", body, {
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.data.ok) console.error("Slack error:", res.data.error);
  return res.data;
}

async function slackGetHistory(channel, oldest) {
  const res = await axios.get("https://slack.com/api/conversations.history", {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    params: { channel, oldest, limit: 50 },
  });
  return res.data.messages || [];
}

async function slackGetUserInfo(userId) {
  const res = await axios.get("https://slack.com/api/users.info", {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    params: { user: userId },
  });
  return res.data.user;
}

// ─────────────────────────────────────────────
// ANTHROPIC HELPER
// ─────────────────────────────────────────────
async function callClaude(prompt, system = "") {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;
  const res = await axios.post("https://api.anthropic.com/v1/messages", body, {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
  });
  return res.data.content[0].text;
}

// ─────────────────────────────────────────────
// REPORT 1 — Executive summary to #portal-product-feedback
// Every 2hrs Mon-Fri 8am–6pm AEST
// ─────────────────────────────────────────────
async function sendExecutiveSummary() {
  console.log(`[${new Date().toISOString()}] Sending executive summary...`);
  try {
    const tasks = await fetchAllTasks();

    // Group by category
    const byCategory = {};
    let overdueCount = 0;
    let unassignedCount = 0;
    const testingTasks = [];
    const overdueTasks = [];

    for (const task of tasks) {
      const cat = getTaskScope(task);
      const status = getTaskStatus(task);
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push({ ...task, _status: status });

      if (!task.assignee) unassignedCount++;
      if (status === "Overdue") { overdueCount++; overdueTasks.push(task.name); }
      if (status === "Testing") testingTasks.push(task.name);
    }

    const now = new Date().toLocaleString("en-AU", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit",
      weekday: "short", day: "numeric", month: "short",
    });

    // Build category lines
    const statusEmoji = { "Open": "🔵", "Testing": "🟡", "Development": "🟠", "Deployment": "🟣", "Overdue": "🔴", "Completed": "🟢" };
    const catLines = Object.entries(byCategory).map(([cat, catTasks]) => {
      const statuses = catTasks.map((t) => t._status);
      const hasOverdue = statuses.includes("Overdue");
      const allOpen = statuses.every((s) => s === "Open");
      const icon = hasOverdue ? "🔴" : allOpen ? "🔵" : "🟡";
      return `${icon} *${cat}* — ${catTasks.length} task${catTasks.length > 1 ? "s" : ""} · ${[...new Set(statuses)].join(", ")}`;
    }).join("\n");

    const overdueBlock = overdueCount > 0
      ? `\n\n⚠️ *Overdue (${overdueCount}):* ${overdueTasks.map((n) => `_${n}_`).join(", ")}`
      : "";

    const unassignedBlock = unassignedCount > 0
      ? `\n⚠️ *Unassigned tasks:* ${unassignedCount} need owners`
      : "";

    const testingBlock = testingTasks.length > 0
      ? `\n🧪 *In Testing:* ${testingTasks.join(", ")}`
      : "";

    const message = [
      `📊 *Portal Stabilisation — Status Report*`,
      `_${now} · Auto-generated every 2hrs_`,
      ``,
      `*${tasks.length} open tasks across ${Object.keys(byCategory).length} categories*`,
      ``,
      catLines,
      overdueBlock,
      unassignedBlock,
      testingBlock,
      ``,
      `_Full task details: <https://app.asana.com/0/${PROJECT_GID}|Open in Asana>_`,
    ].join("\n");

    await slackPost(CHANNEL_ID, message);
    console.log(`[${new Date().toISOString()}] Executive summary sent ✓`);
  } catch (err) {
    console.error("Executive summary error:", err.message);
  }
}

// ─────────────────────────────────────────────
// REPORT 2 — Owner reminders via DM
// Every 2hrs Mon-Fri 9:30am–5:30pm AEST
// ─────────────────────────────────────────────
async function sendOwnerReminders() {
  console.log(`[${new Date().toISOString()}] Sending owner reminders...`);
  try {
    const tasks = await fetchAllTasks();

    // Group tasks by owner Asana GID
    const byOwner = {};
    for (const task of tasks) {
      const assigneeGid = task.assignee?.gid;
      if (!assigneeGid || !OWNERS[assigneeGid]) continue;
      if (!byOwner[assigneeGid]) byOwner[assigneeGid] = [];
      byOwner[assigneeGid].push(task);
    }

    const now = new Date().toLocaleString("en-AU", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit",
    });

    for (const [asanaGid, ownerTasks] of Object.entries(byOwner)) {
      const owner = OWNERS[asanaGid];

      const taskLines = ownerTasks.map((t) => {
        const status = getTaskStatus(t);
        const progress = getProgressUpdate(t);
        const statusEmoji = status === "Overdue" ? "🔴" : status === "Testing" ? "🟡" : "🔵";
        const progressNote = progress
          ? `\n   _Last update: ${progress.slice(0, 80)}${progress.length > 80 ? "…" : ""}_`
          : `\n   _No progress update yet_`;
        return `${statusEmoji} *${t.name}*${progressNote}\n   📎 <${ASANA_TASK_URL(t.gid)}|Open task in Asana>`;
      }).join("\n\n");

      const message = [
        `⏰ *Reminder to update progress within 30 mins*`,
        `_${now} · Portal Stabilisation_`,
        ``,
        `Hi ${owner.name}! You have *${ownerTasks.length} open task${ownerTasks.length > 1 ? "s" : ""}* requiring a progress update:`,
        ``,
        taskLines,
        ``,
        `Please update the *Progress Log* field in each task. Takes 30 seconds! 🙏`,
      ].join("\n");

      await slackPost(owner.slack, message);
      console.log(`[${new Date().toISOString()}] Reminder sent to ${owner.name} ✓`);

      // Small delay between DMs
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (err) {
    console.error("Owner reminder error:", err.message);
  }
}

// ─────────────────────────────────────────────
// AUTO-TASK CONVERTER
// Polls #portal-product-feedback every 15 mins
// Converts actionable posts by Dali or Pete to Asana tasks
// ─────────────────────────────────────────────
async function autoConvertSlackToTasks() {
  console.log(`[${new Date().toISOString()}] Checking for new posts to convert...`);
  try {
    const messages = await slackGetHistory(CHANNEL_ID, lastProcessedTs);
    if (!messages.length) return;

    // Sort oldest first
    const sorted = [...messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    for (const msg of sorted) {
      if (parseFloat(msg.ts) <= parseFloat(lastProcessedTs)) continue;
      lastProcessedTs = msg.ts;

      // Only process messages from Dali or Pete
      const watchedUser = WATCH_USERS[msg.user];
      if (!watchedUser) continue;

      // Skip if too short or just a greeting
      const text = (msg.text || "").trim();
      if (text.length < 30) continue;
      if (/^(hi|hello|hey|thanks|ok|yes|no)\b/i.test(text)) continue;

      console.log(`[${new Date().toISOString()}] Evaluating message from ${watchedUser}...`);

      // Use Claude to decide if this is actionable and extract task details
      const analysis = await callClaude(
        `Analyze this Slack message from ${watchedUser} and determine if it contains actionable feedback, bug reports, or feature requests that should become Asana tasks. If yes, extract the task details.

Message: "${text}"

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "is_actionable": true or false,
  "reason": "brief reason",
  "tasks": [
    {
      "name": "Short task name (max 60 chars)",
      "description": "Full description of what needs to be done",
      "category": "one of: Alerts & Intelligence | Voice | Bot Management | Portal UX & Performance | Operations & Targeting | Email | Reporting & Analytics",
      "suggested_assignee": "Pete or Saber or Mahit or Chayan or null"
    }
  ]
}`,
        "You are a project manager assistant. Extract actionable tasks from Slack messages. Return only valid JSON."
      );

      let parsed;
      try {
        const clean = analysis.replace(/```json\n?|```\n?/g, "").trim();
        parsed = JSON.parse(clean);
      } catch {
        console.error("Failed to parse Claude response:", analysis);
        continue;
      }

      if (!parsed.is_actionable || !parsed.tasks?.length) {
        console.log(`Message from ${watchedUser} not actionable: ${parsed.reason}`);
        continue;
      }

      // Create Asana tasks
      const createdTasks = [];
      for (const taskDef of parsed.tasks) {
        // Find assignee GID
        const assigneeEntry = Object.entries(OWNERS).find(
          ([, v]) => v.name === taskDef.suggested_assignee
        );
        const assigneeGid = assigneeEntry ? assigneeEntry[0] : null;

        const task = await asanaPost("/tasks", {
          name: taskDef.name,
          notes: [
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `CATEGORY: ${taskDef.category}`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `DESCRIPTION`,
            taskDef.description,
            ``,
            `SOURCE: ${watchedUser} in #portal-product-feedback`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `SOLUTION`,
            `[Owner to complete]`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `PROGRESS LOG (update every 2 hrs)`,
            `[YYYY-MM-DD HH:MM] — [Update here]`,
          ].join("\n"),
          projects: [PROJECT_GID],
          ...(assigneeGid && { assignee: assigneeGid }),
        });

        createdTasks.push({ ...task, category: taskDef.category });
        console.log(`[${new Date().toISOString()}] Created task: "${taskDef.name}" ✓`);
      }

      // Post confirmation back to Slack thread
      if (createdTasks.length > 0) {
        const taskList = createdTasks.map(
          (t) => `• <${ASANA_TASK_URL(t.gid)}|${t.name}>`
        ).join("\n");

        await slackPost(CHANNEL_ID,
          `✅ *${createdTasks.length} Asana task${createdTasks.length > 1 ? "s" : ""} created from ${watchedUser}'s feedback:*\n${taskList}`,
          null
        );
      }

      // Small delay between messages
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    console.error("Auto-convert error:", err.message);
  }
}

// ─────────────────────────────────────────────
// STARTUP CHECK
// ─────────────────────────────────────────────
async function startupCheck() {
  console.log("─────────────────────────────────────────");
  console.log("  Portal Stabilisation Automation Server");
  console.log("─────────────────────────────────────────");
  console.log(`  Timezone : ${TZ}`);
  console.log(`  Project  : ${PROJECT_GID}`);
  console.log(`  Channel  : ${CHANNEL_ID}`);
  console.log("");

  // Verify credentials
  try {
    const tasks = await fetchAllTasks();
    console.log(`  ✓ Asana connected — ${tasks.length} open tasks found`);
  } catch (e) {
    console.error("  ✗ Asana connection failed:", e.message);
    process.exit(1);
  }

  try {
    await axios.get("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    console.log("  ✓ Slack connected");
  } catch (e) {
    console.error("  ✗ Slack connection failed:", e.message);
    process.exit(1);
  }

  console.log("  ✓ All systems go\n");

  // Send startup notification
  await slackPost(
    CHANNEL_ID,
    `🤖 *Portal Stabilisation Automation is now active*\n_Reporting every 2hrs Mon–Fri 8am–6pm · Owner reminders at 9:30am–5:30pm · Auto-task conversion from Dali & Pete posts enabled_`
  );
}

// ─────────────────────────────────────────────
// CRON SCHEDULES (all times in Australia/Sydney)
// ─────────────────────────────────────────────
// Report 1: Mon-Fri 8am, 10am, 12pm, 2pm, 4pm, 6pm
const REPORT_SCHEDULE = "0 8,10,12,14,16,18 * * 1-5";

// Report 2 (reminders): Mon-Fri 9:30am, 11:30am, 1:30pm, 3:30pm, 5:30pm
const REMINDER_SCHEDULE = "30 9,11,13,15,17 * * 1-5";

// Auto-convert: every 15 minutes
const AUTOCONVERT_SCHEDULE = "*/15 * * * *";

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
(async () => {
  await startupCheck();

  // Schedule Report 1 — Executive summary
  cron.schedule(REPORT_SCHEDULE, sendExecutiveSummary, { timezone: TZ });
  console.log(`📊 Report 1 scheduled: ${REPORT_SCHEDULE} (${TZ})`);

  // Schedule Report 2 — Owner reminders
  cron.schedule(REMINDER_SCHEDULE, sendOwnerReminders, { timezone: TZ });
  console.log(`⏰ Report 2 scheduled: ${REMINDER_SCHEDULE} (${TZ})`);

  // Schedule Auto-converter
  cron.schedule(AUTOCONVERT_SCHEDULE, autoConvertSlackToTasks);
  console.log(`🔄 Auto-converter scheduled: every 15 mins`);

  console.log("\n✅ All schedulers running. Press Ctrl+C to stop.\n");
})();
