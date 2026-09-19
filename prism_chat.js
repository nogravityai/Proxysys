const http2 = require("http2");
const fs = require("fs");
const cookie_manager = require("./cookie_manager");

const PRISM_HOST = "prism.openai.com";
const PROJECT_ID = "6b12b4c3-90c6-4eb2-8b35-e5a7f6a25c49";
const USER_ID = "user-50eExBVyN8G7EdyjTcxSfOH2";
const DEFAULT_MODEL = "gpt-5.6-sol";
const SANDBOX_PATH = "/s/sandboxes/proxy/";

function h2_request(client, method, path, body, extra_headers, timeout_ms) {
  return new Promise((resolve) => {
    const headers = {
      ":method": method,
      ":path": path,
      ":authority": PRISM_HOST,
      ":scheme": "https",
      "content-type": "application/json",
      "origin": "https://prism.openai.com",
      "referer": "https://prism.openai.com/",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      ...extra_headers,
    };

    const req = client.request(headers);
    let status;
    req.on("response", (h) => { status = h[":status"]; });
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.setTimeout(timeout_ms || 30000);
    req.on("timeout", () => { req.close(); resolve({ status: "TIMEOUT" }); });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try { resolve({ status, body: JSON.parse(raw) }); }
      catch { resolve({ status, raw: raw.substring(0, 500) }); }
    });
    req.on("error", (e) => resolve({ status: "ERR", error: e.message }));
    if (body) req.end(JSON.stringify(body)); else req.end();
  });
}

function make_headers(cookies) {
  const cookie_str = cookie_manager.build_cookie_string(cookies);
  const h = { cookie: cookie_str };
  if (cookies.prism_oai_access_token) {
    h.authorization = "Bearer " + cookies.prism_oai_access_token;
  }
  return h;
}

async function chat(config, message, options = {}) {
  const cookies = cookie_manager.load_cookies(config);
  const hdrs = make_headers(cookies);
  const model = options.model || DEFAULT_MODEL;
  const c = http2.connect(`https://${PRISM_HOST}:443`, { rejectUnauthorized: false });

  try {
    // 1. Y-Sweet
    const ry = await h2_request(c, "POST", "/api/y", {
      docId: PROJECT_ID,
      requestContext: { source: "initial-bootstrap" },
    }, hdrs, 30000);
    if (!ry.body?.baseUrl) throw new Error("api/y failed");
    console.log("[prism] y-sweet: ok");

    // 2. backend/new
    const rn = await h2_request(c, "POST", "/api/backend/1/new", {}, hdrs, 30000);
    if (!rn.body?.token || !rn.body?.url) throw new Error("backend/new failed");
    const { token: sandbox_token, url: sandbox_url } = rn.body;
    console.log("[prism] backend/new: ok");

    // 3. resources-token API
    const rt = await h2_request(c, "POST", `/api/projects/${PROJECT_ID}/sandbox/resources-token`, {
      sandbox_session_id: null,
      sandbox_token: sandbox_token,
    }, hdrs, 30000);
    if (!rt.body?.access_token) throw new Error("resources-token API failed: " + JSON.stringify(rt.body).substring(0, 200));
    console.log("[prism] resources-token API: ok");

    // 4. resources-token sandbox
    const rs1 = await h2_request(c, "POST", SANDBOX_PATH + "resources-token", {
      token: rt.body.access_token,
      resourceBaseUrl: ry.body.baseUrl + "/",
      projectId: PROJECT_ID,
    }, { "x-crixet-sandbox-token": sandbox_token, ...hdrs }, 30000);
    console.log("[prism] rt-sandbox: " + (rs1.body?.status || rs1.status));

    // 5. token
    const rs2 = await h2_request(c, "POST", SANDBOX_PATH + "token", ry.body, {
      "x-crixet-sandbox-token": sandbox_token,
      ...hdrs,
    }, 30000);
    console.log("[prism] token: " + (rs2.body?.success || rs2.status));

    // 6. wait-for-sync
    for (let i = 0; i < 5; i++) {
      const rw = await h2_request(c, "GET", SANDBOX_PATH + "wait-for-sync?wait_ms=10000", null, {
        "x-crixet-sandbox-token": sandbox_token,
        ...hdrs,
      }, 25000);
      if (rw.body?.status === "synced") {
        console.log("[prism] synced");
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 7. LLM start
    const start_body = {
      input: [{ type: "input_text", text: message }],
      metadata: {
        projectId: PROJECT_ID,
        userId: USER_ID,
        model: model,
        reasoning_effort: "low",
        frontend_origin: "https://prism.openai.com",
        sandbox_url: sandbox_url,
        sandbox_token: sandbox_token,
      },
    };

    const start_resp = await h2_request(c, "POST", "/api/llm/response_with_tools_start", start_body, hdrs, 90000);
    if (start_resp.status === "TIMEOUT") throw new Error("LLM start timed out");
    if (!start_resp.body?.request_id) throw new Error("LLM start failed: " + JSON.stringify(start_resp.body || start_resp).substring(0, 300));
    console.log("[prism] started: " + start_resp.body.request_id);

    // 8. Poll
    let turn_state = start_resp.body.turn_state;
    const max_polls = options.max_polls || 60;
    const poll_interval = options.poll_interval || 3000;

    for (let i = 0; i < max_polls; i++) {
      await new Promise((r) => setTimeout(r, poll_interval));

      const poll_body = { request_id: start_resp.body.request_id };
      if (turn_state) poll_body.turn_state = turn_state;

      const p = await h2_request(c, "POST", "/api/llm/response_with_tools_status", poll_body, hdrs, 15000);
      if (!p.body) {
        console.log("[prism] poll#" + (i + 1) + ": " + p.status);
        continue;
      }
      if (p.body.turn_state) turn_state = p.body.turn_state;

      const resp_status = p.body?.response?.status || "";
      const top_status = p.body?.status || "";
      if (i < 3 || top_status === "completed" || resp_status === "error") {
        console.log("[prism] poll#" + (i + 1) + ": " + top_status + "/" + resp_status);
      }

      // Extract text - output is inside response.payload.output
      let text = "";
      const output = p.body?.response?.payload?.output || p.body?.response?.output || [];
      for (const item of output) {
        if (item.type === "message") {
          for (const cc of (item.content || [])) {
            if (cc.type === "output_text") text += cc.text;
          }
        }
      }

      if (top_status === "completed" || resp_status === "error") {
        const listen_snapshot = p.body?.codex_listen_snapshot || p.body?.response?.codexListenSnapshot;
        const delta_files = p.body?.response?.codexDeltaFiles || [];
        console.log("[prism] done. text=" + text.substring(0, 100));
        return {
          text,
          listen_snapshot,
          delta_files,
          conversation_id: p.body?.response?.payload?.conversationId,
          raw: p.body,
        };
      }
    }

    throw new Error("LLM polling timed out");
  } finally {
    c.close();
  }
}

module.exports = { chat };
