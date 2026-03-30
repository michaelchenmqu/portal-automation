require("dotenv").config();
const cron  = require("node-cron");
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

const BOARD_SECTIONS = {
  "1213802028079817": "Backlog",
  "1213802028079820": "Prioritised",
  "1213815704002761": "Planned",
  "1213863123247950": "In Progress",
  "1213863123247951": "Testing",
  "1213863123247952": "Done",
};
const DONE_SECTION_GID       = "1213863123247952";
const DEPLOYMENT_STATUS_GID  = "1213815710185880"; // Deployment enum option
const COMPLETED_STATUS_GID   = "1213802028079846"; // Completed enum option

const STATUS_EMOJI = {
  "Backlog": "⬜", "Prioritised": "🔷", "Planned": "🔵",
  "In Progress": "🟡", "Testing": "🟠", "Done": "🟢",
};

// Priority display (emoji + label for thread reports, plain label for exec summary)
const PRIORITY_EMOJI = { "High": "🔴", "Medium": "🟠", "Low": "🟡" };
const PRIORITY_SORT  = { "High": 0, "Medium": 1, "Low": 2, "—": 3 };

// Slack mrkdwn colour using bold for priority / status labels
// (Block Kit doesn't support inline colour — we use bold text only)
// Status colour legend used in exec summary Due Today list:
// Priority:  High = bold only (readers know red = high from label)
// Status: communicated via text label, no colour coding in mrkdwn

const OWNERS = {
  "1213776006274031": { name: "Pete",      slack: "U06MSUARQ77" },
  "1213778917763529": { name: "Saber",     slack: "U09FT29J3LH" },
  "1210457965895022": { name: "Mahit",     slack: "U07UXL3FX37" },
  "1213779385519783": { name: "Chayan",    slack: "U06S0T3UFFB" },
};

const WATCH_USERS = { "U06LB8LJ50R": "Dali", "U06MSUARQ77": "Pete" };

let previousStatus  = {};
let lastProcessedTs = (Date.now() / 1000 - 3600).toString();

// ─────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────
function todayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}

function dueDateStatus(dueOn) {
  if (!dueOn) return null;
  const today    = todayStr();
  const tomorrow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  if (dueOn < today)         return { type: "overdue",   label: `was due ${dueOn}` };
  if (dueOn === today)       return { type: "today",     label: "Due Today" };
  if (dueOn === tomorrowStr) return { type: "tomorrow",  label: "Due tomorrow" };
  return                            { type: "future",    label: `Due ${dueOn}` };
}

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
    opt_fields: "gid,name,completed,assignee,assignee.name,custom_fields,notes,due_on,memberships,memberships.section,memberships.section.name,memberships.section.gid",
    limit: 100,
  });
  return tasks; // include completed — we need them for closed count
}

function getBoardStatus(task) {
  if (!task.memberships?.length) return "Backlog";
  const m = task.memberships.find((m) => m.section && BOARD_SECTIONS[m.section.gid]);
  return m ? BOARD_SECTIONS[m.section.gid] : "Backlog";
}

function getBoardSectionGid(task) {
  if (!task.memberships?.length) return null;
  const m = task.memberships.find((m) => m.section && BOARD_SECTIONS[m.section.gid]);
  return m ? m.section.gid : null;
}

function getStatusFieldGid(task) {
  const f = (task.custom_fields || []).find((f) => f.gid === "1213802028079845");
  return f?.enum_value?.gid || null;
}

// Closed = Done section OR status field = Deployment OR Completed
function isClosed(task) {
  const sectionGid = getBoardSectionGid(task);
  const statusGid  = getStatusFieldGid(task);
  return (
    sectionGid === DONE_SECTION_GID ||
    statusGid  === DEPLOYMENT_STATUS_GID ||
    statusGid  === COMPLETED_STATUS_GID
  );
}

function getScope(task) {
  const f = (task.custom_fields || []).find((f) => f.gid === "1213815702340197");
  return f?.text_value || "General";
}

function getPriority(task) {
  const f = (task.custom_fields || []).find((f) => f.gid === "1135564385376580");
  return f?.display_value || f?.enum_value?.name || "—";
}

