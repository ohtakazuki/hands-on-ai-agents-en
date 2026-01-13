const API_BASE = "http://localhost:8000";
const INVOKE_URL = `${API_BASE}/agent/invoke`;

/**
 * ✅ Important:
 * fetch does not time out by default.
 * - 0: disable auto-timeout (recommended)
 * - e.g.) if you want 10 minutes, use 600_000
 */
const REQUEST_TIMEOUT_MS = 0;

// Max number of log items (newest at top)
const MAX_LOG_ITEMS = 80;

// Hold the thread ID on the frontend first (makes resuming after interruption easier)
const THREAD_ID_KEY = "agent_thread_id";

let threadId = null;
let uiState = "idle"; // idle | starting | waiting_approval | resuming | done | error
let logItems = [];   // [{timeISO, tag, message}]

// Mechanism to handle Abort with reasons
let currentController = null;
const abortReasons = new WeakMap(); // AbortController -> "timeout" | "user" | "superseded"

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
  const labelMap = {
    idle: "Idle",
    starting: "Running (researching…)",
    waiting_approval: "Awaiting approval (HITL input required)",
    resuming: "Generating report (analyzing…)",
    done: "Completed",
    error: "Error",
  };
  stateBadge.textContent = labelMap[state] || state;
  stateBadge.dataset.state = state;
}

function setUiState(state) {
  uiState = state;
  setBadge(state);

  const busy = (state === "starting" || state === "resuming");
  const waiting = (state === "waiting_approval");

  startBtn.disabled = busy;
  clearBtn.disabled = busy;

  approveBtn.disabled = !waiting;
  retryBtn.disabled = !waiting;
  rejectBtn.disabled = !waiting;

  if (busy) show(spinnerEl);
  else hide(spinnerEl);

  // ✅ Show the “Cancel” button only while busy (abort only when the user explicitly wants it)
  if (busy) show(cancelBtn);
  else hide(cancelBtn);

  // Auto-collapse “Details (JSON)” when waiting for approval
  if (waiting) statusDetails.open = false;
  else if (state === "idle") statusDetails.open = false;
  else statusDetails.open = true;
}

function setStatus(obj) {
  show(statusCard);
  statusEl.textContent = JSON.stringify(obj, null, 2);
}

function renderPreview(analysisPreview) {
  previewEl.innerHTML = "";
  const frag = document.createDocumentFragment();

  (analysisPreview || []).forEach((x) => {
    const div = document.createElement("div");
    div.className = "item";

    const title = document.createElement("strong");
    title.textContent = String(x.type || "Message");

    const pre = document.createElement("pre");
    pre.textContent = String(x.content || "");

    div.appendChild(title);
    div.appendChild(pre);
    frag.appendChild(div);
  });

  previewEl.appendChild(frag);
}

function restoreTheme() {
  const saved = localStorage.getItem("agent_theme");
  if (saved) themeEl.value = saved;
}

function persistTheme(value) {
  localStorage.setItem("agent_theme", value);
}

function restoreThreadId() {
  const saved = localStorage.getItem(THREAD_ID_KEY);
  if (saved) return saved;
  return null;
}

function persistThreadId(id) {
  localStorage.setItem(THREAD_ID_KEY, id);
}

function clearThreadId() {
  localStorage.removeItem(THREAD_ID_KEY);
}

function ensureThreadId() {
  if (threadId) return threadId;
  const id = (crypto?.randomUUID ? crypto.randomUUID() : `tid_${Math.random().toString(16).slice(2)}_${Date.now()}`);
  threadId = id;
  persistThreadId(id);
  return id;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function nowISO() {
  return new Date().toISOString();
}

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

function addLog(tag, message) {
  logItems.unshift({ timeISO: nowISO(), tag: String(tag), message: String(message) });
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
    const wrap = document.createElement("div");
    wrap.className = "log-item";

    const top = document.createElement("div");
    top.className = "log-top";

    const tag = document.createElement("span");
    tag.className = "log-tag";
    tag.textContent = item.tag;

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = fmtLocalTime(item.timeISO);

    top.appendChild(tag);
    top.appendChild(time);

    const msg = document.createElement("p");
    msg.className = "log-msg";
    msg.textContent = item.message;

    wrap.appendChild(top);
    wrap.appendChild(msg);
    frag.appendChild(wrap);
  }

  logListEl.appendChild(frag);
}

function clearLog() {
  logItems = [];
  renderLog();
  addLog("UI", "Cleared the log.");
}

function abortController(controller, reason) {
  if (!controller) return;
  abortReasons.set(controller, reason);
  try { controller.abort(); } catch {}
}

async function callInvoke(input) {
  // Abort the previous request when a new one comes in (prevent duplicate operations)
  if (currentController) abortController(currentController, "superseded");

  const controller = new AbortController();
  currentController = controller;

  let timeoutId = null;
  if (REQUEST_TIMEOUT_MS && REQUEST_TIMEOUT_MS > 0) {
    timeoutId = setTimeout(() => abortController(controller, "timeout"), REQUEST_TIMEOUT_MS);
  }

  try {
    const res = await fetch(INVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      const maybe = safeJsonParse(text);
      throw new Error(maybe?.detail || `API error: ${res.status} ${text}`);
    }

    return res.json();
  } catch (e) {
    if (e?.name === "AbortError") {
      const reason = abortReasons.get(controller);
      if (reason === "timeout") {
        throw new Error("Request aborted due to a frontend timeout. Increase or disable REQUEST_TIMEOUT_MS.");
      }
      if (reason === "user") {
        throw new Error("Request aborted by the user.");
      }
      if (reason === "superseded") {
        throw new Error("Previous request aborted (a newer action took precedence).");
      }
      throw new Error("Request was aborted.");
    }
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (currentController === controller) currentController = null;
  }
}

