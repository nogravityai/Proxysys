const express = require("express");
const config = require("./config");
const { createProxyHandler } = require("./proxy_handler");
const { create_mcp_connector } = require("./mcp_connector");
const cookie_manager = require("./cookie_manager");

const app = express();
app.use(express.json({ limit: "10mb" }));

const proxy_middleware = createProxyHandler(config);
const mcp = create_mcp_connector(config);

app.get("/health", (_req, res) => {
  const cookies_obj = cookie_manager.load_cookies(config);
  const cookie_count = Object.keys(cookies_obj).length;
  res.json({
    status: "ok",
    proxy: "running",
    port: config.proxy_port,
    target: `${config.target_host}:${config.target_port}`,
    protocol: "HTTP/2",
    cookies_loaded: cookie_count,
    mcp_endpoint: config.mcp_endpoint,
    timeout_ms: config.timeout_ms,
  });
});

app.post(config.mcp_endpoint, async (req, res) => {
  try {
    const jsonrpc_request = req.body;

    if (!jsonrpc_request || typeof jsonrpc_request !== "object") {
      res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: invalid JSON" },
      });
      return;
    }

    if (!jsonrpc_request.jsonrpc || jsonrpc_request.jsonrpc !== "2.0") {
      res.status(400).json({
        jsonrpc: "2.0",
        id: jsonrpc_request.id || null,
        error: { code: -32600, message: "Invalid Request: missing jsonrpc 2.0" },
      });
      return;
    }

    const result = await mcp.handle_mcp_request(jsonrpc_request);
    res.json(result);
  } catch (err) {
    console.error(`[server] mcp handler error: ${err.message}`);
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body?.id || null,
      error: { code: -32603, message: `Internal error: ${err.message}` },
    });
  }
});

app.post("/cookies/refresh", (req, res) => {
  const new_cookies = req.body;

  if (!new_cookies || typeof new_cookies !== "object" || Array.isArray(new_cookies)) {
    res.status(400).json({
      error: "invalid_body",
      message: "Send JSON object: { \"cookie_name\": \"cookie_value\", ... }",
    });
    return;
  }

  const current_cookies = cookie_manager.load_cookies(config);
  const merged = cookie_manager.merge_cookies(current_cookies, new_cookies);
  cookie_manager.save_cookies(config, merged);

  const updated_keys = Object.keys(new_cookies);
  console.log(`[server] cookies refreshed manually: ${updated_keys.join(", ")}`);

  res.json({
    status: "ok",
    message: `${updated_keys.length} cookie(s) updated`,
    total_cookies: Object.keys(merged).length,
    updated_keys,
  });
});

app.get("/cookies", (_req, res) => {
  const cookies_obj = cookie_manager.load_cookies(config);
  const safe_output = {};
  for (const [key, value] of Object.entries(cookies_obj)) {
    safe_output[key] =
      typeof value === "string" && value.length > 30
        ? value.substring(0, 20) + "..." + value.substring(value.length - 10)
        : value;
  }
  res.json({
    status: "ok",
    count: Object.keys(cookies_obj).length,
    cookies: safe_output,
  });
});

app.all("*", proxy_middleware);

const server = app.listen(config.proxy_port, () => {
  console.log(`[server] ============================================`);
  console.log(`[server] OpenAI Prism Proxy + MCP Connector`);
  console.log(`[server] ============================================`);
  console.log(`[server] proxy listening on port ${config.proxy_port}`);
  console.log(
    `[server] target: ${config.target_host}:${config.target_port} (${config.target_ssl ? "ssl" : "plain"})`
  );
  console.log(`[server] protocol: HTTP/2`);
  console.log(`[server] timeout: ${config.timeout_ms}ms`);
  console.log(`[server] --------------------------------------------`);
  console.log(`[server] routes:`);
  console.log(`[server]   GET  /health            -> system status`);
  console.log(`[server]   POST ${config.mcp_endpoint}             -> MCP JSON-RPC bridge`);
  console.log(`[server]   GET  /cookies           -> view cookies (masked)`);
  console.log(`[server]   POST /cookies/refresh   -> update cookies manually`);
  console.log(`[server]   *    /*                 -> transparent proxy`);
  console.log(`[server] --------------------------------------------`);
  console.log(`[server] cookie auto-update: Set-Cookie capture enabled`);
  console.log(`[server] open http://localhost:${config.proxy_port}/health to verify`);
  console.log(`[server] ============================================`);
});

server.on("clientError", (err, client_connection) => {
  console.error(`[server] client error: ${err.message}`);
  if (client_connection.writable) {
    client_connection.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
});

server.on("error", (err) => {
  console.error(`[server] fatal error: ${err.message}`);
  process.exit(1);
});

function graceful_shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down...`);
  server.close(() => {
    console.log("[server] closed all connections");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[server] forced shutdown after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", () => graceful_shutdown("SIGTERM"));
process.on("SIGINT", () => graceful_shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error(`[server] uncaught exception: ${err.message}`);
  graceful_shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  console.error(`[server] unhandled rejection: ${reason}`);
});
