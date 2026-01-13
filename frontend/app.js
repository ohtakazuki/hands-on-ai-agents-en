// frontend/app.js
"use strict";

/**
 * Base URL for the Agent Server
 * - Default for `langgraph dev` is http://127.0.0.1:2024
 * - You can override via query string, e.g. ?api=http://127.0.0.1:2024
 */
const API_BASE = (() => {
  const qs = new URLSearchParams(location.search);
  const fromQuery = qs.get("api");
  const fromStorage = localStorage.getItem("agent_api_base");
  const v = (fromQuery || fromStorage || "http://127.0.0.1:2024").trim();
  localStorage.setItem("agent_api_base", v);
  return v;
})();

// Published graph name (key under `graphs` in langgraph.json)
const ASSISTANT_ID = "business_plan";

// Max log entries (newest first)
const MAX_LOG_ITEMS = 80;

// Storage key for thread_id
const THREAD_ID_KEY = "agent_thread_id";

// Whether to show noisy SSE (raw JSON/metadata/etc). Usually keep false.
const SHOW_NOISY_SSE = false;

let threadId = null;
let uiState = "idle"; // idle | starting | waiting_approval | resuming | done | error
let logItems = [];   // [{timeISO, tag, agent, summary, detail, raw}]

// AbortController to cancel an in-flight SSE stream
let currentController = null;

// ---- labels ----
const NODE_LABEL = {
  research_agent: "Research (research_agent)",
  tools: "Search (tools)",
  summary_agent: "Summary (summary_agent)",
  market_agent: "Market analysis (market_agent)",
  technical_agent: "Technical review (technical_agent)",
  human_approval: "Awaiting approval (human_approval)",
  report_agent: "Report generation (report_agent)",
};

const UI_LABEL = {
  idle: "Idle",
  starting: "Running (streaming…)",
  waiting_approval: "Awaiting approval (HITL input required)",
  resuming: "Resuming (streaming…)",
  done: "Done",
  error: "Error",
};

// ---- DOM ----
const themeEl = document.getElementById("theme");
const startBtn = document.getElementById("startBtn");
const clearBtn = document.getElementById("clearBtn");

const statusCard = document.getElementById("statusCard");
const statusEl = document.getElementById("status");
const statusDetails = document.getElementById("statusDetails");
const stateBadge = document.getElementById("stateBadge");
const spinnerEl = document.getElementById("spinner");
const errorBanner = document.getElementById("errorBanner");
const logListEl = document.getElementById("logList");
const clearLogBtn = document.getElementById("clearLogBtn");
const cancelBtn = document.getElementById("cancelBtn");

const workBadge = document.getElementById("workBadge");

const approvalCard = document.getElementById("approvalCard");
const questionEl = document.getElementById("question");
const previewEl = document.getElementById("preview");
const approveBtn = document.getElementById("approveBtn");
const retryBtn = document.getElementById("retryBtn");
const rejectBtn = document.getElementById("rejectBtn");

const reportCard = document.getElementById("reportCard");
const reportEl = document.getElementById("report");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");

// ---- UI helpers ----
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function setError(message) {
  if (!message) {
    hide(errorBanner);
    errorBanner.textContent = "";
    return;
  }
  show(statusCard);
  show(errorBanner);
  errorBanner.textContent = String(message);
}

function setBadge(state) {
  stateBadge.textContent = UI_LABEL[state] || state;
  stateBadge.dataset.state = state;
}

function setWork(nodeKeyOrLabel) {
  const s = nodeKeyOrLabel || "-";
  workBadge.textContent = NODE_LABEL[s] || s;
}