function getPriorityDisplay(task) {
  const p = getPriority(task);
  return `${PRIORITY_EMOJI[p] || "⚪"} ${p}`;
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
async function slackPost(channel, text, blocks = null, thread_ts = null) {
  const body = { channel, text };
  if (blocks)    body.blocks    = blocks;
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

// Block Kit builders
function bkHeader(text)    { return { type: "header", text: { type: "plain_text", text, emoji: true } }; }
function bkSection(mrkdwn) { return { type: "section", text: { type: "mrkdwn", text: mrkdwn } }; }
function bkFields(fields)  { return { type: "section", fields: fields.map(f => ({ type: "mrkdwn", text: f })) }; }
function bkDivider()       { return { type: "divider" }; }
function bkContext(mrkdwn) { return { type: "context", elements: [{ type: "mrkdwn", text: mrkdwn }] }; }

// ─────────────────────────────────────────────
// ANTHROPIC
// ─────────────────────────────────────────────
async function callClaude(prompt, system = "") {
  const body = { model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] };
  if (system) body.system = system;
  const res = await axios.post("https://api.anthropic.com/v1/messages", body, {
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
  });
  return res.data.content[0].text;
}

// ─────────────────────────────────────────────
// DUE TODAY / OVERDUE ROW FORMAT
// Priority (colour label) · Task name · Owner · Status
// No emoji on owner or status fields
// ─────────────────────────────────────────────
function formatDueRow(task, includeWasDue = false) {
  const priority = getPriority(task);
  const status   = getBoardStatus(task);
  const owner    = getOwner(task);
  // Priority label styled with bold
  const pLabel   = `*${priority}*`;
  const dueStr   = includeWasDue && task.due_on ? `  _was due ${task.due_on}_` : "";
  return `• ${pLabel}   ${task.name} · ${owner} · ${status}${dueStr}`;
}

// ─────────────────────────────────────────────
// MESSAGE 1 — EXEC SUMMARY (channel, Block Kit)
// ─────────────────────────────────────────────
function buildExecSummaryBlocks(allTasks, prevStatus, now) {
  const openTasks    = allTasks.filter(t => !isClosed(t) && !t.completed);
  const closedTasks  = allTasks.filter(t => isClosed(t));
  const totalTasks   = allTasks.filter(t => !t.completed); // excludes Asana-completed

  let statusChanged = 0, highCount = 0;
  const dueTodayList = [], overdueList = [];
  const today = todayStr();

  // Category breakdown (open tasks only)
  const byCategory = {};
  for (const task of openTasks) {
    const cat    = getScope(task);
    const status = getBoardStatus(task);
    const prev   = prevStatus[task.gid];
    if (prev && prev !== status) statusChanged++;
    if (getPriority(task) === "High") highCount++;
    if (!byCategory[cat]) byCategory[cat] = {};
    byCategory[cat][status] = (byCategory[cat][status] || 0) + 1;

    if (task.due_on) {
      if (task.due_on < today) overdueList.push(task);
      else if (task.due_on === today) dueTodayList.push(task);
    }
  }

  const blocks = [];
  blocks.push(bkHeader(`📊 Portal Stabilisation — ${now}`));
  blocks.push(bkContext(`_Auto-generated every 2hrs · Mon–Fri 8am–6pm_`));
  blocks.push(bkDivider());

  // ── 6 stat tiles ──
  blocks.push(bkFields([
    `*Total Tasks*\n${totalTasks.length}`,
    `*Open Tasks*\n${openTasks.length}`,
    `*Closed Tasks*\n${closedTasks.length}`,
    `*High Priority*\n${highCount}`,
    `*Due Today*\n${dueTodayList.length > 0 ? dueTodayList.length : "—"}`,
    `*Status Changed*\n${statusChanged > 0 ? statusChanged : "—"}`,
  ]));
  blocks.push(bkDivider());

  // ── Due Today ──
  if (dueTodayList.length > 0) {
    const rows = dueTodayList.map(t => formatDueRow(t)).join("\n");
    blocks.push(bkSection(`*🚨 Due Today (${dueTodayList.length}):*\n${rows}`));
    blocks.push(bkDivider());
  }

  // ── Overdue — only rendered if tasks genuinely overdue (live data only) ──
  if (overdueList.length > 0) {
    const rows = overdueList.map(t => formatDueRow(t, true)).join("\n");
    blocks.push(bkSection(`*🔴 Overdue (${overdueList.length}):*\n${rows}`));
    blocks.push(bkDivider());
  }

  // ── Category Overview ──
  blocks.push(bkSection("*🗂 Category Overview:*"));
  const catLines = Object.entries(byCategory).map(([cat, statuses]) => {
    const breakdown = Object.entries(statuses)
      .map(([s, n]) => `${s}:${n}`)
      .join(" · ");
    const total = Object.values(statuses).reduce((a, b) => a + b, 0);
    return `• *${cat}* (${total}) — ${breakdown}`;
  }).join("\n");
  blocks.push(bkSection(catLines));
  blocks.push(bkDivider());

  // ── Thread links ──
  blocks.push(bkSection("_Full details in thread below ↓_\n*📈 Latest Progress Update  ·  📋 Full Report*"));

  const fallback = `📊 Portal Stabilisation — ${now} | Total:${totalTasks.length} Open:${openTasks.length} Closed:${closedTasks.length} High:${highCount}${dueTodayList.length > 0 ? ` 🚨 Due Today:${dueTodayList.length}` : ""}${overdueList.length > 0 ? ` 🔴 Overdue:${overdueList.length}` : ""}`;
  return { blocks, fallback };
}

// ─────────────────────────────────────────────
// MESSAGE 2 — LATEST PROGRESS UPDATE (thread reply 1)
// ─────────────────────────────────────────────
function buildProgressUpdateBlocks(tasks, prevStatus, now) {
  const openTasks = tasks.filter(t => !isClosed(t) && !t.completed);
  const updated = [];

  for (const task of openTasks) {
    const status   = getBoardStatus(task);
    const prev     = prevStatus[task.gid];
    const moved    = prev && prev !== status;
    const progress = getProgress(task);
    const ds       = task.due_on ? dueDateStatus(task.due_on) : null;
    if (moved || progress || ds?.type === "overdue" || ds?.type === "today") {
      updated.push({ task, status, prev, moved, progress, ds });
    }
  }

  // Sort by priority
  updated.sort((a, b) =>
    (PRIORITY_SORT[getPriority(a.task)] || 3) - (PRIORITY_SORT[getPriority(b.task)] || 3)
  );

  const blocks = [];
  blocks.push(bkHeader(`📈 Latest Progress Update — ${now}`));
  blocks.push(bkContext(`_Tasks with board moves, new progress logs, or urgent due dates · sorted by priority_`));
  blocks.push(bkDivider());

  if (updated.length === 0) {
    blocks.push(bkSection("_No updates since last report._\n*Owners — please update your Progress Log and move cards on the Board.*"));
    return { blocks, fallback: `📈 Latest Progress Update — No updates since last report.` };
  }

  for (const { task, status, prev, moved, progress, ds } of updated) {
    const emoji    = STATUS_EMOJI[status] || "⬜";
    const priority = getPriorityDisplay(task);
    const statusLine = moved ? `${prev} → *${status}*` : `*${status}* _(no change)_`;
    const progLine   = progress || "_No progress text yet_";
    const dueText    = ds ? `  _${ds.label}_` : "";

    blocks.push(bkSection(
      `${emoji} *${task.name}*\n` +
      `${priority}  |  👤 ${getOwner(task)}  |  📍 ${statusLine}${dueText}\n` +
      `💬 ${progLine}\n` +
      `📎 <${ASANA_TASK_URL(task.gid)}|Open task in Asana>`
    ));
    blocks.push(bkDivider());
  }

  const silent = openTasks.length - updated.length;
  if (silent > 0) blocks.push(bkContext(`_${silent} task${silent > 1 ? "s" : ""} with no new updates_`));

  return { blocks, fallback: `📈 Latest Progress Update — ${updated.length} task${updated.length > 1 ? "s" : ""} updated.` };
}

// ─────────────────────────────────────────────
// MESSAGE 3 — FULL REPORT (thread reply 2)
// ─────────────────────────────────────────────
function buildFullReportBlocks(tasks, prevStatus, now) {
  const openTasks = tasks.filter(t => !isClosed(t) && !t.completed);
  const byCategory = {};
  for (const task of openTasks) {
    const cat = getScope(task);
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(task);
  }

  // Sort within each category by priority
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].sort((a, b) =>
      (PRIORITY_SORT[getPriority(a)] || 3) - (PRIORITY_SORT[getPriority(b)] || 3)
    );
  }

  const blocks = [];
  blocks.push(bkHeader(`📋 Full Report — ${openTasks.length} open tasks · ${now}`));
  blocks.push(bkContext(`_Sorted by priority within each category · High → Medium → Low_`));
  blocks.push(bkDivider());

  for (const [cat, catTasks] of Object.entries(byCategory)) {
    blocks.push(bkSection(`*━ ${cat.toUpperCase()} (${catTasks.length}) ━*`));
    for (const task of catTasks) {
      const status   = getBoardStatus(task);
      const prev     = prevStatus[task.gid];
      const moved    = prev && prev !== status;
      const emoji    = STATUS_EMOJI[status] || "⬜";
      const priority = getPriorityDisplay(task);
      const change   = moved ? `${prev} → *${status}*` : `${status} _(nc)_`;
      const progress = getProgress(task) || "_No update_";
      const ds       = task.due_on ? dueDateStatus(task.due_on) : null;
      const dueStr   = ds
        ? (ds.type === "overdue" ? `  _🔴 ${ds.label}_` : ds.type === "today" ? `  _🚨 Due Today_` : `  _📅 ${ds.label}_`)
        : `  _📅 No due date_`;

      blocks.push(bkSection(
        `${emoji} *${task.name}*${dueStr}\n` +
        `${priority}  |  👤 ${getOwner(task)}  |  📍 ${change}\n` +
        `💬 ${progress}\n` +
        `📎 <${ASANA_TASK_URL(task.gid)}|Open & update in Asana>`
      ));
    }
    blocks.push(bkDivider());
  }

  blocks.push(bkContext(`_Auto-generated · Next report in 2hrs · Owner reminders sent separately_`));
  return {
    blocks,
    fallback: `📋 Full Report — ${openTasks.length} open tasks across ${Object.keys(byCategory).length} categories.`,
  };
}

