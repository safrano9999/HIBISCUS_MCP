// Validate our auth patch against a dummy backend, never an application service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(process.argv[2]);
const tokenEnv = process.argv[3];
if (process.argv[4] === '--backend') {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'auth-probe', version: '1' } }
      : { tools: [{ name: process.env[tokenEnv] || 'missing-bearer', inputSchema: { type: 'object' } }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  }
} else {
  const { RetainedChildren } = await import(pathToFileURL(`${root}/dist/lib/retainedChildren.js`));
  const retained = new RetainedChildren({ idleMs: 10000, limit: 3, logger: { info() {}, error() {} } });
  const backend = { async close() {} };
  try {
    const state = retained.retain('private-state', backend, 'alice');
    await retained.release(backend);
    assert.equal(await retained.take(state, undefined, 'bob'), undefined);
    assert.equal(await retained.take(state), undefined);
    assert.equal((await retained.take(state, undefined, 'alice')).state, 'private-state');
  } finally { await retained.close(); }

  const port = 18089;
  const command = [process.execPath, fileURLToPath(import.meta.url), root, tokenEnv, '--backend'].map(x => `'${x.replaceAll("'", "'\\''")}'`).join(' ');
  const child = spawn(process.execPath, [`${root}/dist/index.js`, '--stdio', command,
    '--outputTransport', 'streamableHttp', '--stateful', '--port', String(port),
    '--streamableHttpPath', '/mcp', '--healthEndpoint', '/healthz', '--logLevel', 'none'],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  async function rpc(method, token, session, modern = false) {
    const version = modern ? '2026-07-28' : '2025-11-25';
    const response = await fetch(endpoint, { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': version,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'Mcp-Session-Id': session } : {}),
      ...(modern ? { 'MCP-Method': method } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method,
      params: method === 'initialize' ? { protocolVersion: version, capabilities: {}, clientInfo: { name: 'ci', version: '1' } }
        : modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'ci', version: '1' } } } : {} }),
      signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    const body = response.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5))
      : response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
    return { status: response.status, session: response.headers.get('mcp-session-id'), body };
  }
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch {}
      if (ready || child.exitCode !== null) break;
      await delay(100);
    }
    assert(ready, output);
    assert.equal((await rpc('initialize')).status, 401);
    const init = await rpc('initialize', 'alice');
    assert.equal(init.status, 200);
    assert(init.session);
    assert.equal((await rpc('tools/list', 'bob', init.session)).status, 401);
    for (const method of ['GET', 'DELETE']) {
      const denied = await fetch(endpoint, { method, headers: { Authorization: 'Bearer bob', 'Mcp-Session-Id': init.session } });
      assert.equal(denied.status, 401); await denied.body?.cancel();
    }
    assert.equal((await rpc('tools/list', 'alice', init.session)).body.result.tools[0].name, 'alice');
    assert.equal((await rpc('tools/list', undefined, undefined, true)).status, 401);
    for (const token of ['alice', 'bob']) {
      const modern = await rpc('tools/list', token, undefined, true);
      assert.equal(modern.status, 200, JSON.stringify(modern.body));
      assert.equal(modern.body.result.tools[0].name, token);
    }
    const closed = await fetch(endpoint, { method: 'DELETE', headers: { Authorization: 'Bearer alice', 'Mcp-Session-Id': init.session, 'MCP-Protocol-Version': '2025-11-25' } });
    assert.equal(closed.status, 200); await closed.body?.cancel();
    console.log('Legacy/modern bearer forwarding, session access and continuation isolation verified.');
  } catch (error) { console.error(output); throw error; }
  finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([once(child, 'close'), delay(6000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}
