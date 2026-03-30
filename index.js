require("dotenv").config();
const cron = require("node-cron");
const axios = require("axios");

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const { ANTHROPIC_API_KEY, ASANA_ACCESS_TOKEN, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, ASANA_PROJECT_GID, TIMEZONE } = process.env;

const PROJECT_GID    = ASANA_PROJECT_GID || "1213802028079816";
const CHANNEL_ID     = SLACK_CHANNEL_ID  || "C0AC8P92G3B";
const TZ             = TIMEZONE          || "Australia/Sydney";
const ASANA_BASE     = "https://app.asana.com/api/1.0";
const ASANA_TASK_URL = (gid) => `https://app.asana.com/0/${PROJECT_GID}/${gid}/f`;

// Board section GIDs → names
const BOARD_SECTIONS = {
  "1213802028079817": "Backlog",
  "1213802028079820": "Prioritised",
  "1213815704002761": "Planned",
  "1213863123247950": "In Progress",
  "1213863123247951": "Testing",
  "1213863123247952": "Done",
};

const STATUS_EMOJI = {
  "Backlog": "⬜", "Prioritised": "🔷", "Planned": "🔵",
  "In Progress": "🟡", "Testing": "🟠", "Done": "🟢",
};

const OWNERS = {
  "1213776006274031": { name: "Pete",   slack: "U06MSUARQ77" },
  "1213778917763529": { name: "Saber",  slack: "U09FT29J3LH" },
  "1210457965895022": { name: "Mahit",  slack: "U07UXL3FX37" },
  "1213779385519783": { name: "Chayan", slack: "U06S0T3UFFB" },
};

const WATCH_USERS = { "U06LB8LJ50R": "Dali", "U06MSUARQ77": "Pete" };

// In-memory state
let previousStatus   = {};  // { taskGid: "In Progress" }
let lastProcessedTs  = (Date.now() / 1000 - 3600).toString();

// ─────────────────────────────────────────────
// ASANA HELPERS
// ─────────────────────────────────────────────
async function asanaGet(path, params = {}) {
  const res = await axios.get(`${ASANA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${ASANA_ACCESS_TOKEN}` }, params,
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
    opt_fields: "gid,name,completed,assignee,assignee.name,custom_fields,notes,memberships,memberships.section,memberships.section.name,memberships.section.gid",
    limit: 100,
  });
  return tasks.filter((t) => !t.completed);
}

function getBoardStatus(task) {
  if (!task.memberships || !task.memberships.length) return "Backlog";
  const m = task.memberships.find((m) => m.section && BOARD_SECTIONS[m.section.gid]);
  return m ? BOARD_SECTIONS[m.section.gid] : "Backlog";
}

function getScope(task) {
  const f = (task.custom_fields || []).find((f) => f.gid === "1213815702340197");
  return f?.text_value || "General";
}

function getProgress(task) {
  const f = (task.custom_fields || []).find((f) => f.gid === "1213802028079850");
  const val = f?.text_value;
  if (!val) return null;
  const lines = val.split("\n").filter(l =>
    l.trim() && !l.includes("PROGRESS LOG") && !l.includes("[YYYY") && l.length > 5
  );
  const last = lines.reverse().find(l => l.length > 5);
  return last ? last.trim().slice(0, 120) : null;
}

function getOwner(task) {
  if (!task.assignee) return "⚠ Unassigned";
  return OWNERS[task.assignee.gid]?.name || task.assignee.name || "Unknown";
}