function setUiState(state) {
  uiState = state;
  setBadge(state);

  const busy = (state === "starting" || state === "resuming");
  const waiting = (state === "waiting_approval");

  startBtn.disabled = busy || waiting;
  clearBtn.disabled = busy || waiting;

  approveBtn.disabled = !waiting;
  retryBtn.disabled = !waiting;
  rejectBtn.disabled = !waiting;

  if (busy) show(spinnerEl);
  else hide(spinnerEl);

  if (busy) show(cancelBtn);
  else hide(cancelBtn);

  if (waiting) statusDetails.open = false;
  else if (state === "idle") statusDetails.open = false;
  else statusDetails.open = true;
}

function setStatus(obj) {
  show(statusCard);
  statusEl.textContent = JSON.stringify(obj, null, 2);
}

function toTextMaybe(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
}

function firstLines(text, n = 4) {
  const s = String(text || "");
  const lines = s.split(/\r?\n/);
  const head = lines.slice(0, n).join("\n");
  const more = lines.length > n;
  return { head, more };
}

function renderPreview(analysisPreview) {
  previewEl.innerHTML = "";
  const list = Array.isArray(analysisPreview) ? analysisPreview : [];

  if (list.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.style.margin = "6px 0 0";
    p.textContent = "(No preview data. If needed, add `analysis_preview` on the server side.)";
    previewEl.appendChild(p);
    return;
  }

  const frag = document.createDocumentFragment();

  list.forEach((x, idx) => {
    const type = String(x?.type || `Message ${idx + 1}`);
    const full = toTextMaybe(x?.content ?? x);

    const { head, more } = firstLines(full, 4);
    const headOneLine = head.replace(/\n+/g, " ⏎ ");

    // Show first few lines by default; click to expand full text
    const details = document.createElement("details");
    details.className = "preview-item";
    details.open = false;

    const summary = document.createElement("summary");
    summary.style.cursor = "pointer";

    const title = document.createElement("strong");
    title.textContent = type;

    const snippet = document.createElement("span");
    snippet.style.marginLeft = "10px";
    snippet.style.color = "#d7deee";
    snippet.textContent = headOneLine + (more ? " …" : "");

    summary.appendChild(title);
    summary.appendChild(snippet);

    const pre = document.createElement("pre");
    pre.textContent = full || "";

    details.appendChild(summary);
    details.appendChild(pre);

    frag.appendChild(details);
  });

  previewEl.appendChild(frag);
}

function restoreTheme() {
  const saved = localStorage.getItem("agent_theme");
  if (saved) themeEl.value = saved;
}
function persistTheme(value) { localStorage.setItem("agent_theme", value); }

function restoreThreadId() {
  const saved = localStorage.getItem(THREAD_ID_KEY);
  return saved || null;
}
function persistThreadId(id) { localStorage.setItem(THREAD_ID_KEY, id); }
function clearThreadId() { localStorage.removeItem(THREAD_ID_KEY); }

function nowISO() { return new Date().toISOString(); }
function fmtLocalTime(iso) {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso;
  }
}

function truncate(s, n = 120) {
  const t = String(s ?? "");
  if (t.length <= n) return t;
  return t.slice(0, n) + "…";
}

function addLogEntry({ tag, agent, summary, detail, raw }) {
  logItems.unshift({
    timeISO: nowISO(),
    tag: String(tag || "LOG"),
    agent: agent ? String(agent) : "",
    summary: String(summary || ""),
    detail: String(detail || ""),
    raw: raw ?? null,
  });
  if (logItems.length > MAX_LOG_ITEMS) logItems = logItems.slice(0, MAX_LOG_ITEMS);
  renderLog();
}

