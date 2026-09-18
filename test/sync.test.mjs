import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSyncRequest, parseSyncPage, syncAndWait, createTransferHandler } from "../sync.mjs";

const escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const row = (message, source = "ExecuteServiceImpl", level = "INFO", date = "18.09.2026 12:00:01") => ({ message, source, level, date });
const html = (rows, { running = false, error = false } = {}) => `<h2>Status</h2>
${running ? '<div class="note"><b>Synchronisierung l&#228;uft...</b></div>' : ""}
<h2>System-Log</h2><table>${rows.map((r) => `<tr onmouseover="change_to(this);" class="${r.level}">
<td style="white-space:nowrap;">${r.date}</td><td><pre>${r.source}</pre></td><td><pre>${escape(r.message)}</pre></td></tr>`).join("")}</table>
<div class="message"><span class="type-${error ? 1 : 0}">${error ? "Fehler" : "Synchronisierung beendet"}</span></div>`;
const old = [row("old log entry", "Other", "INFO", "18.09.2026 11:00:00")];
const start = row("synchronizing 2 backends");
const done = row("no more backends. synchronization done");
const page = (rows, options) => ({ httpStatus: 200, ...parseSyncPage(html(rows, options)) });
const baseline = page(old);

async function observe(pages, options = {}) {
  const calls = [];
  let elapsed = 0;
  const request = async (method) => {
    calls.push(method);
    const next = pages.length > 1 ? pages.shift() : pages[0];
    if (next instanceof Error) throw next;
    return next;
  };
  const result = await syncAndWait(request, baseline, {
    timeoutMs: 20, intervalMs: 5, now: () => elapsed,
    wait: async (ms) => { elapsed += ms; }, ...options,
  });
  assert.equal(calls.filter((x) => x === "POST").length, 1);
  return { result, calls };
}

test("parser recognizes real markup, escaped text and running status", () => {
  const parsed = page([row("a < b & c"), ...old], { running: true });
  assert.equal(parsed.running, true);
  assert.equal(parsed.rows[0].message, "a < b & c");
  assert.throws(() => parseSyncPage("<h1>Login</h1>"), /not recognized/);
  assert.throws(() => parseSyncPage("<h2>System-Log</h2>"), /empty/);
});

test("fresh start then fresh completion is success", async () => {
  const { result, calls } = await observe([page([start, ...old], { running: true }), page([done, start, ...old])]);
  assert.equal(result.sync_status, "completed");
  assert.equal(result.sync_triggered, true);
  assert.deepEqual(calls, ["POST", "GET"]);
});

test("fast sync completing in the POST response needs no status request", async () => {
  const { result, calls } = await observe([page([done, start, ...old])]);
  assert.equal(result.sync_status, "completed");
  assert.deepEqual(calls, ["POST"]);
});

test("stale completion/status message and idle page never count as success", async () => {
  const { result } = await observe([baseline]);
  assert.equal(result.sync_status, "unknown");
  assert.equal(result.sync_triggered, null);
});

test("completion without a fresh start is not attributed to this call", async () => {
  assert.equal((await observe([page([done, ...old])])).result.sync_status, "unknown");
});

test("in-progress sync is bounded without repeating the POST", async () => {
  const { result } = await observe([page([start, ...old], { running: true })]);
  assert.equal(result.sync_status, "unknown");
  assert.equal(result.sync_triggered, true);
});

test("HTTP 200 with already-running warning is not success", async () => {
  assert.equal((await observe([page([row("synchronization already running, cancel current run", "ExecuteServiceImpl", "WARN"), ...old])])).result.sync_status, "unknown");
});

for (const failure of [
  row("backend error", "Backend", "ERROR"),
  row("stop sync on error: false", "SynchronizeErrorMessageConsumer"),
  row("Synchronisierung abgebrochen", "StatusBarMessageConsumer"),
]) test(`failure before a completion stays failed: ${failure.message}`, async () => {
  assert.equal((await observe([page([done, failure, start, ...old])])).result.sync_status, "failed");
});

test("error status without an ERROR log row remains failed", async () => {
  assert.equal((await observe([page([start, ...old], { error: true })])).result.sync_status, "failed");
});