// ─────────────────────────────────────────────
// SLACK HELPERS
// ─────────────────────────────────────────────
async function slackPost(channel, text, thread_ts = null) {
  const body = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  const res = await axios.post("https://slack.com/api/chat.postMessage", body, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
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
// BUILD MESSAGE 1 — EXEC SUMMARY (channel)
// Clean, compact overview only
// ─────────────────────────────────────────────
function buildExecSummary(tasks, prevStatus, now) {
  const byCategory = {};
  let totalMoved = 0, unassigned = 0;

  for (const task of tasks) {
    const cat    = getScope(task);
    const status = getBoardStatus(task);
    const prev   = prevStatus[task.gid];
    const moved  = prev && prev !== status;
    if (moved) totalMoved++;
    if (!task.assignee) unassigned++;
    if (!byCategory[cat]) byCategory[cat] = { tasks: [], moved: 0, statuses: {} };
    byCategory[cat].tasks.push(task);
    byCategory[cat].statuses[status] = (byCategory[cat].statuses[status] || 0) + 1;
    if (moved) byCategory[cat].moved++;
  }

  const lines = [
    `📊 *Portal Stabilisation — ${now}*`,
    `_Auto-generated every 2hrs · Mon–Fri 8am–6pm_`,
    ``,
    `*${tasks.length} open tasks · ${totalMoved} moved this period · ${unassigned} unassigned*`,
    ``,
    `*Category overview:*`,
  ];

  for (const [cat, data] of Object.entries(byCategory)) {
    const statusStr = Object.entries(data.statuses)
      .map(([s, n]) => `${STATUS_EMOJI[s]}${s}:${n}`)
      .join(" · ");
    const movedNote = data.moved > 0 ? ` *(${data.moved} moved)*` : "";
    lines.push(`• *${cat}* (${data.tasks.length})${movedNote} — ${statusStr}`);
  }

  if (unassigned > 0) {
    const unassignedNames = tasks
      .filter(t => !t.assignee)
      .map(t => t.name)
      .join(" · ");
    lines.push(``, `⚠️ *Unassigned:* ${unassignedNames}`);
  }

  lines.push(
    ``,
    `_Full details in thread ↓_`,
    `📈 *Latest Progress Update* · 📋 *Full Report*`
  );

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// BUILD MESSAGE 2 — LATEST PROGRESS UPDATE (thread reply 1)
// Only tasks with board moves or new progress logs
// ─────────────────────────────────────────────
function buildProgressUpdate(tasks, prevStatus, now) {
  const updated = [];

  for (const task of tasks) {
    const status   = getBoardStatus(task);
    const prev     = prevStatus[task.gid];
    const moved    = prev && prev !== status;
    const progress = getProgress(task);
    if (moved || progress) {
      updated.push({ task, status, prev, moved, progress });
    }
  }

  const lines = [
    `📈 *Latest Progress Update — ${now}*`,
    `_Tasks with board moves or new progress logs since last report_`,
    ``,
  ];

  if (updated.length === 0) {
    lines.push(`_No updates since last report. Owners — please update your Progress Log and move cards on the Board._`);
    return lines.join("\n");
  }

  for (const { task, status, prev, moved, progress } of updated) {
    const emoji       = STATUS_EMOJI[status] || "⬜";
    const statusLine  = moved
      ? `📍 ${prev} → *${status}*`
      : `📍 *${status}* _(no board move)_`;
    const progressLine = progress
      ? `💬 ${progress}`
      : `💬 _No progress text yet_`;

    lines.push(`${emoji} *${task.name}*`);
    lines.push(`   👤 ${getOwner(task)}  |  ${statusLine}`);
    lines.push(`   ${progressLine}`);
    lines.push(`   📎 <${ASANA_TASK_URL(task.gid)}|Open task in Asana>`);
    lines.push(``);
  }

  const silent = tasks.length - updated.length;
  if (silent > 0) {
    lines.push(`_${silent} task${silent > 1 ? "s" : ""} with no updates since last report_`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// BUILD MESSAGE 3 — FULL REPORT (thread reply 2)
// All tasks grouped by category
// ─────────────────────────────────────────────
function buildFullReport(tasks, prevStatus, now) {
  const byCategory = {};
  for (const task of tasks) {
    const cat = getScope(task);
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(task);
  }

  const lines = [
    `📋 *Full Report — all ${tasks.length} tasks · ${now}*`,
    ``,
  ];

  for (const [cat, catTasks] of Object.entries(byCategory)) {
    lines.push(`*━ ${cat.toUpperCase()} (${catTasks.length}) ━*`);

    for (const task of catTasks) {
      const status   = getBoardStatus(task);
      const prev     = prevStatus[task.gid];
      const moved    = prev && prev !== status;
      const emoji    = STATUS_EMOJI[status] || "⬜";
      const change   = moved
        ? `${prev} → *${status}*`
        : `${status} _(nc)_`;
      const progress = getProgress(task) || "_No update_";

      lines.push(`${emoji} *${task.name}*`);
      lines.push(`   👤 ${getOwner(task)}  |  📍 ${change}`);
      lines.push(`   💬 ${progress}`);
      lines.push(`   📎 <${ASANA_TASK_URL(task.gid)}|Open & update in Asana>`);
    }
    lines.push(``);
  }

  lines.push(`_Auto-generated · Next report in 2hrs · Owner reminders sent separately_`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────
// REPORT 1 — 3-message send
// Mon–Fri 8am, 10am, 12pm, 2pm, 4pm, 6pm AEST
// ─────────────────────────────────────────────
async function sendExecutiveSummary() {
  console.log(`[${new Date().toISOString()}] Sending report...`);
  try {
    const tasks = await fetchAllTasks();
    const now   = new Date().toLocaleString("en-AU", {
      timeZone: TZ, weekday: "short", day: "numeric",
      month: "short", hour: "2-digit", minute: "2-digit",
    });

    // Message 1 — exec summary to channel
    const summaryMsg = await slackPost(CHANNEL_ID, buildExecSummary(tasks, previousStatus, now));
    const threadTs   = summaryMsg.ts;

    // Small delay so thread replies arrive in order
    await new Promise(r => setTimeout(r, 800));

    // Message 2 — Latest Progress Update (thread reply 1)
    await slackPost(CHANNEL_ID, buildProgressUpdate(tasks, previousStatus, now), threadTs);

    await new Promise(r => setTimeout(r, 500));

    // Message 3 — Full Report (thread reply 2)
    await slackPost(CHANNEL_ID, buildFullReport(tasks, previousStatus, now), threadTs);

    // Update status snapshot for next cycle
    for (const task of tasks) {
      previousStatus[task.gid] = getBoardStatus(task);
    }

    console.log(`[${new Date().toISOString()}] All 3 messages sent ✓ (channel + 2 thread replies)`);
  } catch (err) {
    console.error("Report error:", err.message);
  }
}

// ─────────────────────────────────────────────
// REPORT 2 — Owner DMs
// Mon–Fri 9:30am, 11:30am, 1:30pm, 3:30pm, 5:30pm AEST
// ─────────────────────────────────────────────
async function sendOwnerReminders() {
  console.log(`[${new Date().toISOString()}] Sending owner reminders...`);
  try {
    const tasks   = await fetchAllTasks();
    const byOwner = {};
    for (const task of tasks) {
      const gid = task.assignee?.gid;
      if (!gid || !OWNERS[gid]) continue;
      if (!byOwner[gid]) byOwner[gid] = [];
      byOwner[gid].push(task);
    }

    const now = new Date().toLocaleString("en-AU", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit",
    });

    for (const [asanaGid, ownerTasks] of Object.entries(byOwner)) {
      const owner = OWNERS[asanaGid];

      const taskLines = ownerTasks.map((t) => {
        const status   = getBoardStatus(t);
        const prev     = previousStatus[t.gid];
        const moved    = prev && prev !== status;
        const progress = getProgress(t);

        const statusLine = moved
          ? `📍 ${prev} → *${status}* _(moved!)_`
          : `📍 *${status}* — please move board card if this has changed`;
        const progressLine = progress
          ? `💬 Last: ${progress}`
          : `💬 _No progress update yet — please add one_`;

        return [
          `${STATUS_EMOJI[status] || "⬜"} *${t.name}*`,
          `   ${statusLine}`,
          `   ${progressLine}`,
          `   📎 <${ASANA_TASK_URL(t.gid)}|Update this task in Asana>`,
        ].join("\n");
      }).join("\n\n");

      const msg = [
        `⏰ *Reminder: Update your task progress within 30 mins*`,
        `_${now} · Portal Stabilisation_`,
        ``,
        `Hi ${owner.name}! You have *${ownerTasks.length} open task${ownerTasks.length > 1 ? "s" : ""}* needing a progress update:`,
        ``,
        taskLines,
        ``,
        `*To update:* Click each task link → add a line to the *Progress Log* field → drag the card to the correct Board column if status has changed.`,
      ].join("\n");

      await slackPost(owner.slack, msg);
      console.log(`[${new Date().toISOString()}] Reminder → ${owner.name} ✓`);
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.error("Owner reminder error:", err.message);
  }
}

// ─────────────────────────────────────────────
// AUTO-TASK CONVERTER — every 15 mins
// Watches Dali & Pete posts → creates Asana tasks
// ─────────────────────────────────────────────
async function autoConvertSlackToTasks() {
  console.log(`[${new Date().toISOString()}] Checking for new posts...`);
  try {
    const messages = await slackGetHistory(CHANNEL_ID, lastProcessedTs);
    if (!messages.length) return;

    const sorted = [...messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    for (const msg of sorted) {
      if (parseFloat(msg.ts) <= parseFloat(lastProcessedTs)) continue;
      lastProcessedTs = msg.ts;

      const watchedUser = WATCH_USERS[msg.user];
      if (!watchedUser) continue;
      const text = (msg.text || "").trim();
      if (text.length < 30 || /^(hi|hello|hey|thanks|ok|yes|no)\b/i.test(text)) continue;

      console.log(`[${new Date().toISOString()}] Evaluating message from ${watchedUser}...`);

      const analysis = await callClaude(
        `Analyze this Slack message from ${watchedUser} and determine if it contains actionable feedback, bugs, or feature requests.

Message: "${text}"

Return ONLY valid JSON:
{
  "is_actionable": true or false,
  "reason": "brief reason",
  "tasks": [
    {
      "name": "Short task name (max 60 chars)",
      "description": "Full description of what needs to be done",
      "category": "Alerts & Intelligence | Voice | Bot Management | Portal UX & Performance | Operations & Targeting | Email | Reporting & Analytics",
      "suggested_assignee": "Pete or Saber or Mahit or Chayan or null"
    }
  ]
}`,
        "You are a project manager. Extract actionable tasks from Slack messages. Return only valid JSON."
      );

      let parsed;
      try {
        parsed = JSON.parse(analysis.replace(/```json\n?|```\n?/g, "").trim());
      } catch {
        console.error("Parse error"); continue;
      }

      if (!parsed.is_actionable || !parsed.tasks?.length) {
        console.log(`Not actionable: ${parsed.reason}`); continue;
      }

      const created = [];
      for (const td of parsed.tasks) {
        const assigneeEntry = Object.entries(OWNERS).find(([, v]) => v.name === td.suggested_assignee);
        const task = await asanaPost("/tasks", {
          name:  td.name,
          notes: [
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `CATEGORY: ${td.category}`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `DESCRIPTION`,
            td.description,
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
          projects:    [PROJECT_GID],
          memberships: [{ project: PROJECT_GID, section: "1213815704002761" }], // Planned
          ...(assigneeEntry && { assignee: assigneeEntry[0] }),
        });
        created.push(task);
        console.log(`[${new Date().toISOString()}] Created: "${td.name}" ✓`);
      }

      if (created.length) {
        await slackPost(
          CHANNEL_ID,
          `✅ *${created.length} task${created.length > 1 ? "s" : ""} auto-created from ${watchedUser}'s feedback:*\n` +
          created.map(t => `• <${ASANA_TASK_URL(t.gid)}|${t.name}>`).join("\n") +
          `\n_Added to "Planned" on the Board_`
        );
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) {
    console.error("Auto-convert error:", err.message);
  }
}

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────
async function startupCheck() {
  console.log("─────────────────────────────────────────────────");
  console.log("  Portal Stabilisation Automation v3");
  console.log("─────────────────────────────────────────────────");
  console.log(`  Board: Backlog → Prioritised → Planned → In Progress → Testing → Done`);
  console.log(`  Channel structure: Exec summary on channel · 2 thread replies`);
  console.log("");

  try {
    const tasks = await fetchAllTasks();
    for (const task of tasks) previousStatus[task.gid] = getBoardStatus(task);
    console.log(`  ✓ Asana connected — ${tasks.length} tasks found, board status seeded`);
  } catch (e) {
    console.error("  ✗ Asana failed:", e.message); process.exit(1);
  }

  try {
    await axios.get("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    console.log("  ✓ Slack connected");
  } catch (e) {
    console.error("  ✗ Slack failed:", e.message); process.exit(1);
  }

  console.log("  ✓ All systems go\n");

  await slackPost(
    CHANNEL_ID,
    `🤖 *Portal Stabilisation Automation v3 — Live*\n` +
    `_Channel: Exec summary only · Thread: Latest Progress Update + Full Report_\n` +
    `_Reports every 2hrs Mon–Fri 8am–6pm · Owner DMs 9:30am–5:30pm · Auto-task conversion active_`
  );
}

// ─────────────────────────────────────────────
// SCHEDULES & MAIN
// ─────────────────────────────────────────────
(async () => {
  await startupCheck();

  // Report: Mon–Fri 8am, 10am, 12pm, 2pm, 4pm, 6pm
  cron.schedule("0 8,10,12,14,16,18 * * 1-5", sendExecutiveSummary, { timezone: TZ });
  console.log("📊 Report scheduled: Mon–Fri 8am–6pm every 2hrs");

  // Owner reminders: Mon–Fri 9:30am, 11:30am, 1:30pm, 3:30pm, 5:30pm
  cron.schedule("30 9,11,13,15,17 * * 1-5", sendOwnerReminders, { timezone: TZ });
  console.log("⏰ Reminders scheduled: Mon–Fri 9:30am–5:30pm every 2hrs");

  // Auto-converter: every 15 mins
  cron.schedule("*/15 * * * *", autoConvertSlackToTasks);
  console.log("🔄 Auto-converter: every 15 mins\n");

  console.log("✅ All schedulers running.\n");
})();
