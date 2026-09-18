#!/bin/bash

# ============================================
# OpenAI Prism Proxy + MCP Connector
# Local Setup Script
# ============================================

set -e

echo "=== OpenAI Prism Proxy + MCP Setup ==="
echo ""

PROXY_DIR="$HOME/openai-proxy"
mkdir -p "$PROXY_DIR"
cd "$PROXY_DIR"

echo "[1/8] Creating package.json..."
cat > package.json << 'PKGJSON'
{
  "name": "openai-prism-proxy-mcp",
  "version": "2.0.0",
  "description": "HTTP/2 proxy gateway + MCP connector for prism.openai.com",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node test.js"
  },
  "dependencies": {
    "express": "^4.21.0"
  }
}
PKGJSON

echo "[2/8] Creating config.js..."
cat > config.js << 'CONFIGJS'
module.exports = Object.freeze({
  proxy_port: 8080,

  target_host: "prism.openai.com",
  target_port: 443,
  target_ssl: true,

  timeout_ms: 60000,

  cookies_file: "./cookies.json",
  mcp_endpoint: "/mcp",
  refresh_wait_ms: 5000,

  session_header: "X-Session-ID",

  injected_headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "sec-ch-ua": "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
    "Origin": "https://prism.openai.com",
    "Referer": "https://prism.openai.com/",
  },

  blocked_headers: [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
  ],
});
CONFIGJS

echo "[3/8] Creating cookies.json (empty — paste your cookies here)..."
cat > cookies.json << 'COOKIESJSON'
{
  "oai-did": "",
  "oai-sc": "",
  "oaicom-stable-id": "",
  "__cf_bm": "",
  "__cflb": "",
  "_dd_s": "",
  "crixet_light_mode_preference_v1": "dark",
  "prism_oai_access_token": "",
  "prism_session_token": "",
  "prism-did": ""
}
COOKIESJSON

echo "[4/8] Creating cookie_manager.js..."
cat > cookie_manager.js << 'COOKIEJS'
const fs = require("fs");
const path = require("path");

function get_cookies_path(config) {
  return path.resolve(config.cookies_file);
}