// ─────────────────────────────────────────────
// REPORT — sends all 3 messages
// Mon–Fri 8am, 10am, 12pm, 2pm, 4pm, 6pm AEST
// ─────────────────────────────────────────────
async function sendExecutiveSummary() {
  console.log(`[${new Date().toISOString()}] Sending report...`);
  try {
    const allTasks = await fetchAllTasks();
    const now = new Date().toLocaleString("en-AU", {
      timeZone: TZ, weekday: "short", day: "numeric",
      month: "short", hour: "2-digit", minute: "2-digit",
    });

    // Message 1 — exec summary to channel
    const { blocks: b1, fallback: f1 } = buildExecSummaryBlocks(allTasks, previousStatus, now);
    const summaryMsg = await slackPost(CHANNEL_ID, f1, b1);
    const threadTs   = summaryMsg.ts;

    await new Promise(r => setTimeout(r, 800));

    // Message 2 — Latest Progress Update (thread reply 1)
    const { blocks: b2, fallback: f2 } = buildProgressUpdateBlocks(allTasks, previousStatus, now);
    await slackPost(CHANNEL_ID, f2, b2, threadTs);

    await new Promise(r => setTimeout(r, 500));

    // Message 3 — Full Report (thread reply 2)
    const { blocks: b3, fallback: f3 } = buildFullReportBlocks(allTasks, previousStatus, now);
    await slackPost(CHANNEL_ID, f3, b3, threadTs);

    // Update snapshot (open non-closed tasks only)
    for (const task of allTasks) {
      if (!isClosed(task) && !task.completed) {
        previousStatus[task.gid] = getBoardStatus(task);
      }
    }

    console.log(`[${new Date().toISOString()}] All 3 messages sent ✓`);
  } catch (err) {
    console.error("Report error:", err.message);
  }
}

