// Factory desk. The packaged desktop has no factory screen. This page is
// served by the local app and linked from its own index.html. It does not
// carry a desktop or paired credential: the desktop window adds its mutation
// header to requests it makes, and a paired admin session uses its own cookie
// or bearer. Any other caller is still rejected by request auth.
export const FACTORY_DESK_PATH = "/api/factory/desk";

const LINK = `<a href="${FACTORY_DESK_PATH}" data-factory-desk="1" style="position:fixed;right:12px;bottom:12px;z-index:80;background:#1c1917;color:#fafaf9;font:600 12px/1 system-ui,sans-serif;padding:8px 12px;border-radius:999px;text-decoration:none">Factory desk</a>`;

/** Insert the desk link into the app's own page. Leaves any other HTML alone
 * when the link is already there. */
export function appendFactoryDeskLink(html: string): string {
  if (html.includes("data-factory-desk=\"1\"") || html.includes(FACTORY_DESK_PATH)) return html;
  if (html.includes("</body>")) return html.replace("</body>", `${LINK}</body>`);
  return `${html}${LINK}`;
}

export const FACTORY_DESK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Factory desk</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px auto; max-width: 880px; color: #1c1917; background: #fafaf9; }
  h1 { font-size: 20px; }
  p.note { background: #fff7ed; border: 1px solid #fed7aa; padding: 10px 12px; border-radius: 8px; }
  label { display: block; margin: 8px 0 2px; font-weight: 600; }
  input, textarea, select, button { font: inherit; }
  input, textarea, select { width: 100%; box-sizing: border-box; padding: 6px 8px; }
  textarea { min-height: 64px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  button { padding: 6px 10px; }
  pre { white-space: pre-wrap; background: #fff; border: 1px solid #e7e5e4; padding: 12px; border-radius: 8px; }
  a.back { color: #1c1917; }
</style>
</head>
<body>
<p><a class="back" href="/">Back to OpenMausBot</a></p>
<h1>Factory desk</h1>
<p class="note">Open this page from the OpenMausBot desktop window (the Factory desk link on the main page, or this address in that same window). This page does not attach a desktop token. Creating or advancing a task from any other caller is rejected. Permissions stay Auto. The model stays claude-opus-5-5. Nothing here merges, deploys, or edits the task store by hand.</p>
<label for="specialist">Specialist</label>
<select id="specialist">
  <option value="07169dc6-72c2-4c7c-b3b3-62d9122aa46b">Codebase Navigator</option>
  <option value="063c67ac-f8ca-4c05-b6b8-e3bbf2e102a7" selected>Software Implementer</option>
  <option value="1872d149-0be3-42c6-9218-3ea7d56609a4">Security and Privacy Reviewer</option>
  <option value="7c8f2e77-2ad9-4c40-a623-4825528eefcd">UI and Accessibility Reviewer</option>
  <option value="a6677c84-0c2d-41fa-bd76-fbb4c12859f7">Game and Interaction Reviewer</option>
  <option value="223e5e26-37e4-42e3-9026-5983b66a17aa">Independent QA</option>
  <option value="bb034770-3b5a-44de-9ffe-1d851a093afe">Release Readiness Reviewer</option>
</select>
<label for="objective">Objective</label>
<textarea id="objective"></textarea>
<label for="repo">Repo path</label>
<input id="repo" />
<label for="baseSha">Base SHA (40 hex)</label>
<input id="baseSha" spellcheck="false" />
<label for="headSha">Exact head SHA (QA-only review, 40 hex)</label>
<input id="headSha" spellcheck="false" />
<label for="prUrl">Pull request URL (optional, QA-only)</label>
<input id="prUrl" spellcheck="false" placeholder="https://github.com/owner/repo/pull/1" />
<label for="acceptance">Acceptance</label>
<textarea id="acceptance"></textarea>
<label for="owner">Owner</label>
<input id="owner" />
<label for="authority">Authority</label>
<input id="authority" />
<label for="evidence">Required evidence (comma separated)</label>
<input id="evidence" value="commit" />
<label for="dispatchKey">Dispatch key (optional, idempotency)</label>
<input id="dispatchKey" />
<div class="row">
  <button type="button" id="create">Create task</button>
  <button type="button" id="refresh">Refresh tasks</button>
</div>
<label for="taskId">Task</label>
<select id="taskId"></select>
<label for="handoffId">Queued handoff id</label>
<input id="handoffId" spellcheck="false" />
<label for="resultSha">Harvest result SHA (deliberately wrong to record a rejection)</label>
<input id="resultSha" spellcheck="false" />
<label for="harvestNote">Harvest evidence note</label>
<input id="harvestNote" value="disposable scratch harvest" />
<label for="waitStatus">Wait status</label>
<input id="waitStatus" value="waiting_qa" />
<div class="row">
  <button type="button" id="launch">Launch</button>
  <button type="button" id="harvest">Harvest</button>
  <button type="button" id="deliver">Deliver</button>
  <button type="button" id="wait">Wait</button>
  <button type="button" id="ship">Ship gate</button>
  <button type="button" id="cancel">Cancel</button>
</div>
<pre id="out">No request yet.</pre>
<script>
const out = document.getElementById("out");
const taskSelect = document.getElementById("taskId");
let tasks = [];
function selected() { return tasks.find((task) => task.id === taskSelect.value) || null; }
function show(status, body) { out.textContent = status + "\\n" + JSON.stringify(body, null, 2); }
async function call(method, path, body) {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  show(res.status + " " + method + " " + path, parsed);
  return res.ok;
}
function fillTasks(list) {
  tasks = Array.isArray(list) ? list : [];
  const current = taskSelect.value;
  taskSelect.replaceChildren();
  for (const task of tasks) {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = task.id + " " + (task.state || "") + " " + (task.role || "");
    taskSelect.appendChild(option);
  }
  if (current) taskSelect.value = current;
}
async function refresh() {
  const res = await fetch("/api/factory/tasks");
  const body = await res.json();
  fillTasks(body.tasks);
  show(res.status + " GET /api/factory/tasks", body);
}
document.getElementById("refresh").onclick = () => refresh().catch((error) => show(0, String(error)));
document.getElementById("create").onclick = async () => {
  const requiredEvidence = document.getElementById("evidence").value.split(",").map((item) => item.trim()).filter(Boolean);
  const dispatchKey = document.getElementById("dispatchKey").value.trim();
  const body = {
    specialistId: document.getElementById("specialist").value,
    model: "claude-opus-5-5",
    permissions: "auto",
    objective: document.getElementById("objective").value,
    repo: document.getElementById("repo").value,
    baseSha: document.getElementById("baseSha").value.trim(),
    acceptance: document.getElementById("acceptance").value,
    owner: document.getElementById("owner").value,
    authority: document.getElementById("authority").value,
    requiredEvidence,
    dependencies: [],
  };
  if (dispatchKey) body.dispatchKey = dispatchKey;
  const headSha = document.getElementById("headSha").value.trim();
  const prUrl = document.getElementById("prUrl").value.trim();
  if (headSha) body.headSha = headSha;
  if (prUrl) body.prUrl = prUrl;
  if (await call("POST", "/api/factory/tasks", body)) await refresh();
};
async function postSelected(suffix, body) {
  const task = selected();
  if (!task) { show(0, "Select a task first."); return; }
  if (await call("POST", "/api/factory/tasks/" + task.id + suffix, body)) await refresh();
}
document.getElementById("launch").onclick = () => postSelected("/launch");
document.getElementById("deliver").onclick = () => {
  const handoffId = document.getElementById("handoffId").value.trim();
  postSelected("/deliver", handoffId ? { handoffId } : {});
};
document.getElementById("cancel").onclick = () => postSelected("/cancel");
document.getElementById("wait").onclick = () => postSelected("/wait", { status: document.getElementById("waitStatus").value.trim() });
document.getElementById("ship").onclick = () => postSelected("/ship", {});
document.getElementById("harvest").onclick = () => {
  const task = selected();
  if (!task) { show(0, "Select a task first."); return; }
  const binding = task.binding || {};
  postSelected("/harvest", {
    sessionId: binding.sessionId,
    worktree: binding.worktree,
    resultSha: document.getElementById("resultSha").value.trim(),
    evidence: [{ kind: "note", ref: document.getElementById("resultSha").value.trim() || "none", note: document.getElementById("harvestNote").value }],
  });
};
refresh().catch((error) => show(0, String(error)));
</script>
</body>
</html>
`;