function load_cookies(config) {
  const cookies_path = get_cookies_path(config);
  try {
    const data = fs.readFileSync(cookies_path, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error(`[cookie_manager] failed to load cookies: ${err.message}`);
    return {};
  }
}

function save_cookies(config, cookies_obj) {
  const cookies_path = get_cookies_path(config);
  try {
    const data = JSON.stringify(cookies_obj, null, 2);
    fs.writeFileSync(cookies_path, data, "utf8");
    console.log(`[cookie_manager] cookies saved (${Object.keys(cookies_obj).length} keys)`);
  } catch (err) {
    console.error(`[cookie_manager] failed to save cookies: ${err.message}`);
  }
}

function build_cookie_string(cookies_obj) {
  return Object.entries(cookies_obj)
    .filter(([_, v]) => v)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function parse_cookie_header(cookie_string) {
  const result = {};
  if (!cookie_string) return result;
  const pairs = cookie_string.split(";");
  for (const pair of pairs) {
    const [key, ...rest] = pair.trim().split("=");
    if (key && rest.length > 0) {
      result[key.trim()] = rest.join("=").trim();
    }
  }
  return result;
}

function capture_set_cookie(response_headers, config) {
  const current_cookies = load_cookies(config);
  let updated = false;

  const set_cookie = response_headers["set-cookie"];
  if (!set_cookie) return false;

  const set_cookie_entries = Array.isArray(set_cookie) ? set_cookie : [set_cookie];

  for (const entry of set_cookie_entries) {
    const cookie_parts = entry.split(";")[0].trim();
    const eq_index = cookie_parts.indexOf("=");
    if (eq_index === -1) continue;

    const name = cookie_parts.substring(0, eq_index).trim();
    const value = cookie_parts.substring(eq_index + 1).trim();

    if (current_cookies[name] !== value) {
      current_cookies[name] = value;
      updated = true;
      console.log(`[cookie_manager] captured new/updated cookie: ${name}`);
    }
  }

  if (updated) {
    save_cookies(config, current_cookies);
  }

  return updated;
}

function merge_cookies(base_cookies, incoming_cookies) {
  return { ...base_cookies, ...incoming_cookies };
}

function replace_all_cookies(new_cookies, config) {
  save_cookies(config, new_cookies);
  console.log(`[cookie_manager] all cookies replaced (${Object.keys(new_cookies).length} keys)`);
}

module.exports = {
  load_cookies,
  save_cookies,
  build_cookie_string,
  parse_cookie_header,
  capture_set_cookie,
  merge_cookies,
  replace_all_cookies,
};
COOKIEJS

echo "[5/8] Creating proxy_handler.js..."
cat > proxy_handler.js << 'PROXYJS'
const http2 = require("http2");
const zlib = require("zlib");
const cookie_manager = require("./cookie_manager");

const session_store = new Map();
const h2_client_store = new Map();

function get_session_key(req, config) {
  const header_session_id = req.headers[config.session_header.toLowerCase()];
  if (header_session_id) return header_session_id;
  const client_ip =
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    req.connection.remoteAddress;
  return client_ip;
}

function build_merged_headers(client_headers, injected_headers, blocked_headers, cookies_config) {
  const merged_headers = {};
  for (const [key, value] of Object.entries(client_headers)) {
    if (blocked_headers.includes(key.toLowerCase())) continue;
    merged_headers[key] = value;
  }
  for (const [key, value] of Object.entries(injected_headers)) {
    merged_headers[key] = value;
  }
  const cookies_obj = cookie_manager.load_cookies(cookies_config);
  const cookie_string = cookie_manager.build_cookie_string(cookies_obj);
  if (cookie_string) {
    merged_headers["cookie"] = cookie_string;
  }
  return merged_headers;
}

function get_h2_client(config) {
  const authority = `${config.target_host}:${config.target_port}`;
  if (h2_client_store.has(authority)) {
    const existing = h2_client_store.get(authority);
    if (!existing.destroyed) return existing;
    h2_client_store.delete(authority);
  }
  const client = http2.connect(`https://${authority}`, { rejectUnauthorized: false });
  client.on("error", (err) => {
    console.error(`[h2] client error: ${err.message}`);
    h2_client_store.delete(authority);
  });
  client.on("close", () => { h2_client_store.delete(authority); });
  h2_client_store.set(authority, client);
  return client;
}

function decode_body(buffer, encoding) {
  return new Promise((resolve) => {
    if (!encoding || encoding === "identity") return resolve(buffer);
    const decode = zlib[encoding === "br" ? "brotliDecompress" : encoding === "gzip" ? "gunzip" : "inflate"];
    if (!decode) return resolve(buffer);
    decode(buffer, (err, result) => { resolve(err ? buffer : result); });
  });
}

function createProxyHandler(config) {
  return function proxy_middleware(req, res) {
    if (!req.method || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "method_not_allowed" }));
    }

    const session_key = get_session_key(req, config);
    let merged_headers;
    if (session_store.has(session_key)) {
      merged_headers = session_store.get(session_key);
      const cookies_obj = cookie_manager.load_cookies(config);
      const cookie_string = cookie_manager.build_cookie_string(cookies_obj);
      if (cookie_string) merged_headers["cookie"] = cookie_string;
    } else {
      merged_headers = build_merged_headers(req.headers, config.injected_headers, config.blocked_headers, config);
      session_store.set(session_key, merged_headers);
    }

    const upstream_headers = {};
    for (const [key, value] of Object.entries(merged_headers)) {
      if (key === config.session_header.toLowerCase()) continue;
      if (key.startsWith(":")) continue;
      upstream_headers[key.toLowerCase()] = value;
    }
    upstream_headers[":method"] = req.method;
    upstream_headers[":path"] = req.url || "/";
    upstream_headers[":authority"] = config.target_host;
    upstream_headers[":scheme"] = "https";

    console.log(`[proxy] ${req.method} ${req.url} -> ${config.target_host}:${config.target_port} | session=${session_key}`);

    const timeout_id = setTimeout(() => {
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gateway_timeout", message: "upstream timeout" }));
      }
    }, config.timeout_ms);

    res.on("finish", () => clearTimeout(timeout_id));
    res.on("close", () => clearTimeout(timeout_id));

    let upstream_request;
    try {
      const client = get_h2_client(config);
      upstream_request = client.request(upstream_headers);
    } catch (err) {
      clearTimeout(timeout_id);
      console.error(`[proxy] h2 connect error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error", message: err.message }));
      }
      return;
    }

    upstream_request.setTimeout(config.timeout_ms, () => {
      upstream_request.close();
      clearTimeout(timeout_id);
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gateway_timeout", message: "upstream timeout" }));
      }
    });

    upstream_request.on("error", (err) => {
      clearTimeout(timeout_id);
      console.error(`[proxy] upstream error: ${err.message}`);
      if (!res.headersSent) {
        let status_code = 502;
        let error_type = "upstream_error";
        if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT") { status_code = 504; error_type = "gateway_timeout"; }
        if (err.code === "ECONNREFUSED") { error_type = "upstream_unavailable"; }
        res.writeHead(status_code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error_type, message: err.message, code: err.code || "UNKNOWN" }));
      }
    });

    upstream_request.on("response", (response_headers) => {
      const status_code = response_headers[":status"] || 200;

      cookie_manager.capture_set_cookie(response_headers, config);

      const response_headers_clean = {};
      for (const [key, value] of Object.entries(response_headers)) {
        if (key.startsWith(":")) continue;
        if (key.toLowerCase() === "transfer-encoding") continue;
        if (key.toLowerCase() === "content-encoding") continue;
        if (key.toLowerCase() === "set-cookie") continue;
        response_headers_clean[key] = value;
      }

      console.log(`[proxy] <- ${status_code} ${req.method} ${req.url}`);

      if (status_code === 401) {
        clearTimeout(timeout_id);
        const chunks = [];
        upstream_request.on("data", (chunk) => chunks.push(chunk));
        upstream_request.on("end", () => {
          const raw_body = Buffer.concat(chunks);
          const content_encoding = response_headers["content-encoding"] || "";
          decode_body(raw_body, content_encoding).then((decoded_body) => {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: "unauthorized",
              wait_for_refresh: true,
              message: "tokens expired - update cookies.json or POST /cookies/refresh",
              upstream_response: decoded_body.toString("utf8").substring(0, 500),
            }));
          });
        });
        return;
      }

      const chunks = [];
      upstream_request.on("data", (chunk) => { chunks.push(chunk); });
      upstream_request.on("end", () => {
        clearTimeout(timeout_id);
        const raw_body = Buffer.concat(chunks);
        const content_encoding = response_headers["content-encoding"] || "";
        decode_body(raw_body, content_encoding).then((decoded_body) => {
          response_headers_clean["content-length"] = decoded_body.length;
          delete response_headers_clean["content-encoding"];
          res.writeHead(status_code, response_headers_clean);
          res.end(decoded_body);
        });
      });
      upstream_request.on("close", () => { clearTimeout(timeout_id); });
    });

    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const body_chunks = [];
      req.on("data", (chunk) => body_chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(body_chunks);
        upstream_request.end(body.length > 0 ? body : undefined);
      });
    } else {
      upstream_request.end();
    }
  };
}

module.exports = { createProxyHandler };
PROXYJS

echo "[6/8] Creating mcp_connector.js..."
cat > mcp_connector.js << 'MCPJS'
const cookie_manager = require("./cookie_manager");

const MCP_METHOD_MAP = {
  "tools/list": { method: "GET", path: "/api/tools" },
  "tools/call": { method: "POST", path: "/api/tools/call" },
  "resources/list": { method: "GET", path: "/api/resources" },
  "resources/read": { method: "POST", path: "/api/resources/read" },
  "prompts/list": { method: "GET", path: "/api/prompts" },
  "prompts/get": { method: "POST", path: "/api/prompts/get" },
  "initialize": { method: "POST", path: "/api/initialize" },
  "ping": { method: "GET", path: "/api/ping" },
};

function jsonrpc_result(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpc_error(id, code, message, data) {
  const error = { code, message };
  if (data) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function create_mcp_connector(config) {
  const refresh_wait_ms = config.refresh_wait_ms || 5000;

  async function forward_to_proxy(method, path, body) {
    const proxy_url = `http://localhost:${config.proxy_port}${path}`;
    const cookies_obj = cookie_manager.load_cookies(config);
    const cookie_string = cookie_manager.build_cookie_string(cookies_obj);

    const headers = { "Content-Type": "application/json", "User-Agent": "MCP-Connector/1.0", "Accept": "application/json" };
    if (cookie_string) headers["Cookie"] = cookie_string;

    const fetch_options = { method, headers };
    if (body && ["POST", "PUT", "PATCH"].includes(method)) fetch_options.body = JSON.stringify(body);

    console.log(`[mcp] forwarding ${method} ${path} -> proxy:${config.proxy_port}`);
    const response = await fetch(proxy_url, fetch_options);
    const response_text = await response.text();
    let response_data;
    try { response_data = JSON.parse(response_text); } catch { response_data = { raw: response_text }; }
    console.log(`[mcp] <- ${response.status} from ${path}`);
    return { status: response.status, data: response_data };
  }

  async function handle_mcp_request(jsonrpc_request) {
    const { id, method, params } = jsonrpc_request;
    console.log(`[mcp] incoming request: id=${id} method=${method}`);

    if (!method) {
      return jsonrpc_error(id || null, -32600, "Invalid Request: missing method");
    }

    const mapping = MCP_METHOD_MAP[method];
    if (!mapping) {
      console.log(`[mcp] unmapped method "${method}" - forwarding as generic POST`);
      const result = await forward_to_proxy("POST", "/api/mcp", { method, params });
      return jsonrpc_result(id, result.data);
    }

    let result;
    try {
      result = await forward_to_proxy(mapping.method, mapping.path, mapping.method === "POST" ? params : undefined);
    } catch (err) {
      console.error(`[mcp] connection error: ${err.message}`);
      return jsonrpc_error(id, -32000, `Connection error: ${err.message}`);
    }

    if (result.status === 401) {
      console.log(`[mcp] ============================================`);
      console.log(`[mcp] UNAUTHORIZED (401) - TOKENS EXPIRED`);
      console.log(`[mcp] Waiting ${refresh_wait_ms}ms for token refresh...`);
      console.log(`[mcp] Update cookies.json or POST /cookies/refresh`);
      console.log(`[mcp] ============================================`);

      await new Promise((resolve) => setTimeout(resolve, refresh_wait_ms));

      console.log(`[mcp] retrying after wait...`);
      try {
        result = await forward_to_proxy(mapping.method, mapping.path, mapping.method === "POST" ? params : undefined);
      } catch (retry_err) {
        console.error(`[mcp] retry failed: ${retry_err.message}`);
        return jsonrpc_error(id, -32000, `Retry failed: ${retry_err.message}`);
      }

      if (result.status === 401) {
        console.log(`[mcp] ============================================`);
        console.log(`[mcp] RETRY FAILED - STILL UNAUTHORIZED (401)`);
        console.log(`[mcp] Tokens are still invalid after refresh wait`);
        console.log(`[mcp] Please update cookies.json manually`);
        console.log(`[mcp] ============================================`);
        return jsonrpc_error(id, -32001, "Unauthorized: tokens expired and refresh failed", { upstream_status: result.status, upstream_response: result.data });
      }
    }

    if (result.status >= 400 && result.status !== 401) {
      console.log(`[mcp] upstream error: ${result.status}`);
      return jsonrpc_error(id, -32002, `Upstream error: ${result.status}`, result.data);
    }

    console.log(`[mcp] request completed: id=${id} method=${method}`);
    return jsonrpc_result(id, result.data);
  }

  return { handle_mcp_request, forward_to_proxy };
}

