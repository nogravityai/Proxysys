const http2 = require("http2");
const zlib = require("zlib");
const crypto = require("crypto");
const cookie_manager = require("./cookie_manager");

const PROXY_SIGNATURES = [
  "x-forwarded-for", "x-real-ip", "x-forwarded-proto",
  "x-forwarded-host", "x-client-ip", "via", "forwarded",
  "x-proxy-id", "x-proxy-user", "proxy-connection",
  "x-openai-proxy-wasm", "x-powered-by", "server",
  "x-request-id", "x-runtime", "x-ratelimit-limit",
  "x-ratelimit-remaining", "x-ratelimit-reset",
];

const SESSION_TTL_MS = 5 * 60 * 1000;

const session_store = new Map();
const session_timestamps = new Map();
const h2_client_store = new Map();

function get_session_key() {
  return "local";
}

function destroy_h2_client() {
  const authority = "prism.openai.com:443";
  const existing = h2_client_store.get(authority);
  if (existing && !existing.destroyed) {
    try { existing.destroy(); } catch {}
  }
  h2_client_store.delete(authority);
  console.log("[h2] client destroyed — fresh session will be created");
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

  for (const sig of PROXY_SIGNATURES) {
    delete merged_headers[sig];
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
  const client = http2.connect(`https://${authority}`, {
    rejectUnauthorized: false,
  });
  client.on("error", (err) => {
    console.error(`[h2] client error: ${err.message}`);
    h2_client_store.delete(authority);
  });
  client.on("close", () => {
    h2_client_store.delete(authority);
  });
  client.on("goaway", () => {
    console.log(`[h2] GOAWAY received, reconnecting...`);
    h2_client_store.delete(authority);
  });
  h2_client_store.set(authority, client);
  return client;
}

function decode_body(buffer, encoding) {
  return new Promise((resolve) => {
    if (!encoding || encoding === "identity") return resolve(buffer);
    const decode =
      zlib[
        encoding === "br"
          ? "brotliDecompress"
          : encoding === "gzip"
            ? "gunzip"
            : "inflate"
      ];
    if (!decode) return resolve(buffer);
    decode(buffer, (err, result) => {
      resolve(err ? buffer : result);
    });
  });
}

function createProxyHandler(config) {
  return function proxy_middleware(req, res) {
    if (
      !req.method ||
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
        req.method.toUpperCase()
      )
    ) {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "method_not_allowed" }));
    }

    const session_key = get_session_key();

    if (session_store.has(session_key)) {
      const age = Date.now() - (session_timestamps.get(session_key) || 0);
      if (age > SESSION_TTL_MS) {
        session_store.delete(session_key);
        session_timestamps.delete(session_key);
      }
    }

    let merged_headers;
    if (session_store.has(session_key)) {
      merged_headers = { ...session_store.get(session_key) };
      const cookies_obj = cookie_manager.load_cookies(config);
      const cookie_string = cookie_manager.build_cookie_string(cookies_obj);
      if (cookie_string) {
        merged_headers["cookie"] = cookie_string;
      }
    } else {
      merged_headers = build_merged_headers(
        req.headers,
        config.injected_headers,
        config.blocked_headers,
        config
      );
      session_store.set(session_key, merged_headers);
      session_timestamps.set(session_key, Date.now());
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

    const log_hash = crypto.createHash("sha256").update(String(session_key)).digest("hex").substring(0, 8);
    console.log(
      `[proxy] ${req.method} ${req.url} -> ${config.target_host}:${config.target_port} | session=${log_hash}`
    );

    const timeout_id = setTimeout(() => {
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "gateway_timeout",
            message: "upstream timeout",
          })
        );
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
      destroy_h2_client();
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "upstream_error", message: err.message })
        );
      }
      return;
    }

    upstream_request.setTimeout(config.timeout_ms, () => {
      upstream_request.close();
      clearTimeout(timeout_id);
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "gateway_timeout",
            message: "upstream timeout",
          })
        );
      }
    });

    upstream_request.on("error", (err) => {
      clearTimeout(timeout_id);
      console.error(`[proxy] upstream error: ${err.message}`);
      destroy_h2_client();
      if (!res.headersSent) {
        let status_code = 502;
        let error_type = "upstream_error";
        if (
          err.code === "ECONNRESET" ||
          err.code === "ETIMEDOUT"
        ) {
          status_code = 504;
          error_type = "gateway_timeout";
        }
        if (err.code === "ECONNREFUSED") {
          error_type = "upstream_unavailable";
        }
        res.writeHead(status_code, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error_type,
            message: err.message,
            code: err.code || "UNKNOWN",
          })
        );
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
        if (PROXY_SIGNATURES.includes(key.toLowerCase())) continue;
        response_headers_clean[key] = value;
      }

      console.log(`[proxy] <- ${status_code} ${req.method} ${req.url}`);

      if (status_code === 401) {
        clearTimeout(timeout_id);
        clear_session(session_key);
        destroy_h2_client();
        const chunks = [];
        upstream_request.on("data", (chunk) => chunks.push(chunk));
        upstream_request.on("end", () => {
          const raw_body = Buffer.concat(chunks);
          const content_encoding =
            response_headers["content-encoding"] || "";
          decode_body(raw_body, content_encoding).then((decoded_body) => {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "unauthorized",
                wait_for_refresh: true,
                message: "tokens expired — update cookies.json or POST /cookies/refresh",
                upstream_response: decoded_body.toString("utf8").substring(0, 500),
              })
            );
          });
        });
        return;
      }

      const chunks = [];
      upstream_request.on("data", (chunk) => {
        chunks.push(chunk);
      });

      upstream_request.on("end", () => {
        clearTimeout(timeout_id);
        const raw_body = Buffer.concat(chunks);
        const content_encoding =
          response_headers["content-encoding"] || "";

        decode_body(raw_body, content_encoding).then((decoded_body) => {
          if (status_code >= 400) {
            destroy_h2_client();
          }
          response_headers_clean["content-length"] = decoded_body.length;
          delete response_headers_clean["content-encoding"];
          res.writeHead(status_code, response_headers_clean);
          res.end(decoded_body);
        });
      });

      upstream_request.on("close", () => {
        clearTimeout(timeout_id);
      });
    });

    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      let body;
      if (req.body !== undefined) {
        if (Buffer.isBuffer(req.body)) {
          body = req.body;
        } else if (typeof req.body === "object") {
          body = Buffer.from(JSON.stringify(req.body), "utf8");
        } else {
          body = Buffer.from(String(req.body), "utf8");
        }
        upstream_request.end(body);
      } else {
        const body_chunks = [];
        req.on("data", (chunk) => body_chunks.push(chunk));
        req.on("end", () => {
          const concatenated = Buffer.concat(body_chunks);
          if (concatenated.length > 0) {
            upstream_request.end(concatenated);
          } else {
            upstream_request.end();
          }
        });
      }
    } else {
      upstream_request.end();
    }
  };
}

function clear_session(session_key) {
  session_timestamps.delete(session_key);
  return session_store.delete(session_key);
}

function clear_all_sessions() {
  session_store.clear();
  session_timestamps.clear();
}

module.exports = {
  createProxyHandler,
  clear_session,
  clear_all_sessions,
  destroy_h2_client,
};
