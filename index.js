require("dotenv").config();
const cron  = require("node-cron");
const axios = require("axios");

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const { ANTHROPIC_API_KEY, ASANA_ACCESS_TOKEN, SLACK_BOT_TOKEN, ASANA_PROJECT_GID, TIMEZONE } = process.env;

const TZ         = TIMEZONE || "Australia/Sydney";
const ASANA_BASE = "https://app.asana.com/api/1.0";
const TASK_URL   = (gid) => `https://app.asana.com/0/0/${gid}/f`;

// All reports go to #project-update
const REPORT_CHANNEL = "C0APBB3TAM7";

// ─────────────────────────────────────────────
// PROJECT REGISTRY
// type: delivery | onboarding | register | initiative | compliance
// sectionStyle: board | date | milestone | fixed | first
// ─────────────────────────────────────────────
const PORTAL_GID = ASANA_PROJECT_GID || "1213802028079816";

const PROJECTS = [
  {
    gid: PORTAL_GID,
    name: "Portal Stabilisation",
    type: "delivery",
    emoji: "🔴",
    sectionStyle: "board",
    autoTaskSectionGid: "1213815704002761", // Planned
    boardSections: {
      "1213802028079817": "Backlog",
      "1213802028079820": "Triaged",
      "1213815704002761": "Planned",
      "1213873742595641": "Blocked",
      "1213863123247950": "In Progress",
      "1213863123247951": "Testing",
      "1213863123247952": "Done",
    },
    doneSectionGid:      "1213863123247952",
    deploymentStatusGid: "1213815710185880",
    completedStatusGid:  "1213802028079846",
    customFields: {
      status:   "1213802028079845",
      progress: "1213802028079850",
      priority: "1135564385376580",
      scope:    "1213815702340197",
    },
  },
  {
    gid: "1213895485856243",
    name: "SCB Onboarding",
    type: "onboarding",
    emoji: "🏦",
    sectionStyle: "first",
    goLive: "2026-05-08",
  },
  {
    gid: "1213903393364385",
    name: "Incident Register",
    type: "register",
    emoji: "🚨",
    sectionStyle: "date",
  },
  {
    gid: "1213903393364395",
    name: "McAfee",
    type: "initiative",
    emoji: "🟡",
    sectionStyle: "date",
  },
  {
    gid: "1213775995515822",
    name: "ISO27001 Certification",
    type: "compliance",
    emoji: "🔒",
    sectionStyle: "first",
    noAutoTask: true,
  },
];

// ─────────────────────────────────────────────
// CHANNEL → PROJECT MAP (auto-task creation)
// ─────────────────────────────────────────────
const CHANNEL_MAP = {
  "C0AC8P92G3B": { projectGid: PORTAL_GID,          sectionStyle: "fixed", sectionGid: "1213815704002761", label: "Portal Stabilisation" },
  "C0ANQS6UQ2K": { projectGid: "1213895485856243",  sectionStyle: "first",                                label: "SCB Onboarding" },
  "C09J9HQ3TGS": { projectGid: "1213903393364385",  sectionStyle: "date",                                label: "Incident Register" },
  "C0AL9935U5D": { projectGid: "1213903393364385",  sectionStyle: "date",                                label: "Incident Register" },
  "C0AQ37BKWP8": { projectGid: "1213903393364395",  sectionStyle: "date",                                label: "McAfee" },
};

// Channels watched for auto-task creation
const WATCHED_CHANNELS = Object.keys(CHANNEL_MAP);

// ─────────────────────────────────────────────
// OWNERS (all team members — add Slack IDs as known)
// ─────────────────────────────────────────────
const OWNERS = {
  "1209967224903860": { name: "Michael",    slack: "U0ALJV2MSGK" },
  "1213776006274031": { name: "Pete",       slack: "U06MSUARQ77" },
  "1213778917763529": { name: "Saber",      slack: "U09FT29J3LH" },
  "1210457965895022": { name: "Mahit",      slack: "U07UXL3FX37" },
  "1213779385519783": { name: "Chayan",     slack: "U06S0T3UFFB" },
  "1213816590664365": { name: "Adam",       slack: null },
  "1213816539044303": { name: "Ean",        slack: null },
  "1213863129375544": { name: "Hanif",      slack: null },
  "1213861294078291": { name: "Rajat",      slack: null },
  "1213860897948766": { name: "Krishakant", slack: null },
  "1210065723415017": { name: "Dali",       slack: "U06LB8LJ50R" },
};

const WATCH_USERS = { "U06LB8LJ50R": "Dali", "U06MSUARQ77": "Pete" };
const PRIORITY_SORT = { "High": 0, "Medium": 1, "Low": 2, "—": 3 };

const STATUS_EMOJI = {
  "Backlog": "⬜", "Triaged": "🔷", "Planned": "🔵", "Blocked": "🚫",
  "In Progress": "🟡", "Testing": "🟠", "Done": "🟢",
};

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let previousStatus  = {};   // { portalTaskGid: boardStatusName }
let previousStats   = null; // portal tile snapshot for trend arrows
let eodClosedToday  = new Set();
let lastProcessedTs = {};   // { channelId: ts } — per-channel auto-task watermark
WATCHED_CHANNELS.forEach(ch => { lastProcessedTs[ch] = (Date.now() / 1000 - 3600).toString(); });
let lastReportCheckTs = (Date.now() / 1000 - 300).toString(); // /report command watermark

// ─────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────
function todayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

function todayLabel() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const day = String(d.getDate()).padStart(2, "0");
  const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
  return `${day} ${mon}`; // e.g. "03 APR"
}

function dueDateStatus(dueOn) {
  if (!dueOn) return null;
  const today = todayStr();
  const tom = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  tom.setDate(tom.getDate() + 1);
  const tomStr = tom.toISOString().slice(0, 10);
  if (dueOn < today)    return { type: "overdue",  label: `was due ${dueOn}` };
  if (dueOn === today)  return { type: "today",    label: "Due Today" };
  if (dueOn === tomStr) return { type: "tomorrow", label: "Due tomorrow" };
  return                       { type: "future",   label: `Due ${dueOn}` };
}