module.exports = { create_mcp_connector };
MCPJS

echo "[7/8] Creating server.js..."
cat > server.js << 'SERVERJS'
const express = require("express");
const config = require("./config");
const { createProxyHandler } = require("./proxy_handler");
const { create_mcp_connector } = require("./mcp_connector");
const cookie_manager = require("./cookie_manager");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.raw({ type: "*/*", limit: "10mb" }));

const proxy_middleware = createProxyHandler(config);
const mcp = create_mcp_connector(config);

app.get("/health", (_req, res) => {
  const cookies_obj = cookie_manager.load_cookies(config);
  res.json({ status: "ok", proxy: "running", port: config.proxy_port, target: `${config.target_host}:${config.target_port}`, protocol: "HTTP/2", cookies_loaded: Object.keys(cookies_obj).length, mcp_endpoint: config.mcp_endpoint, timeout_ms: config.timeout_ms });
});

app.post(config.mcp_endpoint, async (req, res) => {
  try {
    const jsonrpc_request = req.body;
    if (!jsonrpc_request || typeof jsonrpc_request !== "object") {
      return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON" } });
    }
    if (!jsonrpc_request.jsonrpc || jsonrpc_request.jsonrpc !== "2.0") {
      return res.status(400).json({ jsonrpc: "2.0", id: jsonrpc_request.id || null, error: { code: -32600, message: "Invalid Request: missing jsonrpc 2.0" } });
    }
    const result = await mcp.handle_mcp_request(jsonrpc_request);
    res.json(result);
  } catch (err) {
    console.error(`[server] mcp handler error: ${err.message}`);
    res.status(500).json({ jsonrpc: "2.0", id: req.body?.id || null, error: { code: -32603, message: `Internal error: ${err.message}` } });
  }
});