test("lost log buffer and multiple starts never claim success", async () => {
  assert.equal((await observe([page([done, start])])).result.sync_status, "unknown");
  assert.equal((await observe([page([done, start, done, start, ...old])])).result.sync_status, "unknown");
});

test("transport errors never repeat sync or imply that nothing happened", async () => {
  for (const pages of [[new Error("timeout")], [page([start, ...old]), new Error("disconnect")]]) {
    const { result } = await observe(pages);
    assert.equal(result.sync_status, "unknown");
    assert.notEqual(result.sync_triggered, false);
  }
});

const args = { account_id: "test", recipient_name: "Test", recipient_iban: "TEST_ONLY", amount: 1, purpose: "test", instant: true };

test("instant transfer: preflight, exactly one create, sync, final response", async () => {
  const calls = [];
  const handler = createTransferHandler({
    request: async (method) => { calls.push(method); return method === "GET" ? baseline : page([done, start, ...old]); },
    create: async (input) => { calls.push("create"); assert.equal(input.instant, true); assert.equal(input.amount, 1); return "42"; },
  });
  const result = await handler(args);
  assert.deepEqual(calls, ["GET", "create", "POST"]);
  assert.equal(result.id, "42");
  assert.equal(result.instant, true);
  assert.equal(result.sync_status, "completed");
  assert.equal(result.execution_confirmed, undefined);
  assert.match(result.next_action, /Do not poll/);
});

test("failed or busy preflight never creates a transfer", async () => {
  for (const response of [new Error("offline"), page(old, { running: true })]) {
    const handler = createTransferHandler({ request: async () => { if (response instanceof Error) throw response; return response; }, create: () => assert.fail("must not create") });
    assert.equal((await handler(args)).stored, false);
  }
});

test("ambiguous create response is not retried and does not trigger sync", async () => {
  let creates = 0, gets = 0;
  const handler = createTransferHandler({ request: async () => { gets++; return baseline; }, create: async () => { creates++; throw new Error("lost response"); } });
  const result = await handler(args);
  assert.equal(creates, 1);
  assert.equal(gets, 1);
  assert.equal(result.stored, null);
  assert.match(result.next_action, /Do not automatically repeat/);
});

test("stored transfer remains stored on observation failure; no re-creation", async () => {
  let creates = 0;
  const handler = createTransferHandler({ request: async () => baseline, create: async () => { creates++; return "7"; }, observe: async () => { throw new Error("observer failed"); } });
  const result = await handler(args);
  assert.equal(result.stored, true);
  assert.equal(result.id, "7");
  assert.equal(result.sync_status, "unknown");
  assert.equal(creates, 1);
});

test("overlapping requests in the same session do not create another transfer", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let creates = 0;
  const handler = createTransferHandler({ request: async () => baseline, create: async () => { creates++; await gate; return "1"; }, observe: async () => ({ sync_status: "completed" }) });
  const first = handler(args);
  assert.equal((await handler(args)).stored, false);
  release();
  await first;
  assert.equal(creates, 1);
});

async function stub(t, listener) {
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP adapter sends the exact POST and handles Hibiscus Latin-1", async (t) => {
  let requests = 0;
  const url = await stub(t, (req, res) => {
    requests++;
    assert.equal(req.url, "/hibiscus/");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, "Basic dGVzdA==");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      assert.equal(body, "action=execute");
      res.writeHead(200, { "Content-Type": "text/html; charset=ISO-8859-1" });
      res.end(Buffer.from(html([row("übertragen"), ...old]), "latin1"));
    });
  });
  const result = await createSyncRequest(url, "Basic dGVzdA==")("POST");
  assert.equal(result.rows[0].message, "übertragen");
  assert.equal(requests, 1);
});

test("HTTP adapter rejects redirects, errors, login pages and oversized bodies", async (t) => {
  for (const [status, body] of [[302, "redirect"], [500, "error"], [200, "login"], [200, "x".repeat(2 * 1024 * 1024 + 1)]]) {
    const url = await stub(t, (_req, res) => { res.writeHead(status); res.end(body); });
    await assert.rejects(createSyncRequest(url, "")());
  }
});

test("HTTP adapter enforces a total deadline even if the peer stays connected", async (t) => {
  const url = await stub(t, () => {});
  await assert.rejects(createSyncRequest(url, "")("GET", 20), /timed out/);
});