function daysUntil(dateStr) {
  const now    = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const target = new Date(dateStr + "T00:00:00");
  return Math.ceil((target - now) / (86400000));
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

const TASK_FIELDS = "gid,name,completed,completed_at,assignee,assignee.name,assignee.gid,custom_fields,due_on,memberships,memberships.section,memberships.section.name,memberships.section.gid,num_subtasks";

async function fetchProjectTasks(projectGid) {
  return asanaGet(`/projects/${projectGid}/tasks`, {
    opt_fields: TASK_FIELDS, limit: 100,
  });
}

async function fetchSubtasksForTask(taskGid) {
  try {
    return await asanaGet(`/tasks/${taskGid}/subtasks`, {
      opt_fields: "gid,name,completed,assignee,assignee.name,assignee.gid,due_on,custom_fields",
      limit: 50,
    });
  } catch { return []; }
}

async function fetchProjectSections(projectGid) {
  return asanaGet(`/projects/${projectGid}/sections`, {
    opt_fields: "gid,name", limit: 100,
  });
}

async function getOrCreateDateSection(projectGid, label) {
  const sections = await fetchProjectSections(projectGid);
  const existing = sections.find(s => s.name.toUpperCase() === label.toUpperCase());
  if (existing) return existing.gid;
  const created = await asanaPost(`/projects/${projectGid}/sections`, { name: label });
  return created.gid;
}

async function getFirstSection(projectGid) {
  const sections = await fetchProjectSections(projectGid);
  const nonEmpty = sections.find(s => s.name !== "Untitled section");
  return nonEmpty?.gid || sections[0]?.gid || null;
}

// Build subtask map for a list of tasks — only fetches for tasks with num_subtasks > 0
async function buildSubtaskMap(tasks) {
  const map = {}; // taskGid → subtask[]
  const needsFetch = tasks.filter(t => (t.num_subtasks || 0) > 0 && !t.completed);
  for (const task of needsFetch) {
    const subs = await fetchSubtasksForTask(task.gid);
    if (subs.length) map[task.gid] = subs;
    await delay(100);
  }
  return map;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// PORTAL TASK HELPERS
// ─────────────────────────────────────────────
const P = PROJECTS[0]; // Portal Stabilisation project config

function getPortalBoardStatus(task) {
  if (!task.memberships?.length) return "Backlog";
  const m = task.memberships.find(m => m.section && P.boardSections[m.section.gid]);
  return m ? P.boardSections[m.section.gid] : "Backlog";
}

function getPortalSectionGid(task) {
  if (!task.memberships?.length) return null;
  const m = task.memberships.find(m => m.section && P.boardSections[m.section.gid]);
  return m ? m.section.gid : null;
}

function getPortalStatusFieldGid(task) {
  const f = (task.custom_fields || []).find(f => f.gid === P.customFields.status);
  return f?.enum_value?.gid || null;
}

function isPortalClosed(task) {
  const sg = getPortalSectionGid(task);
  const stg = getPortalStatusFieldGid(task);
  return task.completed || sg === P.doneSectionGid || stg === P.deploymentStatusGid || stg === P.completedStatusGid;
}

function getPortalPriority(task) {
  const f = (task.custom_fields || []).find(f => f.gid === P.customFields.priority);
  return f?.display_value || f?.enum_value?.name || "—";
}

function getPortalProgress(task) {
  const f = (task.custom_fields || []).find(f => f.gid === P.customFields.progress);
  const val = f?.text_value;
  if (!val) return null;
  const lines = val.split("\n").filter(l => l.trim() && !l.includes("PROGRESS LOG") && !l.includes("[YYYY") && l.length > 5);
  const last = lines.reverse().find(l => l.length > 5);
  return last ? last.trim().slice(0, 120) : null;
}

function getPortalScope(task) {
  const f = (task.custom_fields || []).find(f => f.gid === P.customFields.scope);
  return f?.text_value || "General";
}

// ─────────────────────────────────────────────
// GENERIC TASK HELPERS
// ─────────────────────────────────────────────
function ownerName(task) {
  if (!task.assignee) return "Unassigned";
  return OWNERS[task.assignee.gid]?.name || task.assignee.name || "Unknown";
}

function ownerSlack(assigneeGid) {
  return assigneeGid ? (OWNERS[assigneeGid]?.slack || null) : null;
}

function genericPriority(task) {
  for (const cf of (task.custom_fields || [])) {
    if (cf.enum_value?.name) return cf.enum_value.name;
  }
  return "—";
}

function isTaskClosed(task) {
  return task.completed;
}

function trendStr(prev, curr, higherIsBetter) {
  if (prev == null) return `${curr}`;
  if (curr === prev) return `${curr}  _↔ no change_`;
  const up   = curr > prev;
  const good = up === higherIsBetter;
  return `${curr}  _${good ? "✅" : "⚠️"} ${up ? "↑" : "↓"} ${prev}→${curr}_`;
}

function sectionLabel(task) {
  if (!task.memberships?.length) return "";
  return task.memberships[0]?.section?.name || "";
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

async function slackGetHistory(channel, oldest, limit = 50) {
  const res = await axios.get("https://slack.com/api/conversations.history", {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    params: { channel, oldest, limit },
  });
  if (!res.data.ok) {
    throw new Error(`conversations.history error [${channel}]: ${res.data.error}`);
  }
  return res.data.messages || [];
}

function bkHeader(text)    { return { type: "header", text: { type: "plain_text", text, emoji: true } }; }
function bkSection(mrkdwn) { return { type: "section", text: { type: "mrkdwn", text: mrkdwn.slice(0, 3000) } }; }
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
// FETCH ALL PROJECT DATA (for portfolio report)
// Returns array of { project, tasks, subtaskMap, open, closed, overdue, dueToday }
// ─────────────────────────────────────────────
async function fetchAllProjectData() {
  const today = todayStr();
  const results = [];
  for (const proj of PROJECTS) {
    try {
      const tasks      = await fetchProjectTasks(proj.gid);
      const subtaskMap = await buildSubtaskMap(tasks);
      const open    = tasks.filter(t => !t.completed);
      const closed  = tasks.filter(t => t.completed);
      const overdue = open.filter(t => t.due_on && t.due_on < today);
      const dueToday = open.filter(t => t.due_on === today);
      results.push({ project: proj, tasks, subtaskMap, open, closed, overdue, dueToday });
    } catch (err) {
      console.error(`Error fetching ${proj.name}:`, err.message);
      results.push({ project: proj, tasks: [], subtaskMap: {}, open: [], closed: [], overdue: [], dueToday: [] });
    }
    await delay(300);
  }
  return results;
}

// ─────────────────────────────────────────────
// PORTFOLIO SUMMARY — channel message (daily 8am)
// ─────────────────────────────────────────────
function buildPortfolioSummary(allData, now) {
  const totalOpen   = allData.reduce((s, d) => s + d.open.length, 0);
  const totalDue    = allData.reduce((s, d) => s + d.dueToday.length, 0);
  const totalOverdue = allData.reduce((s, d) => s + d.overdue.length, 0);

  const blocks = [];
  blocks.push(bkHeader(`📁 Apate AI — Project Portfolio · ${now}`));
  blocks.push(bkContext("_Daily 8am · All active projects · Threads per project below ↓_"));
  blocks.push(bkDivider());

  blocks.push(bkFields([
    `*Active Projects*\n${allData.length}`,
    `*Total Open Tasks*\n${totalOpen}`,
    `*Due Today (all)*\n${totalDue > 0 ? totalDue : "—"}`,
    `*Overdue (all)*\n${totalOverdue > 0 ? totalOverdue : "—"}`,
  ]));
  blocks.push(bkDivider());

  const ragLine = allData.map(({ project: proj, open, overdue, dueToday, tasks }) => {
    const closed = tasks.filter(t => t.completed);
    const hasTopPri = open.some(t => t.name.toLowerCase().includes("top priority") && t.due_on && t.due_on <= todayStr());
    const rag = (overdue.length >= 3 || hasTopPri) ? "🔴"
              : (overdue.length >= 1 || dueToday.length >= 3) ? "🟡"
              : open.length === 0 ? "⚫"
              : "🟢";

    let detail = `${open.length} open · ${closed.length} closed`;
    if (proj.goLive) {
      const days = daysUntil(proj.goLive);
      detail += ` · _Go-live ${proj.goLive} · ${days} days_`;
    } else if (overdue.length > 0) {
      detail += ` · _${overdue.length} overdue ⚠️_`;
    } else if (dueToday.length > 0) {
      detail += ` · _${dueToday.length} due today_`;
    } else {
      detail += " · _On track_";
    }
    return `${rag} *${proj.name}* — ${detail}`;
  }).join("\n");

  blocks.push(bkSection(`*Project status:*\n${ragLine}`));
  blocks.push(bkDivider());

  // Cross-project team load
  const ownerLoad = {};
  for (const { project: proj, open, overdue, subtaskMap } of allData) {
    for (const task of open) {
      const gid = task.assignee?.gid;
      if (!gid || !OWNERS[gid]) continue;
      if (!ownerLoad[gid]) ownerLoad[gid] = { name: OWNERS[gid].name, tasks: 0, projects: new Set(), overdue: 0, dueToday: 0 };
      ownerLoad[gid].tasks++;
      ownerLoad[gid].projects.add(proj.name);
      if (overdue.find(o => o.gid === task.gid)) ownerLoad[gid].overdue++;
      if (task.due_on === todayStr()) ownerLoad[gid].dueToday++;
    }
  }

  const loadLines = Object.entries(ownerLoad)
    .sort((a, b) => b[1].overdue - a[1].overdue)
    .slice(0, 6)
    .map(([, o]) => {
      const status = o.overdue > 0 ? `_${o.overdue} overdue ⚠️_`
                   : o.dueToday > 0 ? `_${o.dueToday} due today_`
                   : "_on track_";
      return `• *${o.name}* — ${o.tasks} tasks across ${o.projects.size} project${o.projects.size > 1 ? "s" : ""} · ${status}`;
    }).join("\n");

  if (loadLines) {
    blocks.push(bkSection(`*Team load today:*\n${loadLines}`));
    blocks.push(bkDivider());
  }

  const threadNames = allData.map(d => d.project.name).join("  ·  ");
  blocks.push(bkContext(`_Threads: ${threadNames}  ·  Owner Workplan_`));
  blocks.push(bkSection(`_Type \`!report\` in this channel for an on-demand private report sent to you_`));

  return {
    blocks,
    fallback: `📁 Apate AI Portfolio · ${now} | ${totalOpen} open tasks · ${totalOverdue} overdue across ${allData.length} projects`,
  };
}

// ─────────────────────────────────────────────
// PROJECT THREAD — one per project
// ─────────────────────────────────────────────
function buildProjectThread(data, now) {
  const { project: proj, tasks, open, closed, overdue, dueToday, subtaskMap } = data;
  const today = todayStr();
  const blocks = [];

  if (proj.type === "delivery") {
    // Portal-style thread
    const portalOpen   = open.filter(t => !isPortalClosed(t));
    const portalClosed = tasks.filter(t => isPortalClosed(t));
    const portalOverdue = portalOpen.filter(t => t.due_on && t.due_on < today);
    const portalDueToday = portalOpen.filter(t => t.due_on === today);
    const portalHigh = portalOpen.filter(t => getPortalPriority(t) === "High");
    const portalCarried = portalOpen.filter(t => t.due_on && t.due_on <= today);
    const topPri = portalOpen.filter(t => t.name.toLowerCase().includes("top priority"));

    blocks.push(bkHeader(`${proj.emoji} ${proj.name} — ${now}`));
    blocks.push(bkContext(`_Delivery project · ${tasks.length} total_`));
    blocks.push(bkDivider());

    blocks.push(bkFields([
      `*Total*\n${tasks.length}`,
      `*Open*\n${portalOpen.length}`,
      `*Closed*\n${portalClosed.length}`,
      `*High Pri*\n${portalHigh.length}`,
      `*Due Today*\n${portalDueToday.length > 0 ? portalDueToday.length : "—"}`,
      `*Carried Over*\n${portalCarried.length > 0 ? portalCarried.length : "—"}`,
    ]));
    blocks.push(bkDivider());

    if (portalDueToday.length > 0) {
      const rows = portalDueToday.map(t =>
        `• *${getPortalPriority(t)}*   <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)} · ${getPortalBoardStatus(t)}`
      ).join("\n");
      blocks.push(bkSection(`*🚨 Due Today (${portalDueToday.length}):*\n${rows}`));
      blocks.push(bkDivider());
    }

    if (portalOverdue.length > 0) {
      const rows = portalOverdue.map(t =>
        `• *${getPortalPriority(t)}*   <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)} · ${getPortalBoardStatus(t)}  _was due ${t.due_on}_`
      ).join("\n");
      blocks.push(bkSection(`*🔴 Overdue (${portalOverdue.length}):*\n${rows}`));
      blocks.push(bkDivider());
    }

    if (topPri.length > 0) {
      const rows = topPri.map(t => {
        const ds = t.due_on ? dueDateStatus(t.due_on) : null;
        const dueLabel = ds ? (ds.type === "overdue" ? `🔴 ${ds.label}` : ds.type === "today" ? "🚨 Due Today" : ds.label) : "No due date";
        const progress = getPortalProgress(t) || "_No update logged_";
        const subs = subtaskMap[t.gid] || [];
        const subLine = subs.length > 0
          ? `📦 ${subs.filter(s => s.completed).length}/${subs.length} subtasks done`
          : "";
        return `🔴 *<${TASK_URL(t.gid)}|${t.name}>*\n   👤 ${ownerName(t)} · ${STATUS_EMOJI[getPortalBoardStatus(t)] || "⬜"} ${getPortalBoardStatus(t)} · ${dueLabel}\n   💬 ${progress}${subLine ? `\n   ${subLine}` : ""}`;
      }).join("\n\n");
      blocks.push(bkSection(`*🔴 Top Priority (${topPri.length}):*\n${rows}`));
      blocks.push(bkDivider());
    }

  } else if (proj.type === "onboarding") {
    // Milestone-style thread
    const days = proj.goLive ? daysUntil(proj.goLive) : null;
    blocks.push(bkHeader(`${proj.emoji} ${proj.name} — ${now}`));
    blocks.push(bkContext(`_Client onboarding · ${days != null ? `Go-live ${proj.goLive} · ${days} days remaining` : ""}_`));
    blocks.push(bkDivider());
    blocks.push(bkFields([
      `*Total Tasks*\n${tasks.length}`,
      `*Open*\n${open.length}`,
      `*Closed*\n${closed.length}`,
      `*Overdue*\n${overdue.length > 0 ? overdue.length : "—"}`,
    ]));
    blocks.push(bkDivider());

    if (overdue.length > 0) {
      const rows = overdue.map(t =>
        `• *${genericPriority(t) || "—"}*   <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)}  _was due ${t.due_on}_`
      ).join("\n");
      blocks.push(bkSection(`*🔴 Overdue (${overdue.length}):*\n${rows}`));
      blocks.push(bkDivider());
    }

    if (dueToday.length > 0) {
      const rows = dueToday.map(t =>
        `• <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)}`
      ).join("\n");
      blocks.push(bkSection(`*🚨 Due Today (${dueToday.length}):*\n${rows}`));
      blocks.push(bkDivider());
    }

  } else {
    // register / initiative / compliance — date-section style
    blocks.push(bkHeader(`${proj.emoji} ${proj.name} — ${now}`));
    blocks.push(bkContext(`_${proj.type} · ${tasks.length} total_`));
    blocks.push(bkDivider());
    blocks.push(bkFields([
      `*Open*\n${open.length}`,
      `*Closed*\n${closed.length}`,
      `*Overdue*\n${overdue.length > 0 ? overdue.length : "—"}`,
      `*Due Today*\n${dueToday.length > 0 ? dueToday.length : "—"}`,
    ]));
    blocks.push(bkDivider());

    // Group open tasks by section (date label)
    const bySection = {};
    for (const task of [...overdue, ...dueToday, ...open.filter(t => !overdue.includes(t) && !dueToday.includes(t))]) {
      const sec = sectionLabel(task) || "Unsectioned";
      if (!bySection[sec]) bySection[sec] = [];
      if (!bySection[sec].find(x => x.gid === task.gid)) bySection[sec].push(task);
    }

    for (const [sec, secTasks] of Object.entries(bySection)) {
      const secLines = secTasks.map(t => {
        const pri = genericPriority(t);
        const od = t.due_on && t.due_on < todayStr() ? `  _was due ${t.due_on}_` : "";
        const newBadge = t.memberships?.[0]?.section?.name === todayLabel() && !od ? " 🆕" : "";
        const unassigned = !t.assignee ? " ⚠ Unassigned" : "";
        return `• *${pri !== "—" ? pri + "  " : ""}*<${TASK_URL(t.gid)}|${t.name}>${newBadge} · ${ownerName(t)}${unassigned}${od}`;
      }).join("\n");
      blocks.push(bkSection(`*${sec}:*\n${secLines}`));
    }

    if (Object.keys(bySection).length > 0) blocks.push(bkDivider());
  }

  blocks.push(bkContext("_Full workplan in Owner Workplan thread (last reply)_"));
  return { blocks, fallback: `${proj.emoji} ${proj.name} — ${open.length} open · ${overdue.length} overdue` };
}

// ─────────────────────────────────────────────
// OWNER WORKPLAN — final thread (cross-project)
// ─────────────────────────────────────────────
function buildOwnerWorkplan(allData, now) {
  const today = todayStr();

  // Aggregate tasks per owner across all projects (tasks + subtasks)
  const byOwner = {}; // ownerGid → { name, slack, items: [{ task, project, isSubtask, parentName }] }

  for (const { project: proj, tasks, subtaskMap } of allData) {
    const open = proj.type === "delivery"
      ? tasks.filter(t => !isPortalClosed(t))
      : tasks.filter(t => !t.completed);

    for (const task of open) {
      const gid = task.assignee?.gid;
      const ownerInfo = gid ? OWNERS[gid] : null;
      if (ownerInfo) {
        if (!byOwner[gid]) byOwner[gid] = { name: ownerInfo.name, slack: ownerInfo.slack, items: [] };
        byOwner[gid].items.push({ task, project: proj, isSubtask: false, parentName: null });
      }

      // Subtasks
      const subs = subtaskMap[task.gid] || [];
      for (const sub of subs.filter(s => !s.completed)) {
        const sgid = sub.assignee?.gid;
        const sownerInfo = sgid ? OWNERS[sgid] : null;
        if (sownerInfo) {
          if (!byOwner[sgid]) byOwner[sgid] = { name: sownerInfo.name, slack: sownerInfo.slack, items: [] };
          byOwner[sgid].items.push({ task: sub, project: proj, isSubtask: true, parentName: task.name });
        }
      }
    }
  }

  const blocks = [];
  blocks.push(bkHeader(`👥 Owner Workplan — All Projects · ${now}`));
  blocks.push(bkContext("_Tasks + subtasks per owner across all 5 projects · sorted by urgency · all names link to Asana_"));
  blocks.push(bkDivider());

  const sorted = Object.entries(byOwner).sort(([, a], [, b]) => {
    const aOverdue = a.items.filter(i => i.task.due_on && i.task.due_on < today).length;
    const bOverdue = b.items.filter(i => i.task.due_on && i.task.due_on < today).length;
    return bOverdue - aOverdue;
  });

  for (const [gid, ownerData] of sorted) {
    const { name, items } = ownerData;
    const totalOverdue = items.filter(i => i.task.due_on && i.task.due_on < today).length;
    const totalDueToday = items.filter(i => i.task.due_on === today).length;
    const statusLabel = totalOverdue > 0 ? `${totalOverdue} overdue ⚠️`
                      : totalDueToday > 0 ? `${totalDueToday} due today`
                      : "on track";

    // Group by project
    const byProj = {};
    for (const item of items) {
      const pname = item.project.name;
      if (!byProj[pname]) byProj[pname] = [];
      byProj[pname].push(item);
    }

    let ownerBlock = `*${name}* — ${items.length} open item${items.length > 1 ? "s" : ""} · _${statusLabel}_\n`;

    for (const [projName, projItems] of Object.entries(byProj)) {
      const proj = PROJECTS.find(p => p.name === projName);
      ownerBlock += `\n_${proj?.emoji || "📁"} ${projName}:_\n`;

      const sortedItems = [...projItems].sort((a, b) => {
        const aUrgent = a.task.due_on && a.task.due_on <= today ? 0 : 1;
        const bUrgent = b.task.due_on && b.task.due_on <= today ? 0 : 1;
        return aUrgent - bUrgent;
      });

      for (const item of sortedItems.slice(0, 5)) {
        const t = item.task;
        const ds = t.due_on ? dueDateStatus(t.due_on) : null;
        const dueStr = ds
          ? (ds.type === "overdue" ? `  _🔴 ${ds.label}_` : ds.type === "today" ? "  _🚨 Due Today_" : `  _📅 ${ds.label}_`)
          : "";
        const prefix = item.isSubtask ? `   ↳ _subtask of ${item.parentName?.slice(0, 40)}_\n     ` : "";
        const priLabel = proj?.type === "delivery" ? getPortalPriority(t) : genericPriority(t);
        const section = item.isSubtask ? "" : ` · ${sectionLabel(t) || getPortalBoardStatus(t)}`;
        ownerBlock += `${prefix}• *${priLabel !== "—" ? priLabel + "  " : ""}*<${TASK_URL(t.gid)}|${t.name}>${section}${dueStr}\n`;
      }

      if (sortedItems.length > 5) {
        ownerBlock += `   _+ ${sortedItems.length - 5} more_\n`;
      }
    }

    blocks.push(bkSection(ownerBlock.trim()));
    blocks.push(bkDivider());
  }

  if (sorted.length === 0) {
    blocks.push(bkSection("_No assigned tasks found across all projects._"));
  }

  blocks.push(bkContext("_Subtasks marked ↳ · ⚠ Unassigned subtasks need owners · click task names to open in Asana_"));
  return { blocks, fallback: `👥 Owner Workplan — ${sorted.length} owners · ${Object.values(byOwner).reduce((s, o) => s + o.items.length, 0)} total items` };
}

// ─────────────────────────────────────────────
// DAILY PORTFOLIO REPORT (8am)
// ─────────────────────────────────────────────
async function sendDailyPortfolioReport() {
  console.log(`[${new Date().toISOString()}] Sending daily portfolio report...`);
  try {
    const now = new Date().toLocaleString("en-AU", {
      timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });

    const allData = await fetchAllProjectData();

    // Channel: portfolio summary
    const { blocks: b0, fallback: f0 } = buildPortfolioSummary(allData, now);
    const summaryMsg = await slackPost(REPORT_CHANNEL, f0, b0);
    const threadTs   = summaryMsg.ts;
    await delay(800);

    // Thread: one per project
    for (const data of allData) {
      const { blocks, fallback } = buildProjectThread(data, now);
      await slackPost(REPORT_CHANNEL, fallback, blocks, threadTs);
      await delay(600);
    }

    // Thread: owner workplan (last)
    const { blocks: bW, fallback: fW } = buildOwnerWorkplan(allData, now);
    await slackPost(REPORT_CHANNEL, fW, bW, threadTs);

    console.log(`[${new Date().toISOString()}] Daily portfolio report sent ✓`);
  } catch (err) {
    console.error("Portfolio report error:", err.message);
  }
}

// ─────────────────────────────────────────────
// PORTAL 2HR EXEC SUMMARY
// All Portal-specific logic, sent to REPORT_CHANNEL
// ─────────────────────────────────────────────
function computePortalStats(allTasks, prevStatus) {
  const today       = todayStr();
  const openTasks   = allTasks.filter(t => !isPortalClosed(t));
  const closedTasks = allTasks.filter(t => isPortalClosed(t));
  let highCount = 0;
  const dueTodayList = [], carriedOverList = [], topPriorityList = [];
  const byCategory = {};

  for (const task of openTasks) {
    const cat    = getPortalScope(task);
    const status = getPortalBoardStatus(task);
    if (getPortalPriority(task) === "High") highCount++;
    if (!byCategory[cat]) byCategory[cat] = {};
    byCategory[cat][status] = (byCategory[cat][status] || 0) + 1;
    if (task.due_on) {
      if (task.due_on === today) dueTodayList.push(task);
      if (task.due_on <= today) carriedOverList.push(task);
    }
    if (task.name.toLowerCase().includes("top priority")) topPriorityList.push(task);
  }

  return {
    total: allTasks.length, open: openTasks.length, closed: closedTasks.length,
    high: highCount, dueToday: dueTodayList.length, carriedOver: carriedOverList.length,
    dueTodayList, carriedOverList, topPriorityList, byCategory, openTasks, closedTasks,
  };
}

function buildPortalExecBlocks(allTasks, prevStatus, prevStats, subtaskMap, now) {
  const s = computePortalStats(allTasks, prevStatus);
  const p = prevStats;
  const today = todayStr();

  const blocks = [];
  blocks.push(bkHeader(`📊 Portal Stabilisation — ${now}`));
  blocks.push(bkContext("_Auto-generated every 2hrs · Mon–Fri 8am–6pm_"));
  blocks.push(bkDivider());

  blocks.push(bkFields([
    `*Total Tasks*\n${trendStr(p?.total, s.total, false)}`,
    `*Open Tasks*\n${trendStr(p?.open, s.open, false)}`,
    `*Closed Tasks*\n${trendStr(p?.closed, s.closed, true)}`,
    `*High Priority*\n${trendStr(p?.high, s.high, false)}`,
    `*Due Today*\n${trendStr(p?.dueToday, s.dueToday, false)}`,
    `*Carried Over*\n${trendStr(p?.carriedOver, s.carriedOver, false)}`,
  ]));
  blocks.push(bkDivider());

  if (s.dueTodayList.length > 0) {
    const rows = s.dueTodayList.map(t =>
      `• *${getPortalPriority(t)}*   <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)} · ${getPortalBoardStatus(t)}`
    ).join("\n");
    blocks.push(bkSection(`*🚨 Due Today (${s.dueTodayList.length}):*\n${rows}`));
    blocks.push(bkDivider());
  }

  const overdueList = s.openTasks.filter(t => t.due_on && t.due_on < today);
  if (overdueList.length > 0) {
    const rows = overdueList.map(t =>
      `• *${getPortalPriority(t)}*   <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)} · ${getPortalBoardStatus(t)}  _was due ${t.due_on}_`
    ).join("\n");
    blocks.push(bkSection(`*🔴 Overdue (${overdueList.length}):*\n${rows}`));
    blocks.push(bkDivider());
  }

  if (s.topPriorityList.length > 0) {
    const rows = s.topPriorityList.map(t => {
      const ds = t.due_on ? dueDateStatus(t.due_on) : null;
      const dueLabel = ds ? (ds.type === "overdue" ? `🔴 ${ds.label}` : ds.type === "today" ? "🚨 Due Today" : ds.label) : "No due date";
      const prog = getPortalProgress(t) || "_No update logged_";
      const subs = subtaskMap[t.gid] || [];
      const subNote = subs.length > 0 ? `\n   📦 ${subs.filter(s => s.completed).length}/${subs.length} subtasks · ${subs.filter(s => !s.completed && !s.assignee).length} unassigned` : "";
      return `🔴 *<${TASK_URL(t.gid)}|${t.name}>*\n   👤 ${ownerName(t)} · ${STATUS_EMOJI[getPortalBoardStatus(t)] || "⬜"} ${getPortalBoardStatus(t)} · ${dueLabel}\n   💬 ${prog}${subNote}`;
    }).join("\n\n");
    blocks.push(bkSection(`*🔴 Top Priority (${s.topPriorityList.length}):*\n${rows}`));
    blocks.push(bkDivider());
  }

  const catLines = Object.entries(s.byCategory).map(([cat, statuses]) => {
    const breakdown = Object.entries(statuses).map(([st, n]) => `${st}:${n}`).join(" · ");
    const total = Object.values(statuses).reduce((a, b) => a + b, 0);
    return `• *${cat}* (${total}) — ${breakdown}`;
  }).join("\n");
  if (catLines) {
    blocks.push(bkSection(`*🗂 Category Overview:*\n${catLines}`));
    blocks.push(bkDivider());
  }

  blocks.push(bkSection("_Full details in thread below ↓_\n*👥 Owner Workplan  ·  📋 Full Report*"));

  const fallback = `📊 Portal Stabilisation — ${now} | Total:${s.total} Open:${s.open} Closed:${s.closed} High:${s.high} Due:${s.dueToday} Carried:${s.carriedOver}`;
  return { blocks, fallback, stats: s };
}

function buildPortalOwnerWorkplanBlocks(allTasks, subtaskMap, prevStatus, now) {
  const today    = todayStr();
  const openTasks = allTasks.filter(t => !isPortalClosed(t));
  const byOwner  = {};

  for (const task of openTasks) {
    const gid = task.assignee?.gid;
    const o   = gid ? OWNERS[gid] : null;
    if (o) {
      if (!byOwner[gid]) byOwner[gid] = { name: o.name, tasks: [], subtasks: [] };
      byOwner[gid].tasks.push(task);
    }
    const subs = subtaskMap[task.gid] || [];
    for (const sub of subs.filter(s => !s.completed)) {
      const sgid = sub.assignee?.gid;
      const so   = sgid ? OWNERS[sgid] : null;
      if (so) {
        if (!byOwner[sgid]) byOwner[sgid] = { name: so.name, tasks: [], subtasks: [] };
        byOwner[sgid].subtasks.push({ sub, parentName: task.name, parentGid: task.gid });
      }
    }
  }

  const blocks = [];
  blocks.push(bkHeader(`👥 Owner Workplan — ${now}`));
  blocks.push(bkContext("_Portal Stabilisation · tasks + subtasks per owner · sorted by urgency_"));
  blocks.push(bkDivider());

  for (const [gid, ownerData] of Object.entries(byOwner)) {
    const { name, tasks, subtasks } = ownerData;
    const prevBoardStatus = {};
    for (const t of tasks) prevBoardStatus[t.gid] = prevStatus[t.gid];

    const urgent = tasks.filter(t => t.due_on && t.due_on <= today);
    const statusBadge = urgent.length > 0 ? `⚠️ ${urgent.length} urgent` : "✅ on track";
    let block = `*${name}* — ${tasks.length} task${tasks.length > 1 ? "s" : ""} · ${subtasks.length} subtask${subtasks.length > 1 ? "s" : ""} · _${statusBadge}_\n`;

    const sorted = [...tasks].sort((a, b) => {
      const aU = a.due_on && a.due_on <= today ? 0 : 1;
      const bU = b.due_on && b.due_on <= today ? 0 : 1;
      return aU - bU;
    });

    for (const task of sorted.slice(0, 4)) {
      const status = getPortalBoardStatus(task);
      const prev   = prevStatus[task.gid];
      const moved  = prev && prev !== status;
      const ds     = task.due_on ? dueDateStatus(task.due_on) : null;
      const dueStr = ds ? (ds.type === "overdue" ? "  _🔴 overdue_" : ds.type === "today" ? "  _🚨 due today_" : ds.type === "tomorrow" ? "  _⚠️ due tomorrow_" : `  _📅 ${ds.label}_`) : "";
      const moveStr = moved ? `  _(${prev} → *${status}*)_` : "";
      const progress = getPortalProgress(task);
      const progLine = progress ? `\n   💬 ${progress.slice(0, 80)}` : "";

      const taskSubs = (subtaskMap[task.gid] || []).filter(s => !s.completed);
      const subNote  = taskSubs.length > 0
        ? `\n   📦 ${taskSubs.filter(s => s.completed).length}/${(subtaskMap[task.gid] || []).length} subtasks · ${taskSubs.filter(s => !s.assignee).length > 0 ? `⚠ ${taskSubs.filter(s => !s.assignee).length} unassigned` : "all assigned"}`
        : "";

      block += `• *${getPortalPriority(task)}*  <${TASK_URL(task.gid)}|${task.name}>${dueStr}${moveStr}${progLine}${subNote}\n`;
    }
    if (sorted.length > 4) block += `   _+ ${sorted.length - 4} more tasks_\n`;

    if (subtasks.length > 0) {
      block += `\n_Subtasks assigned to ${name}:_\n`;
      for (const { sub, parentName, parentGid } of subtasks.slice(0, 3)) {
        const ds = sub.due_on ? dueDateStatus(sub.due_on) : null;
        const dueStr = ds ? (ds.type === "overdue" ? "  _🔴 overdue_" : ds.type === "today" ? "  _🚨 today_" : `  _📅 ${ds.label}_`) : "";
        block += `   ↳ <${TASK_URL(sub.gid)}|${sub.name}>${dueStr}\n      _of: <${TASK_URL(parentGid)}|${parentName.slice(0, 50)}>_\n`;
      }
      if (subtasks.length > 3) block += `   _+ ${subtasks.length - 3} more subtasks_\n`;
    }

    blocks.push(bkSection(block.trim()));
    blocks.push(bkDivider());
  }

  if (Object.keys(byOwner).length === 0) {
    blocks.push(bkSection("_No assigned tasks or subtasks_"));
  }

  blocks.push(bkContext("_Click task links to open in Asana · subtasks shown under their owners_"));
  return { blocks, fallback: `👥 Owner Workplan — ${Object.keys(byOwner).length} owners` };
}

function buildPortalFullReportBlocks(allTasks, subtaskMap, prevStatus, now) {
  const openTasks  = allTasks.filter(t => !isPortalClosed(t));
  const byCategory = {};
  for (const task of openTasks) {
    const cat = getPortalScope(task);
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(task);
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].sort((a, b) => (PRIORITY_SORT[getPortalPriority(a)] || 3) - (PRIORITY_SORT[getPortalPriority(b)] || 3));
  }
  const today = todayStr();
  const blocks = [];
  blocks.push(bkHeader(`📋 Full Report — ${openTasks.length} open tasks · ${now}`));
  blocks.push(bkContext("_Sorted by priority within category · High → Medium → Low_"));
  blocks.push(bkDivider());

  for (const [cat, catTasks] of Object.entries(byCategory)) {
    blocks.push(bkSection(`*━ ${cat.toUpperCase()} (${catTasks.length}) ━*`));
    for (const task of catTasks) {
      const status   = getPortalBoardStatus(task);
      const prev     = prevStatus[task.gid];
      const moved    = prev && prev !== status;
      const progress = getPortalProgress(task) || "_No update_";
      const ds       = task.due_on ? dueDateStatus(task.due_on) : null;
      const dueStr   = ds ? (ds.type === "overdue" ? `  _🔴 ${ds.label}_` : ds.type === "today" ? "  _🚨 Due Today_" : `  _📅 ${ds.label}_`) : "  _📅 No due date_";
      const subs     = subtaskMap[task.gid] || [];
      const subLine  = subs.length > 0 ? `\n📦 ${subs.filter(s => s.completed).length}/${subs.length} subtasks` : "";

      blocks.push(bkSection(
        `${STATUS_EMOJI[status] || "⬜"} *<${TASK_URL(task.gid)}|${task.name}>*${dueStr}\n` +
        `*${getPortalPriority(task)}*  |  👤 ${ownerName(task)}  |  📍 ${moved ? `${prev} → *${status}*` : status}${subLine}\n` +
        `💬 ${progress}`
      ));
    }
    blocks.push(bkDivider());
  }

  blocks.push(bkContext("_Auto-generated · Next report in 2hrs_"));
  return { blocks, fallback: `📋 Full Report — ${openTasks.length} open tasks` };
}

// ─────────────────────────────────────────────
// SEND PORTAL 2HR REPORT
// Mon–Fri 8am, 10am, 12pm, 2pm, 4pm, 6pm
// ─────────────────────────────────────────────
async function sendPortalExecutiveSummary() {
  console.log(`[${new Date().toISOString()}] Sending Portal 2hr report...`);
  try {
    const allTasks   = await fetchProjectTasks(PORTAL_GID);
    const subtaskMap = await buildSubtaskMap(allTasks.filter(t => !isPortalClosed(t)));
    const now = new Date().toLocaleString("en-AU", {
      timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });

    const { blocks: b1, fallback: f1, stats } = buildPortalExecBlocks(allTasks, previousStatus, previousStats, subtaskMap, now);
    const msg = await slackPost(REPORT_CHANNEL, f1, b1);
    const threadTs = msg.ts;
    await delay(800);

    const { blocks: b2, fallback: f2 } = buildPortalOwnerWorkplanBlocks(allTasks, subtaskMap, previousStatus, now);
    await slackPost(REPORT_CHANNEL, f2, b2, threadTs);
    await delay(500);

    const { blocks: b3, fallback: f3 } = buildPortalFullReportBlocks(allTasks, subtaskMap, previousStatus, now);
    await slackPost(REPORT_CHANNEL, f3, b3, threadTs);

    for (const task of allTasks) {
      if (!isPortalClosed(task)) previousStatus[task.gid] = getPortalBoardStatus(task);
    }
    previousStats = {
      total: stats.total, open: stats.open, closed: stats.closed,
      high: stats.high, dueToday: stats.dueToday, carriedOver: stats.carriedOver,
    };
    for (const task of allTasks) {
      if (isPortalClosed(task)) eodClosedToday.add(task.gid);
    }

    console.log(`[${new Date().toISOString()}] Portal 2hr report sent ✓`);
  } catch (err) {
    console.error("Portal report error:", err.message);
  }
}

// ─────────────────────────────────────────────
// EOD REPORT (11:59pm daily) — Portal focused
// ─────────────────────────────────────────────
async function sendEndOfDayReport() {
  console.log(`[${new Date().toISOString()}] Sending EOD report...`);
  try {
    const allTasks = await fetchProjectTasks(PORTAL_GID);
    const today    = todayStr();
    const now      = new Date().toLocaleString("en-AU", {
      timeZone: TZ, weekday: "short", day: "numeric", month: "short",
    });

    for (const task of allTasks) {
      if (isPortalClosed(task)) eodClosedToday.add(task.gid);
    }

    const closedAll    = allTasks.filter(t => isPortalClosed(t));
    const openTasks    = allTasks.filter(t => !isPortalClosed(t));
    const closedToday  = closedAll.filter(t => eodClosedToday.has(t.gid));
    const carriedOver  = openTasks.filter(t => t.due_on && t.due_on <= today);
    const active       = openTasks.filter(t => !t.due_on || t.due_on > today);
    const topPriority  = openTasks.filter(t => t.name.toLowerCase().includes("top priority"));

    const byOwnerCarry = {};
    for (const t of carriedOver) {
      const o = ownerName(t);
      byOwnerCarry[o] = (byOwnerCarry[o] || 0) + 1;
    }
    const ownerSummary = Object.entries(byOwnerCarry).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} (${n})`).join(", ");

    const eodBlocks = [];
    eodBlocks.push(bkHeader(`🌙 Portal Stabilisation — End of Day · ${now}`));
    eodBlocks.push(bkContext("_Daily summary · Next report tomorrow 8:00 AM_"));
    eodBlocks.push(bkDivider());
    eodBlocks.push(bkFields([
      `*✅ Closed Today*\n${closedToday.length}`,
      `*🔴 Carrying Over*\n${carriedOver.length}`,
      `*🟡 Still Active*\n${active.length}`,
      `*🔴 Top Priority Open*\n${topPriority.length}`,
    ]));
    eodBlocks.push(bkDivider());

    if (topPriority.length > 0) {
      const tpLines = topPriority.map(t => {
        const ds = t.due_on ? dueDateStatus(t.due_on) : null;
        const dueLabel = ds ? (ds.type === "overdue" ? `🔴 ${ds.label}` : ds.type === "today" ? "🚨 Was due today" : ds.label) : "No due date";
        return `🔴 *<${TASK_URL(t.gid)}|${t.name}>*\n   👤 ${ownerName(t)} · ${STATUS_EMOJI[getPortalBoardStatus(t)] || "⬜"} ${getPortalBoardStatus(t)} · ${dueLabel}\n   💬 ${getPortalProgress(t) || "_No update logged today_"}`;
      }).join("\n\n");
      eodBlocks.push(bkSection(`*🔴 Top Priority Status:*\n${tpLines}`));
      eodBlocks.push(bkDivider());
    }

    const tomorrow = [];
    if (carriedOver.length > 0) tomorrow.push(`• ${carriedOver.length} tasks carrying over — ${ownerSummary} — resolve or escalate`);
    if (active.length > 0)      tomorrow.push(`• ${active.length} active tasks due soon — owners to log progress by 10am`);
    if (topPriority.some(t => !getPortalProgress(t))) tomorrow.push("• Top Priority task(s) missing progress update — update required first thing");

    if (tomorrow.length > 0) {
      eodBlocks.push(bkSection(`*📅 Tomorrow's focus:*\n${tomorrow.join("\n")}`));
      eodBlocks.push(bkDivider());
    }

    eodBlocks.push(bkSection("_Good night team 🌙 · Full breakdown in thread ↓_\n*📋 Full EOD Report*"));

    const eodMsg = await slackPost(REPORT_CHANNEL, `🌙 Portal EOD · Closed: ${closedToday.length} · Carrying over: ${carriedOver.length}`, eodBlocks);
    const threadTs = eodMsg.ts;
    await delay(800);

    // Thread: full breakdown
    const threadBlocks = [];
    threadBlocks.push(bkHeader(`📋 EOD Full Report — ${now}`));
    threadBlocks.push(bkContext(`_${allTasks.length} total · ${closedAll.length} closed · ${openTasks.length} open_`));
    threadBlocks.push(bkDivider());

    if (closedToday.length > 0) {
      const lines = closedToday.map(t => `✅ <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)}`).join("\n");
      threadBlocks.push(bkSection(`*✅ Closed today (${closedToday.length}):*\n${lines}`));
      threadBlocks.push(bkDivider());
    }

    if (carriedOver.length > 0) {
      const overdueSplit = carriedOver.filter(t => t.due_on < today);
      const dueTodaySplit = carriedOver.filter(t => t.due_on === today);
      let carryText = "";
      if (overdueSplit.length > 0) {
        carryText += `_Overdue from previous days:_\n` +
          overdueSplit.map(t => `• *${getPortalPriority(t)}*   <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)} · ${getPortalBoardStatus(t)}  _was due ${t.due_on}_`).join("\n") + "\n\n";
      }
      if (dueTodaySplit.length > 0) {
        carryText += `_Due today, not closed:_\n` +
          dueTodaySplit.map(t => `• *${getPortalPriority(t)}*   <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)} · ${getPortalBoardStatus(t)}`).join("\n");
      }
      threadBlocks.push(bkSection(`*🔴 Carrying over (${carriedOver.length}):*\n${carryText.trim()}`));
      threadBlocks.push(bkDivider());
    }

    if (active.length > 0) {
      const lines = active.slice(0, 8).map(t => {
        const prog = getPortalProgress(t);
        return `🟡 *${getPortalPriority(t)}*   <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)} · ${t.due_on ? `due ${t.due_on}` : "no date"}${prog ? `\n   _> ${prog.slice(0, 80)}_` : ""}`;
      }).join("\n\n");
      threadBlocks.push(bkSection(`*🟡 Still active — not yet due (${active.length}):*\n${lines}`));
      threadBlocks.push(bkDivider());
    }

    threadBlocks.push(bkContext(`_End of Day Report · ${now}_`));
    await slackPost(REPORT_CHANNEL, "📋 Full EOD breakdown", threadBlocks, threadTs);

    eodClosedToday.clear();
    console.log(`[${new Date().toISOString()}] EOD report sent ✓`);
  } catch (err) {
    console.error("EOD error:", err.message);
  }
}