app.post("/cookies/refresh", (req, res) => {
  const new_cookies = req.body;
  if (!new_cookies || typeof new_cookies !== "object" || Array.isArray(new_cookies)) {
    return res.status(400).json({ error: "invalid_body", message: "Send JSON: { \"cookie_name\": \"value\" }" });
  }
  const current_cookies = cookie_manager.load_cookies(config);
  const merged = cookie_manager.merge_cookies(current_cookies, new_cookies);
  cookie_manager.save_cookies(config, merged);
  console.log(`[server] cookies refreshed manually: ${Object.keys(new_cookies).join(", ")}`);
  res.json({ status: "ok", message: `${Object.keys(new_cookies).length} cookie(s) updated`, total_cookies: Object.keys(merged).length, updated_keys: Object.keys(new_cookies) });
});

app.get("/cookies", (_req, res) => {
  const cookies_obj = cookie_manager.load_cookies(config);
  const safe = {};
  for (const [k, v] of Object.entries(cookies_obj)) {
    safe[k] = typeof v === "string" && v.length > 30 ? v.substring(0, 20) + "..." + v.substring(v.length - 10) : v;
  }
  res.json({ status: "ok", count: Object.keys(cookies_obj).length, cookies: safe });
});

app.all("*", proxy_middleware);