function themeValue() {
  return themeEl.value.trim() || "Space debris removal business";
}

function resetViewForRun() {
  setError("");
  hide(approvalCard);
  hide(reportCard);
  show(statusCard);
}

function summarizeOutput(out) {
  const st = out?.status ? `status=${out.status}` : "status=?";
  const tid = out?.thread_id ? `thread_id=${out.thread_id}` : (threadId ? `thread_id=${threadId}` : "");
  const extra = (tid ? ` / ${tid}` : "");
  return `${st}${extra}`;
}

async function start() {
  resetViewForRun();

  const theme = themeValue();
  persistTheme(theme);

  // Decide thread_id first and send it (keep the same ID even if interrupted)
  const tid = ensureThreadId();

  setUiState("starting");
  setStatus({ step: "start", theme, thread_id: tid });
  addLog("START", `Started: "${theme}" / thread_id=${tid}`);

  const data = await callInvoke({ action: "start", theme, thread_id: tid });
  const out = data.output;

  // Treat the server-returned thread_id as canonical (should match in most cases)
  if (out?.thread_id) {
    threadId = out.thread_id;
    persistThreadId(threadId);
  }

  setStatus(out);
  addLog("API", `start response: ${summarizeOutput(out)}`);

  if (out.status === "interrupted") {
    setUiState("waiting_approval");
    show(approvalCard);
    questionEl.textContent = out.interrupt?.question || "Do you approve?";
    renderPreview(out.interrupt?.analysis_preview || []);
    addLog("HITL", "Waiting for approval (please respond using the buttons).");
    return;
  }

  hide(approvalCard);

  if (out.status === "completed") {
    setUiState("done");
    show(reportCard);
    reportEl.textContent = out.report || "";
    addLog("DONE", "Completed (report generated).");
    return;
  }

  setUiState("error");
  setError("Unexpected response format. Please check the 'status' field.");
  addLog("ERROR", "Unexpected response format (start).");
}

async function resume(decision) {
  resetViewForRun();

  const tid = threadId || ensureThreadId();
  if (!tid) {
    setUiState("error");
    setError("Missing thread_id. Click 'Run' first.");
    addLog("ERROR", "Cannot resume because thread_id is missing.");
    return;
  }

  setUiState("resuming");
  setStatus({ step: "resume", decision, thread_id: tid });
  addLog("RESUME", `Input: ${decision} / thread_id=${tid}`);

  const data = await callInvoke({ action: "resume", thread_id: tid, decision });
  const out = data.output;

  if (out?.thread_id) {
    threadId = out.thread_id;
    persistThreadId(threadId);
  }

  setStatus(out);
  addLog("API", `resume response: ${summarizeOutput(out)}`);

  if (out.status === "interrupted") {
    setUiState("waiting_approval");
    show(approvalCard);
    questionEl.textContent = out.interrupt?.question || "Do you approve?";
    renderPreview(out.interrupt?.analysis_preview || []);
    addLog("HITL", "Waiting for approval again.");
    return;
  }

  hide(approvalCard);

  if (out.status === "completed") {
    setUiState("done");
    show(reportCard);
    reportEl.textContent = out.report || "";
    addLog("DONE", "Completed (report generated).");
    return;
  }

  setUiState("error");
  setError("Unexpected response format. Please check the 'status' field.");
  addLog("ERROR", "Unexpected response format (resume).");
}

async function runWithUi(fn) {
  try {
    setError("");
    await fn();
  } catch (e) {
    setUiState("error");
    const msg = String(e?.message || e);
    setError(msg);
    setStatus({ error: msg, uiState, thread_id: threadId ?? null });
    addLog("ERROR", msg);
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

function cancelInFlight() {
  if (!currentController) return;
  addLog("UI", "User aborted the request.");
  abortController(currentController, "user");
}

function copyReport() {
  const text = reportEl.textContent || "";
  if (!text) {
    addLog("UI", "There is no report text to copy.");
    return;
  }

  navigator.clipboard?.writeText(text)
    .then(() => {
      setError("");
      addLog("UI", "Copied the report to the clipboard.");
    })
    .catch(() => {
      setError("Copy failed (please check browser permissions).");
      addLog("ERROR", "Copy failed.");
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
    addLog("UI", "There is no report text to download.");
    return;
  }

  const theme = sanitizeFilename(themeValue());
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");

  const filename = `business_plan_${yyyy}${mm}${dd}_${hh}${mi}_${theme || "theme"}.txt`;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  addLog("UI", `Downloaded report: ${filename}`);
}

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
  statusEl.textContent = "";
  logItems = [];
  renderLog();
}

function init() {
  restoreTheme();

  const savedTid = restoreThreadId();
  if (savedTid) {
    threadId = savedTid;
    addLog("UI", `Restored: thread_id=${threadId}`);
  }

  setUiState("idle");
  renderLog();
  addLog("UI", "Ready.");
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

// Run on Enter (ignore during IME composition)
themeEl.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    if (!startBtn.disabled) runWithUi(start);
  }
});

init();