// ─────────────────────────────────────────────
// OWNER DMs — cross-project + subtasks
// Mon–Fri 9:30am, 11:30am, 1:30pm, 3:30pm, 5:30pm
// ─────────────────────────────────────────────
async function sendOwnerReminders() {
  console.log(`[${new Date().toISOString()}] Sending owner reminders...`);
  try {
    const today = todayStr();
    const now   = new Date().toLocaleString("en-AU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

    // Fetch Portal tasks + subtasks (most active project for DMs)
    const portalTasks    = await fetchProjectTasks(PORTAL_GID);
    const portalOpen     = portalTasks.filter(t => !isPortalClosed(t));
    const portalSubMap   = await buildSubtaskMap(portalOpen);

    // Build per-owner map: tasks + subtasks
    const byOwner = {};

    for (const task of portalOpen) {
      const gid = task.assignee?.gid;
      if (!gid || !OWNERS[gid]?.slack) continue;
      if (!byOwner[gid]) byOwner[gid] = { tasks: [], subtasksOwned: [] };
      byOwner[gid].tasks.push(task);
    }
    // Subtask owners
    for (const [parentGid, subs] of Object.entries(portalSubMap)) {
      const parent = portalOpen.find(t => t.gid === parentGid);
      for (const sub of subs.filter(s => !s.completed)) {
        const sgid = sub.assignee?.gid;
        if (!sgid || !OWNERS[sgid]?.slack) continue;
        if (!byOwner[sgid]) byOwner[sgid] = { tasks: [], subtasksOwned: [] };
        byOwner[sgid].subtasksOwned.push({ sub, parentName: parent?.name || "Unknown", parentGid });
      }
    }

    for (const [asanaGid, data] of Object.entries(byOwner)) {
      const owner = OWNERS[asanaGid];
      if (!owner.slack) continue;
      const { tasks, subtasksOwned } = data;

      const sorted = [...tasks].sort((a, b) => {
        const aU = a.due_on && a.due_on <= today ? 0 : (PRIORITY_SORT[getPortalPriority(a)] || 3) + 1;
        const bU = b.due_on && b.due_on <= today ? 0 : (PRIORITY_SORT[getPortalPriority(b)] || 3) + 1;
        return aU - bU;
      });

      const blocks = [];
      blocks.push(bkHeader(`⏰ Reminder: Update your progress — ${now}`));
      blocks.push(bkSection(`Hi *${owner.name}!* You have *${sorted.length} task${sorted.length !== 1 ? "s" : ""}* and *${subtasksOwned.length} subtask${subtasksOwned.length !== 1 ? "s" : ""}* open in Portal Stabilisation:`));
      blocks.push(bkDivider());

      const urgent = sorted.filter(t => t.due_on && t.due_on <= today);
      if (urgent.length > 0) {
        const urgentLines = urgent.map(t => {
          const ds = dueDateStatus(t.due_on);
          return `${ds?.type === "overdue" ? `🔴 ${ds.label}` : "🚨 Due Today"}  *${getPortalPriority(t)}*  *${t.name}*\n  📎 <${TASK_URL(t.gid)}|Update now>`;
        }).join("\n\n");
        blocks.push(bkSection(`*Urgent:*\n${urgentLines}`));
        blocks.push(bkDivider());
      }

      for (const task of sorted.slice(0, 5)) {
        const status   = getPortalBoardStatus(task);
        const prev     = previousStatus[task.gid];
        const moved    = prev && prev !== status;
        const progress = getPortalProgress(task);
        const ds       = task.due_on ? dueDateStatus(task.due_on) : null;
        const dueText  = ds ? (ds.type === "overdue" ? "  _🔴 overdue_" : ds.type === "today" ? "  _🚨 Due Today_" : ds.type === "tomorrow" ? "  _⚠️ Due tomorrow_" : `  _📅 ${ds.label}_`) : "  _📅 No due date_";
        const subs     = portalSubMap[task.gid] || [];
        const subNote  = subs.length > 0 ? `\n📦 ${subs.filter(s => s.completed).length}/${subs.length} subtasks · ${subs.filter(s => !s.completed && !s.assignee).length > 0 ? `⚠ ${subs.filter(s => !s.completed && !s.assignee).length} unassigned` : "all assigned"}` : "";

        blocks.push(bkSection(
          `${STATUS_EMOJI[status] || "⬜"} *${task.name}*${dueText}\n` +
          `*${getPortalPriority(task)}*  |  📍 ${moved ? `${prev} → *${status}*` : `*${status}*`}\n` +
          `💬 ${progress || "_No update yet — please add one_"}${subNote}\n` +
          `📎 <${TASK_URL(task.gid)}|Update in Asana>`
        ));
      }
      if (sorted.length > 5) blocks.push(bkContext(`_+ ${sorted.length - 5} more tasks_`));

      if (subtasksOwned.length > 0) {
        blocks.push(bkDivider());
        const subLines = subtasksOwned.slice(0, 4).map(({ sub, parentName, parentGid }) => {
          const ds = sub.due_on ? dueDateStatus(sub.due_on) : null;
          const dueStr = ds ? (ds.type === "overdue" ? "  🔴 overdue" : ds.type === "today" ? "  🚨 today" : `  📅 ${ds.label}`) : "  no due date";
          return `• <${TASK_URL(sub.gid)}|${sub.name}>${dueStr}\n   _↳ subtask of <${TASK_URL(parentGid)}|${parentName.slice(0, 50)}>_`;
        }).join("\n\n");
        blocks.push(bkSection(`*Your subtasks (${subtasksOwned.length}):*\n${subLines}`));
        if (subtasksOwned.length > 4) blocks.push(bkContext(`_+ ${subtasksOwned.length - 4} more subtasks_`));
      }

      blocks.push(bkDivider());
      blocks.push(bkSection("*To update:* Click task link → add a line to *Progress Log* field → move board card if status changed."));

      await slackPost(owner.slack, `⏰ You have ${sorted.length} task${sorted.length !== 1 ? "s" : ""} + ${subtasksOwned.length} subtask${subtasksOwned.length !== 1 ? "s" : ""} open in Portal Stabilisation`, blocks);
      console.log(`[${new Date().toISOString()}] DM → ${owner.name} ✓`);
      await delay(500);
    }
  } catch (err) {
    console.error("Owner reminder error:", err.message);
  }
}

// ─────────────────────────────────────────────
// ON-DEMAND /report COMMAND
// Polls #project-update for "/report" messages → DMs the requester
// ─────────────────────────────────────────────
async function buildOnDemandReport(userId) {
  const today    = todayStr();
  const now      = new Date().toLocaleString("en-AU", {
    timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });

  const blocks = [];
  blocks.push(bkHeader(`⚡ On-demand Report · ${now}`));
  blocks.push(bkContext("_Live Asana data · private to you_"));
  blocks.push(bkDivider());

  const statusLines = [];
  for (const proj of PROJECTS) {
    try {
      const tasks = await fetchProjectTasks(proj.gid);
      const open  = tasks.filter(t => !t.completed);
      const overdue = open.filter(t => t.due_on && t.due_on < today);
      const dueToday = open.filter(t => t.due_on === today);
      const rag = overdue.length >= 3 ? "🔴" : overdue.length >= 1 || dueToday.length >= 2 ? "🟡" : "🟢";
      let detail = `${open.length} open · ${tasks.filter(t => t.completed).length} closed`;
      if (proj.goLive) detail += ` · Go-live ${proj.goLive} (${daysUntil(proj.goLive)}d)`;
      else if (overdue.length > 0) detail += ` · ${overdue.length} overdue ⚠️`;
      else if (dueToday.length > 0) detail += ` · ${dueToday.length} due today`;
      statusLines.push(`${rag} *${proj.name}* — ${detail}`);
    } catch { statusLines.push(`⚫ *${proj.name}* — unable to fetch`); }
    await delay(200);
  }

  blocks.push(bkSection(`*Project status:*\n${statusLines.join("\n")}`));
  blocks.push(bkDivider());

  // Most urgent tasks across all projects
  const urgentAll = [];
  try {
    const portalTasks = await fetchProjectTasks(PORTAL_GID);
    const portalOpen  = portalTasks.filter(t => !isPortalClosed(t));
    const overdue = portalOpen.filter(t => t.due_on && t.due_on < today);
    const dueToday = portalOpen.filter(t => t.due_on === today);
    const topPri = portalOpen.filter(t => t.name.toLowerCase().includes("top priority"));
    [...topPri.slice(0,2), ...overdue.slice(0,3), ...dueToday.slice(0,2)].forEach(t => {
      if (!urgentAll.find(u => u.gid === t.gid)) {
        urgentAll.push({ ...t, projName: "Portal Stabilisation" });
      }
    });
  } catch {}

  if (urgentAll.length > 0) {
    const urgentLines = urgentAll.slice(0, 5).map(t => {
      const ds = t.due_on ? dueDateStatus(t.due_on) : null;
      const dueStr = ds ? (ds.type === "overdue" ? `🔴 was due ${t.due_on}` : "🚨 due today") : "";
      return `• <${TASK_URL(t.gid)}|${t.name}> · ${ownerName(t)} · ${dueStr}`;
    }).join("\n");
    blocks.push(bkSection(`*Most urgent right now:*\n${urgentLines}`));
    blocks.push(bkDivider());
  }

  blocks.push(bkContext("_Type !report in #project-update any time for a fresh copy_"));
  return { blocks, fallback: `⚡ On-demand Report · ${now}` };
}

async function pollForReportCommand() {
  try {
    const messages = await slackGetHistory(REPORT_CHANNEL, lastReportCheckTs, 20);
    if (!messages.length) return;
    const sorted = [...messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
    for (const msg of sorted) {
      if (parseFloat(msg.ts) <= parseFloat(lastReportCheckTs)) continue;
      lastReportCheckTs = msg.ts;
      const text = (msg.text || "").trim().toLowerCase();
      // Trigger: "!report" — avoids Slack's slash command interception
      // Also catch common variants people might type
      if (!text.startsWith("!report") && text !== "report" && !text.startsWith("report now") && !text.startsWith("status report")) continue;
      if (!msg.user) continue;

      // Acknowledge in channel
      await slackPost(REPORT_CHANNEL, `📊 Generating on-demand report — check your DMs in a moment`, null, null);

      // DM the requester
      const { blocks, fallback } = await buildOnDemandReport(msg.user);
      await slackPost(msg.user, fallback, blocks);
      console.log(`[${new Date().toISOString()}] /report → DM to ${msg.user} ✓`);
    }
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("channel_not_found")) {
      console.error(`[POLL ERROR] channel_not_found for ${REPORT_CHANNEL} — invite the bot to #project-update`);
    } else if (msg.includes("missing_scope")) {
      console.error(`[POLL ERROR] missing_scope — add groups:history scope at api.slack.com/apps then reinstall`);
    } else if (msg.includes("not_in_channel")) {
      console.error(`[POLL ERROR] Bot not in channel — type @PortalBot in #project-update and click Invite`);
    } else {
      console.error(`[POLL ERROR] ${msg}`);
    }
  }
}

// ─────────────────────────────────────────────
// MULTI-CHANNEL AUTO-TASK CONVERTER
// Every 15 mins — reads all mapped channels
// ─────────────────────────────────────────────
async function autoConvertMultiChannel() {
  const today = todayStr();
  const PRIORITY_GIDS = { "High": "1135564385376581", "Medium": "1135564385376582", "Low": "1135564385376583" };

  for (const [channelId, mapping] of Object.entries(CHANNEL_MAP)) {
    try {
      const messages = await slackGetHistory(channelId, lastProcessedTs[channelId], 50);
      if (!messages.length) continue;

      const sorted = [...messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
      for (const msg of sorted) {
        if (parseFloat(msg.ts) <= parseFloat(lastProcessedTs[channelId])) continue;
        lastProcessedTs[channelId] = msg.ts;

        const watchedUser = WATCH_USERS[msg.user];
        if (!watchedUser) continue;
        const text = (msg.text || "").trim();
        if (text.length < 20 || /^(hi|hello|hey|thanks|ok|yes|no|\/report)\b/i.test(text)) continue;

        // Claude analysis — prompt adapts to project type
        const projectName = mapping.label;
        const analysis = await callClaude(
          `Analyze this Slack message from ${watchedUser} for actionable tasks to be created in the Asana project "${projectName}".\n\nMessage: "${text}"\n\nReturn ONLY valid JSON:\n{"is_actionable":true/false,"tasks":[{"name":"","description":"","suggested_assignee":"Pete|Saber|Mahit|Chayan|null","priority":"High|Medium|Low"}]}`,
          "Return only valid JSON. Focus on concrete action items that need tracking."
        );

        let parsed;
        try { parsed = JSON.parse(analysis.replace(/```json\n?|```\n?/g, "").trim()); }
        catch { continue; }
        if (!parsed.is_actionable || !parsed.tasks?.length) continue;

        // Resolve target section
        let sectionGid = null;
        if (mapping.sectionStyle === "fixed") {
          sectionGid = mapping.sectionGid;
        } else if (mapping.sectionStyle === "date") {
          sectionGid = await getOrCreateDateSection(mapping.projectGid, todayLabel());
        } else if (mapping.sectionStyle === "first") {
          sectionGid = await getFirstSection(mapping.projectGid);
        }

        const created = [];
        for (const td of parsed.tasks) {
          const assigneeEntry = Object.entries(OWNERS).find(([, v]) => v.name === td.suggested_assignee);
          const priorityGid   = PRIORITY_GIDS[td.priority];

          const taskBody = {
            name:     td.name,
            notes:    `SOURCE: ${watchedUser} in ${mapping.label} Slack channel (${new Date().toLocaleDateString("en-AU", { timeZone: TZ })})\n\nDESCRIPTION\n${td.description}\n\nSOLUTION\n[Owner to complete]\n\nPROGRESS LOG\n[Date] — [Update here]`,
            projects: [mapping.projectGid],
            ...(assigneeEntry && { assignee: assigneeEntry[0] }),
          };

          if (sectionGid) taskBody.memberships = [{ project: mapping.projectGid, section: sectionGid }];
          if (priorityGid && mapping.projectGid === PORTAL_GID) {
            taskBody.custom_fields = { "1135564385376580": priorityGid };
          }

          const task = await asanaPost("/tasks", taskBody);
          created.push(task);
          console.log(`[${new Date().toISOString()}] Created in ${projectName}: "${td.name}" ✓`);
          await delay(200);
        }

        if (created.length) {
          const sectionNote = mapping.sectionStyle === "date" ? ` under *${todayLabel()}* section` : "";
          await slackPost(
            channelId,
            `✅ ${created.length} task${created.length > 1 ? "s" : ""} created in ${projectName}.`,
            [bkSection(
              `✅ *${created.length} task${created.length > 1 ? "s" : ""} created in ${projectName}${sectionNote}:*\n` +
              created.map(t => `• <${TASK_URL(t.gid)}|${t.name}>`).join("\n")
            )]
          );
        }
        await delay(1000);
      }
    } catch (err) {
      const m = err.message || "";
      if (m.includes("missing_scope")) {
        console.error(`[CHANNEL ${channelId}] missing_scope — add groups:history in Slack app settings`);
      } else {
        console.error(`[CHANNEL ${channelId}] ${m}`);
      }
    }
    await delay(500);
  }
}

// ─────────────────────────────────────────────
// UNASSIGNED TASK ALERT → Saber (daily 9am)
// ─────────────────────────────────────────────
async function sendUnassignedAlert() {
  try {
    const allTasks   = await fetchProjectTasks(PORTAL_GID);
    const openTasks  = allTasks.filter(t => !isPortalClosed(t));
    const subtaskMap = await buildSubtaskMap(openTasks);

    const unassignedTasks = openTasks.filter(t => !t.assignee);
    const unassignedSubs  = [];
    for (const [parentGid, subs] of Object.entries(subtaskMap)) {
      const parent = openTasks.find(t => t.gid === parentGid);
      for (const sub of subs.filter(s => !s.completed && !s.assignee)) {
        unassignedSubs.push({ sub, parentName: parent?.name || "Unknown", parentGid });
      }
    }

    if (unassignedTasks.length === 0 && unassignedSubs.length === 0) return;

    const blocks = [];
    blocks.push(bkHeader(`⚠️ Unassigned Tasks Alert — ${todayLabel()}`));
    blocks.push(bkSection(`*${unassignedTasks.length} unassigned tasks* and *${unassignedSubs.length} unassigned subtasks* need owners assigned:`));
    blocks.push(bkDivider());

    if (unassignedTasks.length > 0) {
      const lines = unassignedTasks.slice(0, 8).map(t =>
        `• <${TASK_URL(t.gid)}|${t.name}> · ${getPortalBoardStatus(t)} · _${getPortalPriority(t)}_`
      ).join("\n");
      blocks.push(bkSection(`*Unassigned tasks (${unassignedTasks.length}):*\n${lines}${unassignedTasks.length > 8 ? `\n_+ ${unassignedTasks.length - 8} more_` : ""}`));
      blocks.push(bkDivider());
    }

    if (unassignedSubs.length > 0) {
      const lines = unassignedSubs.slice(0, 8).map(({ sub, parentName, parentGid }) =>
        `• <${TASK_URL(sub.gid)}|${sub.name}>\n   _↳ of <${TASK_URL(parentGid)}|${parentName.slice(0, 50)}>_`
      ).join("\n\n");
      blocks.push(bkSection(`*Unassigned subtasks (${unassignedSubs.length}):*\n${lines}${unassignedSubs.length > 8 ? `\n_+ ${unassignedSubs.length - 8} more_` : ""}`));
    }

    blocks.push(bkDivider());
    blocks.push(bkContext("_Please assign owners in Asana so the team knows who owns each item_"));

    const saberSlack = OWNERS["1213778917763529"]?.slack;
    const michaelSlack = OWNERS["1209967224903860"]?.slack;
    if (saberSlack) await slackPost(saberSlack, `⚠️ ${unassignedTasks.length} unassigned tasks in Portal Stabilisation`, blocks);
    if (michaelSlack) await slackPost(michaelSlack, `⚠️ ${unassignedTasks.length} unassigned tasks in Portal Stabilisation`, blocks);
    console.log(`[${new Date().toISOString()}] Unassigned alert sent ✓`);
  } catch (err) {
    console.error("Unassigned alert error:", err.message);
  }
}

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────
async function joinChannel(channelId) {
  try {
    const res = await axios.post("https://slack.com/api/conversations.join",
      { channel: channelId },
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" } }
    );
    if (res.data.ok || res.data.error === "already_in_channel") {
      console.log(`  ✓ Channel ${channelId} — joined/confirmed`);
    } else {
      console.warn(`  ⚠ Cannot join ${channelId}: ${res.data.error} — private channel needs manual /invite`);
    }
  } catch (err) {
    console.warn(`  ⚠ Channel join error ${channelId}: ${err.message}`);
  }
}

async function startupCheck() {
  console.log("═════════════════════════════════════════════════");
  console.log("  Apate AI Automation v8.2");
  console.log("  Multi-project · Subtask tracking · !report command");
  console.log("═════════════════════════════════════════════════");

  try {
    const allTasks  = await fetchProjectTasks(PORTAL_GID);
    const openTasks = allTasks.filter(t => !isPortalClosed(t));
    const closed    = allTasks.filter(t => isPortalClosed(t));
    for (const task of openTasks) previousStatus[task.gid] = getPortalBoardStatus(task);
    for (const task of closed)    eodClosedToday.add(task.gid);
    console.log(`  ✓ Portal Stabilisation — ${allTasks.length} total, ${openTasks.length} open, ${closed.length} closed`);
  } catch (e) { console.error("  ✗ Asana:", e.message); process.exit(1); }

  try {
    await axios.get("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
    console.log("  ✓ Slack connected");
  } catch (e) { console.error("  ✗ Slack:", e.message); process.exit(1); }

  // Verify we can read the report channel (confirms bot is invited)
  console.log("  Verifying channel access...");
  try {
    await slackGetHistory(REPORT_CHANNEL, (Date.now()/1000 - 60).toString(), 1);
    console.log(`  ✓ #project-update (${REPORT_CHANNEL}) readable`);
  } catch (e) {
    console.warn(`  ⚠ Cannot read ${REPORT_CHANNEL}: ${e.message}`);
    console.warn("  ⚠ Make sure the bot is invited: type @Portal Bot in #project-update → Invite to Channel");
    console.warn("  ⚠ Also ensure the Slack bot token has groups:history scope in api.slack.com/apps");
  }

  for (const ch of Object.keys(CHANNEL_MAP)) {
    try {
      await slackGetHistory(ch, (Date.now()/1000 - 60).toString(), 1);
      console.log(`  ✓ Channel ${ch} readable`);
    } catch (e) {
      console.warn(`  ⚠ Cannot read ${ch}: ${e.message}`);
    }
    await delay(200);
  }

  console.log("  ✓ All systems go\n");

  await slackPost(REPORT_CHANNEL,
    "Apate AI Automation v8 is live.",
    [
      bkHeader("🤖 Apate AI Automation v8 — Live"),
      bkSection(
        "*5 projects tracked · Subtask owners in DMs · Date sections (McAfee + Incident Register)*\n" +
        "*Multi-channel auto-task creation · `!report` on-demand · All reports → #project-update*\n" +
        "_⚠ If you see channel errors, make sure to invite the bot: type_ `@Portal Bot` _in #project-update_"
      ),
      bkFields([
        "*Portfolio Report*\nDaily 8am",
        "*Portal 2hr*\nMon–Fri 8am–6pm",
        "*Owner DMs*\nMon–Fri 9:30am–5:30pm",
        "*EOD Report*\nDaily 11:59pm",
        "*Auto-tasks*\nEvery 15 mins (5 channels)",
        "*!report*\nType in #project-update",
      ]),
    ]
  );
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
(async () => {
  await startupCheck();

  // Daily 8am portfolio report (all 5 projects)
  cron.schedule("0 8 * * *", sendDailyPortfolioReport, { timezone: TZ });

  // Portal 2hr exec reports: Mon–Fri 8am, 10am, 12pm, 2pm, 4pm, 6pm
  cron.schedule("0 8,10,12,14,16,18 * * 1-5", sendPortalExecutiveSummary, { timezone: TZ });

  // Owner DMs: Mon–Fri 9:30am, 11:30am, 1:30pm, 3:30pm, 5:30pm
  cron.schedule("30 9,11,13,15,17 * * 1-5", sendOwnerReminders, { timezone: TZ });

  // Unassigned alert: Mon–Fri 9am → Saber + Michael
  cron.schedule("0 9 * * 1-5", sendUnassignedAlert, { timezone: TZ });

  // EOD report: daily 11:59pm
  cron.schedule("59 23 * * *", sendEndOfDayReport, { timezone: TZ });

  // Auto-task converter: every 15 mins (all channels)
  cron.schedule("*/15 * * * *", autoConvertMultiChannel);

  // /report command poll: every 2 mins
  cron.schedule("*/2 * * * *", pollForReportCommand);

  console.log("✅ All schedulers running.");
  console.log("  📁 Portfolio report:   daily 8am");
  console.log("  📊 Portal 2hr:         Mon–Fri 8am–6pm → #project-update");
  console.log("  👥 Owner DMs:          Mon–Fri 9:30am–5:30pm (tasks + subtasks)");
  console.log("  ⚠️  Unassigned alert:  Mon–Fri 9am → Saber + Michael");
  console.log("  🌙 EOD report:         daily 11:59pm");
  console.log("  🔄 Auto-tasks:         every 15 mins (5 channels)");
  console.log("  ⚡ !report command:    every 2 mins poll (type !report in #project-update)\n");
})();