function renderLog() {
  logListEl.innerHTML = "";
  const frag = document.createDocumentFragment();

  if (logItems.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.style.margin = "0";
    empty.textContent = "No logs yet.";
    frag.appendChild(empty);
    logListEl.appendChild(frag);
    return;
  }

  for (const item of logItems) {
    const details = document.createElement("details");
    details.className = "log-item";
    details.open = false; // collapsed by default

    const summary = document.createElement("summary");

    const left = document.createElement("div");
    left.className = "log-left";

    const tag = document.createElement("span");
    tag.className = "log-tag";
    tag.textContent = item.tag;

    left.appendChild(tag);

    if (item.agent) {
      const agent = document.createElement("span");
      agent.className = "log-agent";
      agent.textContent = item.agent;
      left.appendChild(agent);
    }

    const sum = document.createElement("span");
    sum.className = "log-summary";
    sum.textContent = item.summary;
    left.appendChild(sum);

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = fmtLocalTime(item.timeISO);

    summary.appendChild(left);
    summary.appendChild(time);

    const body = document.createElement("div");
    body.className = "log-body";

    const pre = document.createElement("pre");
    pre.textContent = item.detail || item.summary || "";
    body.appendChild(pre);

    if (item.raw) {
      const rawDetails = document.createElement("details");
      rawDetails.className = "raw-toggle";
      rawDetails.open = false;

      const rawSummary = document.createElement("summary");
      rawSummary.textContent = "Show raw JSON (SSE)";
      rawDetails.appendChild(rawSummary);

      const rawPre = document.createElement("pre");
      rawPre.textContent = JSON.stringify(item.raw, null, 2);
      rawDetails.appendChild(rawPre);

      body.appendChild(rawDetails);
    }

    details.appendChild(summary);
    details.appendChild(body);
    frag.appendChild(details);
  }

  logListEl.appendChild(frag);
}

function clearLog() {
  logItems = [];
  renderLog();
  addLogEntry({ tag: "UI", summary: "Cleared logs.", detail: "Cleared logs." });
}