const server = app.listen(config.proxy_port, () => {
  console.log(`[server] ============================================`);
  console.log(`[server] OpenAI Prism Proxy + MCP Connector`);
  console.log(`[server] ============================================`);
  console.log(`[server] proxy listening on port ${config.proxy_port}`);
  console.log(`[server] target: ${config.target_host}:${config.target_port} (HTTP/2)`);
  console.log(`[server] routes:`);
  console.log(`[server]   GET  /health            -> system status`);
  console.log(`[server]   POST ${config.mcp_endpoint}             -> MCP JSON-RPC bridge`);
  console.log(`[server]   GET  /cookies           -> view cookies (masked)`);
  console.log(`[server]   POST /cookies/refresh   -> update cookies manually`);
  console.log(`[server]   *    /*                 -> transparent proxy`);
  console.log(`[server] cookie auto-update: Set-Cookie capture enabled`);
  console.log(`[server] ============================================`);
});

server.on("clientError", (err, c) => { console.error(`[server] client error: ${err.message}`); if (c.writable) c.end("HTTP/1.1 400 Bad Request\r\n\r\n"); });
server.on("error", (err) => { console.error(`[server] fatal error: ${err.message}`); process.exit(1); });

function graceful_shutdown(s) {
  console.log(`[server] ${s} — shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGTERM", () => graceful_shutdown("SIGTERM"));
process.on("SIGINT", () => graceful_shutdown("SIGINT"));
process.on("uncaughtException", (e) => { console.error(`[server] uncaught: ${e.message}`); graceful_shutdown("uncaughtException"); });
process.on("unhandledRejection", (r) => console.error(`[server] unhandled rejection: ${r}`));
SERVERJS

echo "[8/8] Creating test.js..."
cat > test.js << 'TESTJS'
const BASE_URL = "http://localhost:8080";
let passed = 0, failed = 0;
function log_pass(n) { passed++; console.log(`  OK ${n}`); }
function log_fail(n, r) { failed++; console.log(`  FAIL ${n} -- ${r}`); }

async function test_health() {
  console.log("\n[TEST 1] GET /health");
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    if (res.status === 200 && data.status === "ok") log_pass(`health (status=${res.status}, cookies=${data.cookies_loaded})`);
    else log_fail("health", `unexpected ${res.status}`);
  } catch (e) { log_fail("health", e.message); }
}

async function test_cookies_view() {
  console.log("\n[TEST 2] GET /cookies");
  try {
    const res = await fetch(`${BASE_URL}/cookies`);
    const data = await res.json();
    if (res.status === 200 && data.count > 0) log_pass(`cookies view (count=${data.count})`);
    else log_fail("cookies view", `count=${data?.count}`);
  } catch (e) { log_fail("cookies view", e.message); }
}

async function test_cookies_refresh() {
  console.log("\n[TEST 3] POST /cookies/refresh");
  try {
    const res = await fetch(`${BASE_URL}/cookies/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test_cookie: "test_123" }) });
    const data = await res.json();
    if (res.status === 200 && data.status === "ok") log_pass(`cookies refresh (${data.total_cookies} total)`);
    else log_fail("cookies refresh", JSON.stringify(data));
  } catch (e) { log_fail("cookies refresh", e.message); }
}