// ─────────────────────────────────────────────
// OWNER DMs — priority + due date highlighting
// Mon–Fri 9:30am, 11:30am, 1:30pm, 3:30pm, 5:30pm AEST
// ─────────────────────────────────────────────
async function sendOwnerReminders() {
  console.log(`[${new Date().toISOString()}] Sending owner reminders...`);
  try {
    const allTasks = await fetchAllTasks();
    const openTasks = allTasks.filter(t => !isClosed(t) && !t.completed);
    const byOwner   = {};
    for (const task of openTasks) {
      const gid = task.assignee?.gid;
      if (!gid || !OWNERS[gid]) continue;
      if (!byOwner[gid]) byOwner[gid] = [];
      byOwner[gid].push(task);
    }

    const now = new Date().toLocaleString("en-AU", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit",
    });
    const today = todayStr();

    for (const [asanaGid, ownerTasks] of Object.entries(byOwner)) {
      const owner = OWNERS[asanaGid];

      // Sort: overdue → due today → high priority → medium → low
      const sorted = [...ownerTasks].sort((a, b) => {
        const aScore = a.due_on && a.due_on <= today ? 0 : (PRIORITY_SORT[getPriority(a)] || 3) + 1;
        const bScore = b.due_on && b.due_on <= today ? 0 : (PRIORITY_SORT[getPriority(b)] || 3) + 1;
        return aScore - bScore;
      });

      const blocks = [];
      blocks.push(bkHeader(`⏰ Reminder: Update your progress within 30 mins`));
      blocks.push(bkContext(`_${now} · Portal Stabilisation_`));
      blocks.push(bkSection(`Hi ${owner.name}! You have *${sorted.length} open task${sorted.length > 1 ? "s" : ""}* needing a progress update:`));
      blocks.push(bkDivider());

      // Urgent block — overdue or due today
      const urgent = sorted.filter(t => t.due_on && t.due_on <= today);
      if (urgent.length > 0) {
        const urgentLines = urgent.map(t => {
          const ds = dueDateStatus(t.due_on);
          const label = ds?.type === "overdue" ? `🔴 ${ds.label}` : "🚨 Due Today";
          return `${label}  *${getPriority(t)}*  *${t.name}*\n  📎 <${ASANA_TASK_URL(t.gid)}|Update now>`;
        }).join("\n\n");
        blocks.push(bkSection(`*Urgent — Due Today or Overdue:*\n${urgentLines}`));
        blocks.push(bkDivider());
      }

      // All tasks
      for (const task of sorted) {
        const status   = getBoardStatus(task);
        const prev     = previousStatus[task.gid];
        const moved    = prev && prev !== status;
        const progress = getProgress(task);
        const ds       = task.due_on ? dueDateStatus(task.due_on) : null;
        const priority = getPriorityDisplay(task);

        const statusLine = moved
          ? `📍 ${prev} → *${status}* _(moved!)_`
          : `📍 *${status}* — move card if this has changed`;
        const progLine = progress
          ? `💬 Last: ${progress}`
          : `💬 _No progress update yet — please add one_`;
        const dueText = ds
          ? (ds.type === "overdue" ? `  _🔴 ${ds.label}_` : ds.type === "today" ? `  _🚨 Due Today_` : ds.type === "tomorrow" ? `  _⚠️ Due tomorrow_` : `  _📅 ${ds.label}_`)
          : `  _📅 No due date set_`;

        blocks.push(bkSection(
          `${STATUS_EMOJI[status] || "⬜"} *${task.name}*\n` +
          `${priority}${dueText}\n` +
          `${statusLine}\n` +
          `${progLine}\n` +
          `📎 <${ASANA_TASK_URL(task.gid)}|Update this task in Asana>`
        ));
      }

      blocks.push(bkDivider());
      blocks.push(bkSection("*To update:* Click each task link → add a line to the *Progress Log* field → drag the card to the correct Board column if status has changed."));

      const fallback = `⏰ Reminder: You have ${sorted.length} open task${sorted.length > 1 ? "s" : ""} in Portal Stabilisation. Please update your progress within 30 mins.`;
      await slackPost(owner.slack, fallback, blocks);
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

      const analysis = await callClaude(
        `Analyze this Slack message from ${watchedUser} for actionable tasks.\n\nMessage: "${text}"\n\nReturn ONLY valid JSON:\n{"is_actionable":true/false,"reason":"","tasks":[{"name":"","description":"","category":"Alerts & Intelligence|Voice|Bot Management|Portal UX & Performance|Operations & Targeting|Email|Reporting & Analytics","suggested_assignee":"Pete|Saber|Mahit|Chayan|null","priority":"High|Medium|Low"}]}`,
        "Return only valid JSON."
      );

      let parsed;
      try { parsed = JSON.parse(analysis.replace(/```json\n?|```\n?/g, "").trim()); }
      catch { continue; }
      if (!parsed.is_actionable || !parsed.tasks?.length) continue;

      const PRIORITY_GIDS = { "High": "1135564385376581", "Medium": "1135564385376582", "Low": "1135564385376583" };
      const created = [];

      for (const td of parsed.tasks) {
        const assigneeEntry = Object.entries(OWNERS).find(([, v]) => v.name === td.suggested_assignee);
        const priorityGid   = PRIORITY_GIDS[td.priority];
        const task = await asanaPost("/tasks", {
          name:  td.name,
          notes: `━━━━━━━━━━━━━━━━━━━━━━\nCATEGORY: ${td.category}\n━━━━━━━━━━━━━━━━━━━━━━\n\nDESCRIPTION\n${td.description}\n\nSOURCE: ${watchedUser} in #portal-product-feedback\n\n━━━━━━━━━━━━━━━━━━━━━━\nSOLUTION\n[Owner to complete]\n\n━━━━━━━━━━━━━━━━━━━━━━\nPROGRESS LOG (update every 2 hrs)\n[YYYY-MM-DD HH:MM] — [Update here]`,
          projects:      [PROJECT_GID],
          memberships:   [{ project: PROJECT_GID, section: "1213815704002761" }],
          custom_fields: priorityGid ? { "1135564385376580": priorityGid } : {},
          ...(assigneeEntry && { assignee: assigneeEntry[0] }),
        });
        created.push(task);
        console.log(`Created: "${td.name}" (${td.priority}) ✓`);
      }

      if (created.length) {
        await slackPost(
          CHANNEL_ID,
          `✅ ${created.length} task${created.length > 1 ? "s" : ""} auto-created from ${watchedUser}'s feedback.`,
          [bkSection(
            `✅ *${created.length} task${created.length > 1 ? "s" : ""} auto-created from ${watchedUser}'s feedback:*\n` +
            created.map(t => `• <${ASANA_TASK_URL(t.gid)}|${t.name}>`).join("\n") +
            `\n_Added to "Planned" on the Board_`
          )]
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
  console.log("  Portal Stabilisation Automation v6");
  console.log("  Closed = Done | Deployment | Completed");
  console.log("  Exec summary: 6 tiles · Due Today · Overdue (live) · Category Overview");
  console.log("─────────────────────────────────────────────────");

  try {
    const allTasks   = await fetchAllTasks();
    const openTasks  = allTasks.filter(t => !isClosed(t) && !t.completed);
    const closed     = allTasks.filter(t => isClosed(t));
    for (const task of openTasks) previousStatus[task.gid] = getBoardStatus(task);
    console.log(`  ✓ Asana — ${allTasks.length} total, ${openTasks.length} open, ${closed.length} closed — board seeded`);
  } catch (e) { console.error("  ✗ Asana:", e.message); process.exit(1); }

  try {
    await axios.get("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
    console.log("  ✓ Slack connected");
  } catch (e) { console.error("  ✗ Slack:", e.message); process.exit(1); }

  console.log("  ✓ All systems go\n");

  await slackPost(CHANNEL_ID,
    "Portal Stabilisation Automation v6 is live.",
    [
      bkHeader("🤖 Portal Stabilisation Automation v6 — Live"),
      bkSection("*Exec summary: 6 tiles · Due Today & Overdue (live only) · 🗂 Category Overview*\n*Closed = Done section OR Deployment/Completed status*"),
      bkFields([
        "*Reports*\nEvery 2hrs · Mon–Fri 8am–6pm",
        "*Owner DMs*\nEvery 2hrs · 9:30am–5:30pm",
        "*Auto-convert*\nEvery 15 mins",
        "*Channel*\nExec only · Thread: progress + full report",
      ]),
    ]
  );
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
(async () => {
  await startupCheck();
  cron.schedule("0 8,10,12,14,16,18 * * 1-5", sendExecutiveSummary, { timezone: TZ });
  cron.schedule("30 9,11,13,15,17 * * 1-5",   sendOwnerReminders,   { timezone: TZ });
  cron.schedule("*/15 * * * *",                autoConvertSlackToTasks);
  console.log("✅ All schedulers running.\n");
})();
