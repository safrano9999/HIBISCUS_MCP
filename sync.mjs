import http from "node:http";
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";

const text = (html) => html.replace(/<[^>]*>/g, "").replace(
  /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
  (_, entity) => {
    if (entity.startsWith("#")) {
      const value = entity[1].toLowerCase() === "x"
        ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return value <= 0x10ffff ? String.fromCodePoint(value) : "\ufffd";
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[entity.toLowerCase()];
  }).trim();

// Hibiscus exposes sync progress through its existing web UI, not a run-ID API.
// Keep the parser strict: an unknown page must never become a success result.
export function parseSyncPage(html) {
  const heading = /<h2>System-Log<\/h2>/i.exec(html);
  if (!heading) throw new Error("Hibiscus sync status page not recognized");
  const rows = [];
  for (const match of html.slice(heading.index).matchAll(/<tr\b[^>]*class="(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...match[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
    if (cells.length !== 3 || !/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/.test(cells[0])) {
      throw new Error("Hibiscus sync log format not recognized");
    }
    rows.push({ level: match[1], date: cells[0], source: cells[1], message: cells[2], key: JSON.stringify([match[1], ...cells]) });
  }
  if (!rows.length) throw new Error("Hibiscus sync log is empty or unavailable");
  const last = /<div class="message">\s*<span class="type-(\d+)">([\s\S]*?)<\/span>/.exec(html);
  return {
    rows, // newest first, as rendered by Hibiscus Message.getLog()
    running: /Synchronisierung läuft\.{3}/.test(text(html.slice(0, heading.index))),
    lastError: last?.[1] === "1",
  };
}

export function createSyncRequest(upstream, authorization) {
  const url = new URL("/hibiscus/", upstream);
  const transport = url.protocol === "https:" ? https : http;
  return (method = "GET", timeoutMs = 5000) => new Promise((resolve, reject) => {
    const body = method === "POST" ? "action=execute" : undefined;
    const request = transport.request(url, {
      method, rejectUnauthorized: false,
      headers: {
        Authorization: authorization,
        "Cache-Control": "no-cache",
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) request.destroy(new Error("Hibiscus sync response too large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Hibiscus sync returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          const charset = /charset=["']?([^;\s"']+)/i.exec(response.headers["content-type"] || "")?.[1] || "utf-8";
          const html = new TextDecoder(charset).decode(Buffer.concat(chunks));
          resolve({ httpStatus: response.statusCode, ...parseSyncPage(html) });
        } catch (error) { reject(error); }
      });
    });
    // Wall-clock bound, including DNS, connect and slow response bodies.
    const timer = setTimeout(() => request.destroy(new Error("Hibiscus sync request timed out")), timeoutMs);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end(body);
  });
}

function newRows(previous, current) {
  const matches = [];
  for (let i = 0; i < current.length; i++) {
    const length = Math.min(previous.length, current.length - i);
    if (length < Math.min(3, previous.length)) continue;
    if (previous.slice(0, length).every((row, j) => row.key === current[i + j].key)) matches.push(i);
  }
  // Lost/ambiguous overlap means we could have missed an error or another run.
  if (matches.length !== 1) throw new Error("Hibiscus sync log correlation lost");
  return current.slice(0, matches[0]).reverse();
}

export async function syncAndWait(request, baseline, {
  timeoutMs = 30000, intervalMs = 500, now = () => performance.now(), wait = sleep,
} = {}) {
  const deadline = now() + timeoutMs;
  let previous = baseline.rows, started = false, finished = false, httpStatus;
  const result = (status, reason) => ({
    sync_triggered: started ? true : null,
    sync_status: status,
    ...(httpStatus === undefined ? {} : { sync_http_status: httpStatus }),
    ...(reason ? { sync_detail: reason } : {}),
  });
  try {
    let method = "POST";
    while (now() < deadline) {
      const page = await request(method, Math.min(5000, deadline - now()));
      if (method === "POST") httpStatus = page.httpStatus;
      method = "GET"; // Never repeat a POST, even after a timeout/error.
      const fresh = newRows(previous, page.rows);
      previous = page.rows;
      for (const row of fresh) {
        if (row.source === "ExecuteServiceImpl" && /already running/.test(row.message)) {
          return result("unknown", "Another synchronization was already running; this request cannot be correlated.");
        }
        if (row.source === "ExecuteServiceImpl" && /^synchronizing \d+ backends$/.test(row.message)) {
          if (started) return result("unknown", "Multiple synchronization runs observed.");
          started = true;
        }
        if (/^(ERROR|FATAL)$/.test(row.level) || row.source === "SynchronizeErrorMessageConsumer"
          || /Synchronisierung abgebrochen/.test(row.message)) {
          return result("failed", "Hibiscus reported an error or cancellation during synchronization.");
        }
        if (row.source === "ExecuteServiceImpl" && row.message === "no more backends. synchronization done") {
          if (!started) return result("unknown", "Synchronization finished without an attributable start.");
          finished = true;
        }
      }
      if (page.lastError && fresh.length) return result("failed", "Hibiscus reported a synchronization error.");
      if (finished && !page.running) return result("completed");
      await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
    }
    return result("unknown", "Synchronization completion was not observed within the 30-second observation window.");
  } catch (error) {
    return result("unknown", error.message);
  }
}

export function createTransferHandler({ create, request, observe = syncAndWait }) {
  let busy = false;
  return async (args) => {
    if (busy) return { stored: false, sync_status: "not_started", message: "Dieser MCP verarbeitet bereits eine Überweisung. Kein weiterer Auftrag wurde erstellt." };
    busy = true;
    try {
      let baseline;
      try { baseline = await request("GET"); }
      catch (error) {
        return { stored: false, sync_status: "not_started", message: "Sync-Status nicht lesbar; kein Auftrag erstellt.", sync_detail: error.message };
      }
      if (baseline.running) return { stored: false, sync_status: "not_started", message: "Hibiscus synchronisiert bereits; kein Auftrag erstellt." };
      let id;
      try { id = await create(args); }
      catch {
        return { stored: null, sync_status: "not_started", message: "Keine eindeutige Antwort beim Speichern des Auftrags.",
          next_action: "Stop. Do not automatically repeat create_transfer; storage may already have succeeded. Report the uncertainty." };
      }
      let sync;
      try { sync = await observe(request, baseline); }
      catch { sync = { sync_triggered: null, sync_status: "unknown" }; }
      return {
        stored: true, id, instant: args.instant, ...sync,
        message: sync.sync_status === "completed"
          ? "Überweisung erstellt und Synchronisierung erfolgreich abgeschlossen."
          : sync.sync_status === "failed"
            ? "Überweisung gespeichert; bei der Synchronisierung ist ein Fehler aufgetreten."
            : "Überweisung gespeichert; Abschluss der Synchronisierung derzeit nicht feststellbar.",
        next_action: "Report this result and stop. For completed, use the message without adding a pending-bank-confirmation disclaimer. Do not poll pending_transfers or get_balance, wait for transaction acceptance, or automatically create the transfer again. Sync completion is not confirmation of an individual bank transaction.",
      };
    } finally { busy = false; }
  };
}