async function test_proxy() {
  console.log("\n[TEST 4] GET / (transparent proxy)");
  try {
    const res = await fetch(`${BASE_URL}/`, { redirect: "manual" });
    if (res.status === 200) { const t = await res.text(); log_pass(`proxy (status=${res.status}, len=${t.length})`); }
    else if (res.status === 401) log_fail("proxy", "401 UNAUTHORIZED - tokens expired");
    else log_pass(`proxy (status=${res.status})`);
  } catch (e) { log_fail("proxy", e.message); }
}

async function test_mcp(method, params, id) {
  console.log(`\n[TEST 5] POST /mcp (${method})`);
  try {
    const res = await fetch(`${BASE_URL}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id }) });
    const data = await res.json();
    if (data.jsonrpc === "2.0" && data.id === id) {
      if (data.error?.code === -32001) log_fail(`mcp ${method}`, "401 UNAUTHORIZED");
      else log_pass(`mcp ${method} (id=${data.id})`);
    } else log_fail(`mcp ${method}`, "unexpected response");
  } catch (e) { log_fail(`mcp ${method}`, e.message); }
}

async function test_invalid() {
  console.log("\n[TEST 6] POST /mcp (invalid)");
  try {
    const res = await fetch(`${BASE_URL}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ foo: "bar" }) });
    const data = await res.json();
    if (res.status === 400 && data.error) log_pass(`invalid rejected (code=${data.error.code})`);
    else log_fail("invalid", `expected 400, got ${res.status}`);
  } catch (e) { log_fail("invalid", e.message); }
}

async function run() {
  console.log("============================================");
  console.log("  OpenAI Prism Proxy + MCP — Test Suite");
  console.log("============================================");
  await test_health();
  await test_cookies_view();
  await test_cookies_refresh();
  await test_proxy();
  await test_mcp("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } }, 1);
  await test_mcp("tools/list", {}, 2);
  await test_invalid();
  console.log("\n============================================");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("============================================");
  if (failed > 0) { console.log("\n  Note: 401 failures = tokens expired. Update cookies.json.\n"); }
  process.exit(failed > 0 ? 1 : 0);
}
run();
TESTJS

echo ""
echo "=== Installing dependencies ==="
npm install

echo ""
echo "=== Setup Complete ==="
echo ""
echo "1. Paste your cookies into: $PROXY_DIR/cookies.json"
echo "2. Start the proxy:"
echo "   cd $PROXY_DIR && npm start"
echo "3. Run tests:"
echo "   npm test"
echo "4. Open: http://localhost:8080/health"
echo ""
