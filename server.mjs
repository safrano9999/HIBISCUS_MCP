import { timingSafeEqual } from "node:crypto";
import { createSyncRequest, createTransferHandler } from "./sync.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import xmlrpc from "xmlrpc";
import Deserializer from "xmlrpc/lib/deserializer.js";
import { z } from "zod";

// Apache XML-RPC uses <ex:nil/> for void Hibiscus mutations.
const closeTag = Deserializer.prototype.onClosetag;
Deserializer.prototype.onClosetag = function(tag) {
  return closeTag.call(this, tag.endsWith(":NIL") ? "NIL" : tag);
};

const incoming = (process.env.HIBISCUS_MCP_REQUEST_BEARER || "").trim();
const gateway = (process.env.HIBISCUS_MCP_GATEWAY || "").trim();
const storePassword = (process.env.HIBISCUS_STORE_PASSWORD || "").trim();
const same = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
if (!incoming) throw new Error("Missing MCP bearer");
if (gateway && !same(incoming, gateway)) throw new Error("Unauthorized MCP bearer");
if (gateway && !storePassword) throw new Error("HIBISCUS_STORE_PASSWORD is required in gateway mode");
const password = gateway ? storePassword : incoming;
const upstream = new URL(process.env.HIBISCUS_MCP_UPSTREAM_URL || "https://hibiscus:8080");
const rpcUrl = new URL(upstream);
rpcUrl.pathname = `${rpcUrl.pathname.replace(/\/+$/, "")}/xmlrpc/`.replace(/\/{2,}/g, "/");
const authorization = `Basic ${Buffer.from(`foobar:${password}`).toString("base64")}`;
const options = {
  host: rpcUrl.hostname,
  port: Number(rpcUrl.port || (rpcUrl.protocol === "https:" ? 443 : 80)),
  path: `${rpcUrl.pathname}${rpcUrl.search}`,
  basic_auth: { user: "foobar", pass: password },
  rejectUnauthorized: false,
};
const client = rpcUrl.protocol === "https:"
  ? xmlrpc.createSecureClient(options)
  : xmlrpc.createClient(options);
const rpc = (method, params = []) => new Promise((resolve, reject) =>
  client.methodCall(method, params, (error, value) => error ? reject(error) : resolve(value)));
const mutation = (value) => {
  if (value == null) return null;
  if (/^\d+$/.test(String(value))) return String(value);
  throw new Error(String(value));
};
const output = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const guarded = (handler) => async (args) => {
  try { return output(await handler(args)); }
  catch (error) {
    return { isError: true, content: [{ type: "text", text: error?.message || String(error) }] };
  }
};

const server = new McpServer({ name: "hibiscus-mcp", version: "1.1.0" });
server.registerTool("create_transfer", {
  description: "Store one SEPA transfer, trigger Hibiscus Sync once and observe sync completion internally for up to 30 seconds. Instant payment defaults to false; use instant=true for instant payment. Report the returned message, then stop: do not poll balances or pending transfers, wait for bank acceptance or automatically repeat create_transfer. A completed sync is not confirmation of an individual bank transaction.",
  inputSchema: {
    account_id: z.string().min(1),
    recipient_name: z.string().min(1).max(70),
    recipient_iban: z.string().min(15).max(34),
    recipient_bic: z.string().max(11).optional(),
    amount: z.number().positive(),
    purpose: z.string().min(1).max(140),
    execution_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    instant: z.boolean().default(false),
  },
}, guarded(createTransferHandler({
  request: createSyncRequest(upstream, authorization),
  create: async (args) => {
    const transfer = {
      konto: args.account_id,
      name: args.recipient_name,
      kontonummer: args.recipient_iban.replace(/\s+/g, "").toUpperCase(),
      blz: (args.recipient_bic || "").replace(/\s+/g, "").toUpperCase(),
      betrag: args.amount,
      verwendungszweck: args.purpose,
      instantpayment: args.instant,
    };
    if (args.execution_date) transfer.termin = args.execution_date;
    return mutation(await rpc("hibiscus.xmlrpc.sepaueberweisung.create", [transfer]));
  },
})));

server.registerTool("pending_transfers", {
  description: "List pending SEPA transfers or delete one still-pending transfer by its exact Hibiscus ID.",
  inputSchema: { action: z.enum(["list", "delete"]).default("list"), id: z.string().min(1).optional() },
}, guarded(async ({ action, id }) => {
  const rows = await rpc("hibiscus.xmlrpc.sepaueberweisung.find", ["", "", ""]);
  const pending = rows.filter((row) => String(row.ausgefuehrt) === "false");
  if (action === "list") return { count: pending.length, transfers: pending };
  if (!id) throw new Error("id is required for delete");
  const found = pending.find((row) => String(row.id) === id);
  if (!found) throw new Error(`Pending transfer not found: ${id}`);
  mutation(await rpc("hibiscus.xmlrpc.sepaueberweisung.delete", [id]));
  return { deleted: true, id, transfer: found };
}));

server.registerTool("get_balance", {
  description: "Read the latest balances stored in Hibiscus, optionally filtered by account ID or IBAN.",
  inputSchema: { account_id: z.string().min(1).optional(), iban: z.string().min(15).max(34).optional() },
}, guarded(async ({ account_id, iban }) => {
  const normalized = iban?.replace(/\s+/g, "").toUpperCase();
  const rows = await rpc("hibiscus.xmlrpc.konto.find");
  const accounts = rows.filter((row) => (!account_id || String(row.id) === account_id)
    && (!normalized || String(row.iban).replace(/\s+/g, "").toUpperCase() === normalized));
  if (!accounts.length) throw new Error("No matching Hibiscus account found");
  return { count: accounts.length, accounts };
}));

await server.connect(new StdioServerTransport());
