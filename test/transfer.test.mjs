import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

// Entire MCP -> XML-RPC -> sync path, isolated from any real banking service.
const logRow = (message, date = "18.09.2026 12:00:01") => `<tr class="INFO"><td>${date}</td><td><pre>ExecuteServiceImpl</pre></td><td><pre>${message}</pre></td></tr>`;
const old = logRow("old entry", "18.09.2026 11:00:00");
const start = logRow("synchronizing 2 backends");
const done = logRow("no more backends. synchronization done");
const page = (rows) => `<h2>System-Log</h2><table>${rows}</table>`;

async function fixture(t, { syncError = false, rpcError = false } = {}) {
  const requests = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (part) => { body += part; });
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, body });
      assert.equal(req.headers.authorization, "Basic Zm9vYmFyOnRlc3Qtc3RvcmU=");
      if (req.url === "/xmlrpc/") {
        assert.match(body, /hibiscus\.xmlrpc\.sepaueberweisung\.create/);
        res.setHeader("Content-Type", "text/xml");
        res.end(rpcError
          ? '<?xml version="1.0"?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>1</int></value></member><member><name>faultString</name><value><string>test failure</string></value></member></struct></value></fault></methodResponse>'
          : '<?xml version="1.0"?><methodResponse><params><param><value><string>42</string></value></param></params></methodResponse>');
      } else if (req.url === "/hibiscus/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (req.method === "GET") res.end(page(old));
        else {
          assert.equal(body, "action=execute");
          if (syncError) { res.writeHead(500); res.end("test failure"); }
          else res.end(page(done + start + old));
        }
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after(() => { stub.closeAllConnections(); return new Promise((resolve) => stub.close(resolve)); });
  const client = new Client({ name: "transfer-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server.mjs", import.meta.url))],
    env: {
      HIBISCUS_MCP_REQUEST_BEARER: "test-gateway",
      HIBISCUS_MCP_GATEWAY: "test-gateway",
      HIBISCUS_STORE_PASSWORD: "test-store",
      HIBISCUS_MCP_UPSTREAM_URL: `http://127.0.0.1:${stub.address().port}`,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, requests };
}

const args = { account_id: "test-account", recipient_name: "TEST ONLY", recipient_iban: "DE00000000000000000000", amount: 1, purpose: "stub only", instant: true };

test("real MCP protocol maps instant=true and returns sync completion without follow-up tools", async (t) => {
  const { client, requests } = await fixture(t);
  const catalog = await client.listTools();
  assert.equal(requests.length, 0);
  assert.match(catalog.tools.find((tool) => tool.name === "create_transfer").description, /do not poll/);
  const result = await client.callTool({ name: "create_transfer", arguments: args });
  assert.notEqual(result.isError, true);
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.sync_status, "completed");
  assert.equal(response.id, "42");
  assert.equal(response.instant, true);
  assert.equal(response.execution_confirmed, undefined);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ["GET /hibiscus/", "POST /xmlrpc/", "POST /hibiscus/"]);
  assert.match(requests[1].body, /<name>instantpayment<\/name><value><boolean>1<\/boolean>/);
  assert.match(requests[1].body, /<name>betrag<\/name><value><int>1<\/int>/);
});

test("failed sync reports a stored transfer without another RPC create", async (t) => {
  const { client, requests } = await fixture(t, { syncError: true });
  const response = JSON.parse((await client.callTool({ name: "create_transfer", arguments: args })).content[0].text);
  assert.equal(response.stored, true);
  assert.equal(response.sync_status, "unknown");
  assert.equal(requests.length, 3);
});

test("RPC failure never triggers sync or retries creation", async (t) => {
  const { client, requests } = await fixture(t, { rpcError: true });
  const response = JSON.parse((await client.callTool({ name: "create_transfer", arguments: args })).content[0].text);
  assert.equal(response.stored, null);
  assert.equal(response.sync_status, "not_started");
  assert.equal(requests.length, 2);
});

test("invalid transfer arguments cause no upstream call", async (t) => {
  const { client, requests } = await fixture(t);
  const result = await client.callTool({ name: "create_transfer", arguments: { ...args, amount: -1 } });
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0);
});