// ---- API helpers ----
async function createThread() {
  const res = await fetch(`${API_BASE}/threads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ metadata: {} }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`thread create failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  if (!data?.thread_id) throw new Error("thread create response has no thread_id");
  return data.thread_id;
}

/**
 * `start` creates a new thread (to avoid state bleed)
 * `resume` reuses an existing thread (to continue HITL)
 */
async function ensureThreadIdFromServer({ forceNew } = { forceNew: false }) {
  if (!forceNew && threadId) return threadId;

  const id = await createThread();
  threadId = id;
  persistThreadId(threadId);
  addLogEntry({ tag: "THREAD", summary: `Created: thread_id=${threadId}`, detail: `Created: thread_id=${threadId}` });
  return threadId;
}

async function getThread(tid) {
  const res = await fetch(`${API_BASE}/threads/${tid}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`get thread failed: ${res.status} ${text}`);
  }
  return await res.json();
}

/**
 * Interrupt payload location can vary, so search multiple candidates:
 * - obj.__interrupt__
 * - obj.values.__interrupt__
 * - obj.interrupts
 * - obj.values.interrupts
 */
function extractInterruptPayload(obj) {
  if (!obj) return null;

  const candidates = [
    obj.__interrupt__,
    obj?.values?.__interrupt__,
    obj?.interrupts,
    obj?.values?.interrupts,
  ].filter(Boolean);

  for (const c of candidates) {
    const first = Array.isArray(c) ? c[0] : c;
    if (!first) continue;

    const payload = first?.value ?? first;
    if (!payload) continue;

    // Accept if it looks like an approval request
    if (payload.kind === "approval_request" || payload.question || payload.analysis_preview) {
      return payload;
    }
  }

  // Fallback: status might be "interrupted" without payload
  if (String(obj.status || "") === "interrupted") {
    return { kind: "approval_request", question: "Approve?", options: ["y", "retry", "n"], analysis_preview: [] };
  }

  return null;
}

function extractFinalReportFromThread(threadObj) {
  const values = threadObj?.values;
  if (!values) return "";
  if (typeof values.final_report === "string" && values.final_report.trim()) {
    return values.final_report;
  }
  return "";
}

function extractCurrentStepFromThread(threadObj) {
  const values = threadObj?.values;
  if (!values) return "";
  return String(values.current_step || "");
}

// Parse SSE frames (event/data format)
function parseSseFrame(frameText) {
  const normalized = frameText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let eventName = "";
  const dataLines = [];
  let id = "";

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(":")) continue; // comment line
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }

  const dataRaw = dataLines.join("\n");
  let data = dataRaw;
  if (dataRaw) {
    try { data = JSON.parse(dataRaw); } catch { /* keep raw */ }
  }
  return { id, event: eventName, data };
}

// Call runs/stream (POST and receive SSE)
async function runStream({ tid, body, onEvent }) {
  // Cancel existing stream if any
  if (currentController) {
    try { currentController.abort(); } catch {}
  }
  const controller = new AbortController();
  currentController = controller;

  let eventCount = 0;

  const res = await fetch(`${API_BASE}/threads/${tid}/runs/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`runs/stream failed: ${res.status} ${text}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (SHOW_NOISY_SSE) {
    addLogEntry({
      tag: "HTTP",
      summary: `runs/stream content-type=${contentType}`,
      detail: `runs/stream content-type=${contentType}`,
    });
  } else {
    // If you'd rather store it in status only, you can do it here:
    // setStatus({ ... , http: { contentType } });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let sepIndex;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sepIndex).trim();
        buffer = buffer.slice(sepIndex + 2);

        if (!frame) continue;

        const ev = parseSseFrame(frame);
        eventCount += 1;
        onEvent?.(ev);
      }
    }
  } finally {
    if (currentController === controller) currentController = null;
  }

  if (eventCount === 0) {
    addLogEntry({
      tag: "WARN",
      summary: "No SSE events were received.",
      detail: "No SSE events were received. The server may not be emitting SSE, buffering may be occurring, or a proxy could be interfering.",
    });
  }
}

// ---- SSE interpretation helpers ----
function pickNodeKeyFromUpdates(obj) {
  if (!obj || typeof obj !== "object") return "";
  const u = (obj.updates && typeof obj.updates === "object") ? obj.updates : obj;
  if (!u || typeof u !== "object") return "";

  for (const k of Object.keys(u)) {
    if (NODE_LABEL[k]) return k;
  }
  return "";
}

/**
 * Extract current_step from updates
 * Example: {"research_start":{"current_step":"research_agent"}}
 */
function pickCurrentStepFromUpdates(obj) {
  if (!obj || typeof obj !== "object") return "";
  const u = (obj.updates && typeof obj.updates === "object") ? obj.updates : obj;
  if (!u || typeof u !== "object") return "";

  for (const k of Object.keys(u)) {
    const v = u[k];
    if (v && typeof v === "object" && typeof v.current_step === "string" && v.current_step.trim()) {
      return v.current_step.trim();
    }
  }
  return "";
}

function extractReadableOutputFromNodeState(nodeState) {
  if (!nodeState || typeof nodeState !== "object") return "";

  if (typeof nodeState.final_report === "string" && nodeState.final_report.trim()) {
    return nodeState.final_report;
  }

  const keys = ["analysis_messages", "research_messages"];
  for (const key of keys) {
    const arr = nodeState[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const last = arr[arr.length - 1];
      const content = last?.content ?? last?.text ?? last?.message ?? last;
      if (typeof content === "string") return content;
      try { return JSON.stringify(content, null, 2); } catch { return String(content); }
    }
  }

  try { return JSON.stringify(nodeState, null, 2); } catch { return String(nodeState); }
}

function showApprovalIfNeeded(payload) {
  if (!payload) return;
  if (uiState === "waiting_approval") return;

  setUiState("waiting_approval");
  show(approvalCard);

  questionEl.textContent = payload.question || "Approve?";
  renderPreview(payload.analysis_preview || []);

  addLogEntry({
    tag: "HITL",
    agent: NODE_LABEL.human_approval,
    summary: "Awaiting approval (user input required).",
    detail: JSON.stringify(payload, null, 2),
    raw: payload,
  });
}

function handleSseEvent(ev) {
  const raw = ev?.data;
  const eventName = ev?.event || "";

  setStatus({ last_event: ev, thread_id: threadId });

  // If we can detect interrupt in SSE, reflect it first (preview appears here)
  if (raw && typeof raw === "object") {
    const interruptPayload = extractInterruptPayload(raw);
    if (interruptPayload) {
      showApprovalIfNeeded(interruptPayload);
      // Typically execution stops at interrupt, so return here
      return;
    }
  }

  // Suppress noisy metadata/keepalive events
  if (!SHOW_NOISY_SSE && (eventName === "metadata" || eventName === "ping" || eventName === "keepalive")) {
    return;
  }

  // If values.current_step exists, apply it with highest priority
  if (raw && typeof raw === "object") {
    const valuesObj = raw.values && typeof raw.values === "object" ? raw.values : null;
    const step = valuesObj?.current_step ? String(valuesObj.current_step) : "";
    if (step) setWork(step);
  }

  // updates: pick up current_step from "start marker", update work badge, and avoid raw SSE logs
  if (eventName === "updates" && raw && typeof raw === "object") {
    const stepFromUpdates = pickCurrentStepFromUpdates(raw);
    if (stepFromUpdates) {
      setWork(stepFromUpdates);
      return;
    }
  }

  // updates: readable "result" log entries
  if (eventName === "updates") {
    const nodeKey = pickNodeKeyFromUpdates(raw);
    if (nodeKey) {
      const u = raw.updates && typeof raw.updates === "object" ? raw.updates : raw;
      const nodeState = u[nodeKey];
      const text = extractReadableOutputFromNodeState(nodeState || {});
      addLogEntry({
        tag: "AGENT",
        agent: NODE_LABEL[nodeKey] || nodeKey,
        summary: truncate(text, 140) || "(updated)",
        detail: text || "(updated)",
        raw,
      });
      return;
    }

    // If we can't identify the node key, treat as noise unless debugging
    if (!SHOW_NOISY_SSE) return;
  }

  // values: lightweight state-change logs (centered on current_step)
  if (eventName === "values") {
    const current = raw?.values?.current_step ? String(raw.values.current_step) : "";
    if (current) {
      addLogEntry({
        tag: "STATE",
        agent: NODE_LABEL[current] || current,
        summary: "State updated (values).",
        detail: JSON.stringify(raw?.values ?? raw, null, 2),
        raw,
      });
      return;
    }

    // values without current_step are usually noise
    if (!SHOW_NOISY_SSE) return;

    addLogEntry({
      tag: "STATE",
      summary: "State updated (values).",
      detail: JSON.stringify(raw, null, 2),
      raw,
    });
    return;
  }

  // Below: only log raw SSE when truly needed
  const isEmpty =
    raw == null ||
    raw === "" ||
    (typeof raw === "string" && raw.trim() === "");

  if (!SHOW_NOISY_SSE) {
    if (!eventName || isEmpty) return;
    return;
  }

  const asText = (typeof raw === "string")
    ? raw
    : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })();

  addLogEntry({
    tag: eventName ? `SSE:${eventName}` : "SSE",
    summary: truncate(asText, 140) || "(SSE)",
    detail: (typeof raw === "string") ? raw : JSON.stringify(raw, null, 2),
    raw: (raw && typeof raw === "object") ? raw : null,
  });
}

// ---- app logic ----
function themeValue() { return themeEl.value.trim() || "Space debris removal service"; }

function resetViewForRun() {
  setError("");
  hide(approvalCard);
  hide(reportCard);
  show(statusCard);
}

function cancelInFlight() {
  if (!currentController) return;
  addLogEntry({ tag: "UI", summary: "User canceled the stream.", detail: "User canceled the stream." });
  try { currentController.abort(); } catch {}
}

async function start() {
  resetViewForRun();

  const theme = themeValue();
  persistTheme(theme);

  const tid = await ensureThreadIdFromServer({ forceNew: true });
  setWork("-");

  setUiState("starting");
  setStatus({ step: "start", theme, thread_id: tid, api_base: API_BASE, assistant_id: ASSISTANT_ID });
  addLogEntry({ tag: "START", summary: `Started: "${theme}"`, detail: `Started: "${theme}" / thread_id=${tid}` });

  await runStream({
    tid,
    body: {
      assistant_id: ASSISTANT_ID,
      input: {
        research_messages: [{ type: "human", content: `Topic: ${theme}` }],
        analysis_messages: [],
        loop_count: 0,
        current_step: "start",
        approval_decision: "",
        final_report: "",
      },
      stream_mode: ["updates", "values"],
      on_disconnect: "cancel",
    },
    onEvent: (ev) => handleSseEvent(ev),
  });

  const threadObj = await getThread(tid);

  const payload = extractInterruptPayload(threadObj);
  const currentStep = extractCurrentStepFromThread(threadObj);
  if (currentStep) setWork(currentStep);

  if (payload) {
    showApprovalIfNeeded(payload);
    setStatus({ thread: threadObj, thread_id: tid });
    return;
  }

  const report = extractFinalReportFromThread(threadObj);
  if (!report) {
    setUiState("done");
    show(reportCard);
    reportEl.textContent = "(The final report has not been generated yet. If you were not prompted for approval, check the server logs.)";
    setStatus({ thread: threadObj, thread_id: tid });
    addLogEntry({ tag: "DONE", summary: "Done (no final report)", detail: "Done (no final report)" });
    return;
  }

  setUiState("done");
  show(reportCard);
  reportEl.textContent = report;
  setStatus({ thread: threadObj, thread_id: tid });
  addLogEntry({ tag: "DONE", summary: "Done (final report generated)", detail: "Done (final report generated)" });
}

async function resume(decision) {
  resetViewForRun();

  const tid = await ensureThreadIdFromServer({ forceNew: false });

  setUiState("resuming");
  setStatus({ step: "resume", decision, thread_id: tid, api_base: API_BASE, assistant_id: ASSISTANT_ID });
  addLogEntry({ tag: "RESUME", summary: `Input: ${decision}`, detail: `Input: ${decision} / thread_id=${tid}` });

  await runStream({
    tid,
    body: {
      assistant_id: ASSISTANT_ID,
      command: { resume: decision },
      stream_mode: ["updates", "values"],
      on_disconnect: "cancel",
    },
    onEvent: (ev) => handleSseEvent(ev),
  });

  const threadObj = await getThread(tid);

  const payload = extractInterruptPayload(threadObj);
  const currentStep = extractCurrentStepFromThread(threadObj);
  if (currentStep) setWork(currentStep);

  if (payload) {
    showApprovalIfNeeded(payload);
    setStatus({ thread: threadObj, thread_id: tid });
    return;
  }

  const report = extractFinalReportFromThread(threadObj);
  if (!report) {
    setUiState("done");
    show(reportCard);
    reportEl.textContent = "(The final report has not been generated yet.)";
    setStatus({ thread: threadObj, thread_id: tid });
    addLogEntry({ tag: "DONE", summary: "Done (no final report)", detail: "Done (no final report)" });
    return;
  }

  setUiState("done");
  show(reportCard);
  reportEl.textContent = report;
  setStatus({ thread: threadObj, thread_id: tid });
  addLogEntry({ tag: "DONE", summary: "Done (final report generated)", detail: "Done (final report generated)" });
}

async function runWithUi(fn) {
  try {
    setError("");
    await fn();
  } catch (e) {
    setUiState("error");
    const msg = String(e?.message || e);
    setError(msg);
    setStatus({ error: msg, uiState, thread_id: threadId ?? null, api_base: API_BASE, assistant_id: ASSISTANT_ID });
    addLogEntry({ tag: "ERROR", summary: msg, detail: msg });
  }
}

function handleDecision(decision) {
  approveBtn.disabled = true;
  retryBtn.disabled = true;
  rejectBtn.disabled = true;
  startBtn.disabled = true;
  clearBtn.disabled = true;

  setUiState("resuming");
  runWithUi(() => resume(decision));
}

// ---- copy / download ----
function copyReport() {
  const text = reportEl.textContent || "";
  if (!text) {
    addLogEntry({ tag: "UI", summary: "There is no report text to copy.", detail: "There is no report text to copy." });
    return;
  }

  navigator.clipboard?.writeText(text)
    .then(() => {
      setError("");
      addLogEntry({ tag: "UI", summary: "Copied the report.", detail: "Copied the report to the clipboard." });
    })
    .catch(() => {
      setError("Copy failed (check your browser permissions).");
      addLogEntry({ tag: "ERROR", summary: "Copy failed.", detail: "Copy failed." });
    });
}

function sanitizeFilename(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function downloadReport() {
  const text = reportEl.textContent || "";
  if (!text) {
    addLogEntry({ tag: "UI", summary: "There is no report text to download.", detail: "There is no report text to download." });
    return;
  }

  const theme = sanitizeFilename(themeValue());
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");

  const filename = `business_plan_${yyyy}${mm}${dd}_${hh}${mi}_${theme || "topic"}.txt`;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  addLogEntry({ tag: "UI", summary: `Downloaded: ${filename}`, detail: `Downloaded the report: ${filename}` });
}

// ---- clear / init ----
function clearAll() {
  themeEl.value = "";
  persistTheme("");
  threadId = null;
  clearThreadId();

  hide(approvalCard);
  hide(reportCard);
  hide(statusCard);

  setError("");
  setUiState("idle");
  setWork("-");
  statusEl.textContent = "";
  logItems = [];
  renderLog();
}

async function initAsync() {
  restoreTheme();

  setUiState("idle");
  setWork("-");
  renderLog();
  addLogEntry({ tag: "UI", summary: `App loaded. API: ${API_BASE}`, detail: `App loaded. API: ${API_BASE}` });

  const savedTid = restoreThreadId();
  if (!savedTid) return;

  try {
    const t = await getThread(savedTid);
    const payload = extractInterruptPayload(t);
    const currentStep = extractCurrentStepFromThread(t);
    if (currentStep) setWork(currentStep);

    if (payload) {
      threadId = savedTid;
      addLogEntry({ tag: "UI", summary: `Restored: awaiting approval (thread_id=${threadId})`, detail: `Restored: awaiting approval (thread_id=${threadId})` });
      setUiState("waiting_approval");
      show(approvalCard);
      questionEl.textContent = payload.question || "Approve?";
      renderPreview(payload.analysis_preview || []);
      setStatus({ thread: t, thread_id: threadId });
    } else {
      clearThreadId();
      addLogEntry({ tag: "UI", summary: "Discarded previous thread (not awaiting approval).", detail: `Discarded previous thread (not awaiting approval): thread_id=${savedTid}` });
    }
  } catch (e) {
    clearThreadId();
    addLogEntry({ tag: "WARN", summary: "Failed to verify saved thread → discarded.", detail: `Failed to verify saved thread, so it was discarded: ${String(e?.message || e)}` });
  }
}

// ---- Events ----
startBtn.addEventListener("click", () => runWithUi(start));
clearBtn.addEventListener("click", clearAll);
clearLogBtn.addEventListener("click", clearLog);
cancelBtn.addEventListener("click", cancelInFlight);

approveBtn.addEventListener("click", () => handleDecision("y"));
retryBtn.addEventListener("click", () => handleDecision("retry"));
rejectBtn.addEventListener("click", () => handleDecision("n"));

copyBtn.addEventListener("click", copyReport);
downloadBtn.addEventListener("click", downloadReport);

// Run on Enter (ignore while IME composition is active)
themeEl.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    if (!startBtn.disabled) runWithUi(start);
  }
});

initAsync();