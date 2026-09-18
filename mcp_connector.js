const fs = require("fs");
const path = require("path");
const cookie_manager = require("./cookie_manager");
const { resolve_route } = require("./routing_table");
const { build_llm_request, parse_prism_response } = require("./input_transformer");
const { destroy_h2_client } = require("./proxy_handler");

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", ".cache", ".turbo", ".output",
  "coverage", ".nyc_output", ".sass-cache", "tmp", ".tmp",
  ".dart_tool", ".gradle", "Pods", "DerivedData", ".fvm",
]);

const PROJECT_META_FILES = [
  "pubspec.yaml", "README.md", "analysis_options.yaml",
  ".gitignore", "build_apk.sh",
];

const MAX_SCAN_DEPTH = 5;
const MAX_FILE_READ_BYTES = 32 * 1024;
const MAX_TOTAL_CONTEXT_BYTES = 200 * 1024;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
];

const ACCEPT_LANGUAGES = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-US,en;q=0.9,ar;q=0.8",
];

let ua_index = 0;
let lang_index = 0;

function jsonrpc_result(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpc_error(id, code, message, data) {
  const error = { code, message };
  if (data) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function analyze_response_quality(response_data, method) {
  const warnings = [];
  const json_str = JSON.stringify(response_data || {});

  if (json_str.length < 10 && method !== "ping") {
    warnings.push("suspiciously_small_response");
  }

  const model = response_data?.model || response_data?.result?.model;
  if (model) {
    console.log(`[mcp] titan_check: model=${model}`);
  }

  if (response_data?.result?.is_truncated) {
    warnings.push("response_truncated");
  }

  return { warnings, model };
}

function is_safe_path(project_root, target_path) {
  const resolved = path.resolve(project_root, target_path);
  return resolved.startsWith(project_root);
}

function scan_directory(project_root, relative_path, depth, max_depth) {
  if (depth > max_depth) return [];
  const full_path = path.join(project_root, relative_path);
  let entries;
  try {
    entries = fs.readdirSync(full_path, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".env.example" && entry.name !== ".gitignore") continue;

    const rel = relative_path ? `${relative_path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push({ type: "dir", path: rel });
      results.push(...scan_directory(project_root, rel, depth + 1, max_depth));
    } else if (entry.isFile()) {
      let size = 0;
      try { size = fs.statSync(path.join(project_root, rel)).size; } catch {}
      results.push({ type: "file", path: rel, size });
    }
  }
  return results;
}

function read_pubspec(project_root) {
  try {
    const content = fs.readFileSync(path.join(project_root, "pubspec.yaml"), "utf8");
    const result = {};
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed.startsWith("name:")) result.name = trimmed.split(":")[1].trim();
      else if (trimmed.startsWith("description:")) result.description = trimmed.substring(12).trim().replace(/^"|"$/g, "");
      else if (trimmed.startsWith("version:")) result.version = trimmed.split(":")[1].trim();
    }

    const deps_match = content.match(/dependencies:\n([\s\S]*?)(?=\n\w|\ndev_dependencies:|$)/);
    if (deps_match) {
      result.dependencies = deps_match[1]
        .split("\n")
        .filter(l => l.match(/^\s+\w/) && !l.includes("sdk:"))
        .map(l => l.trim().split(":")[0].trim())
        .filter(Boolean);
    }

    return result;
  } catch {
    return null;
  }
}

function read_file_content(file_path, max_bytes) {
  try {
    const stat = fs.statSync(file_path);
    if (stat.size > max_bytes) {
      const fd = fs.openSync(file_path, "r");
      const buf = Buffer.alloc(max_bytes);
      fs.readSync(fd, buf, 0, max_bytes, 0);
      fs.closeSync(fd);
      return { content: buf.toString("utf8"), truncated: true, original_size: stat.size };
    }
    return { content: fs.readFileSync(file_path, "utf8"), truncated: false, original_size: stat.size };
  } catch {
    return null;
  }
}

function build_workspace_context(config, params) {
  if (!params || typeof params !== "object") return params;

  const project_root = config.project_root;
  if (!project_root || !fs.existsSync(project_root)) {
    return { ...params, _workspace: { error: "project_root not configured or not found" } };
  }

  const context = {
    _workspace: {
      project_root,
      project_name: path.basename(project_root),
      timestamp: new Date().toISOString(),
      platform: process.platform,
    },
  };

  const tree = scan_directory(project_root, "", 0, MAX_SCAN_DEPTH);
  context._workspace.project_tree = tree;
  context._workspace.total_files = tree.filter(e => e.type === "file").length;
  context._workspace.total_dirs = tree.filter(e => e.type === "dir").length;

  const pubspec = read_pubspec(project_root);
  if (pubspec) {
    context._workspace.pubspec = pubspec;
  }

  for (const file of PROJECT_META_FILES) {
    try {
      const content = fs.readFileSync(path.join(project_root, file), "utf8");
      const key = file.replace(/\./g, "_").replace(/-/g, "_");
      context._workspace[key] = content.substring(0, 2000);
    } catch {}
  }

  const file_path = params.file_path || params.path || params.file;
  if (file_path) {
    if (!is_safe_path(project_root, file_path)) {
      context._workspace.file_error = "path escapes project root";
    } else {
      const resolved = path.resolve(project_root, file_path);
      const rel = path.relative(project_root, resolved);
      context._workspace.requested_file = rel;

      const file_data = read_file_content(resolved, MAX_FILE_READ_BYTES);
      if (file_data) {
        context._workspace.file_content = file_data.content;
        context._workspace.file_truncated = file_data.truncated;
        context._workspace.file_size = file_data.original_size;
      } else {
        context._workspace.file_error = "file not readable";
      }
    }
  }

  if (params.files && Array.isArray(params.files)) {
    const file_contents = {};
    let total_bytes = 0;
    for (const fp of params.files) {
      if (!is_safe_path(project_root, fp)) continue;
      const resolved = path.resolve(project_root, fp);
      const rel = path.relative(project_root, resolved);
      const data = read_file_content(resolved, MAX_FILE_READ_BYTES);
      if (data && total_bytes + data.content.length <= MAX_TOTAL_CONTEXT_BYTES) {
        file_contents[rel] = {
          content: data.content,
          truncated: data.truncated,
          size: data.original_size,
        };
        total_bytes += data.content.length;
      }
    }
    if (Object.keys(file_contents).length > 0) {
      context._workspace.multi_files = file_contents;
    }
  }

  const context_str = JSON.stringify(context);
  if (context_str.length > MAX_TOTAL_CONTEXT_BYTES) {
    if (context._workspace.file_content && context._workspace.file_content.length > 4096) {
      context._workspace.file_content = context._workspace.file_content.substring(0, 4096) + "\n... [truncated]";
    }
    if (context._workspace.project_tree && context._workspace.project_tree.length > 200) {
      context._workspace.project_tree = context._workspace.project_tree.slice(0, 200);
      context._workspace.project_tree_truncated = true;
    }
  }

  return { ...params, _workspace: context._workspace };
}

function create_mcp_connector(config) {
  const refresh_wait_ms = config.refresh_wait_ms || 5000;
  const poll_interval = config.llm_poll_interval_ms || 1000;
  const max_polls = config.llm_max_poll_attempts || 60;
  const throttle_ms = config.throttle_ms || 800;
  const max_retries = config.max_retries || 3;
  const backoff_base_ms = config.backoff_base_ms || 2000;

  let last_request_time = 0;

  const sandbox_status = {
    state: "unknown",
    last_check: 0,
    consecutive_failures: 0,
    last_success: 0,
  };

  function set_sandbox_state(state) {
    const prev = sandbox_status.state;
    sandbox_status.state = state;
    sandbox_status.last_check = Date.now();
    if (state === "ready") {
      sandbox_status.consecutive_failures = 0;
      sandbox_status.last_success = Date.now();
    } else if (state === "reconnecting") {
      sandbox_status.consecutive_failures++;
    }
    if (prev !== state) {
      console.log(`[sandbox] state: ${prev} -> ${state} (failures=${sandbox_status.consecutive_failures})`);
    }
  }

  function simplify_for_sandbox(params) {
    if (!params || typeof params !== "object") return params;
    const simplified = { ...params };
    delete simplified._workspace;
    delete simplified.files;
    delete simplified.file_path;
    delete simplified.path;
    delete simplified.file;
    return simplified;
  }

  function build_plain_text_request(params) {
    if (!params) return { input: [{ type: "input_text", text: "" }], metadata: { conversationMode: "main" }, conversationId: null, previousResponseId: null };
    const text = params.message
      || params.prompt
      || params.text
      || params.input
      || params.query
      || (typeof params === "string" ? params : JSON.stringify(params));
    return {
      input: [{ type: "input_text", text: String(text) }],
      previousResponseId: null,
      metadata: { conversationMode: params.conversationMode || params.conversation_mode || "main" },
      conversationId: null,
    };
  }

  async function throttle_delay() {
    const now = Date.now();
    const elapsed = now - last_request_time;
    if (elapsed < throttle_ms) {
      const wait = throttle_ms - elapsed;
      console.log(`[mcp] throttling ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
    last_request_time = Date.now();
  }

  function rotate_identity() {
    ua_index = (ua_index + 1) % USER_AGENTS.length;
    lang_index = (lang_index + 1) % ACCEPT_LANGUAGES.length;
  }

  async function forward_to_proxy(method, path, body) {
    await throttle_delay();

    const proxy_url = `http://localhost:${config.proxy_port}${path}`;

    const cookies_obj = cookie_manager.load_cookies(config);
    const cookie_string = cookie_manager.build_cookie_string(cookies_obj);

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENTS[ua_index],
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": ACCEPT_LANGUAGES[lang_index],
      "Accept-Encoding": "gzip, deflate, br",
      "Referer": "https://prism.openai.com/",
      "Origin": "https://prism.openai.com",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
    };
    if (cookie_string) {
      headers["Cookie"] = cookie_string;
    }

    const fetch_options = {
      method: method,
      headers: headers,
    };
    if (body && ["POST", "PUT", "PATCH"].includes(method)) {
      fetch_options.body = JSON.stringify(body);
    }

    console.log(`[mcp] forwarding ${method} ${path} -> proxy:${config.proxy_port}`);

    const response = await fetch(proxy_url, fetch_options);

    const response_text = await response.text();
    let response_data;
    try {
      response_data = JSON.parse(response_text);
    } catch {
      response_data = { raw: response_text };
    }

    console.log(`[mcp] <- ${response.status} from ${path}`);

    if (response_data?.error === "unauthorized") {
      return { status: 401, data: response_data };
    }

    if (response.status === 400) {
      console.log(`[mcp] 400 detected, destroying H2 session`);
      destroy_h2_client();
    }

    if (response_data?.error === "sandbox_reconnecting" ||
        response_data?.response?.payload?.reason === "sandbox_reconnecting") {
      console.log(`[mcp] sandbox_reconnecting detected`);
      set_sandbox_state("reconnecting");
      return { status: 200, data: response_data, sandbox_reconnecting: true };
    }

    return { status: response.status, data: response_data };
  }

  async function poll_llm_status(request_id, turn_state) {
    for (let attempt = 0; attempt < max_polls; attempt++) {
      await new Promise(r => setTimeout(r, poll_interval));

      try {
        const result = await forward_to_proxy("POST", "/api/llm/response_with_tools_status", {
          request_id,
          turn_state,
        });

        if (result.status === 200) {
          const parsed = parse_prism_response(result.data);
          if (parsed.status === "completed") {
            return parsed;
          }
          if (parsed.status === "pending" && parsed.turn_state) {
            turn_state = parsed.turn_state;
            continue;
          }
        }

        if (result.status === 401) {
          return { status: "unauthorized", error: "tokens expired during polling" };
        }
      } catch (err) {
        console.error(`[mcp] poll error attempt ${attempt + 1}: ${err.message}`);
      }
    }

    return { status: "timeout", error: `LLM did not complete after ${max_polls} polls` };
  }

  async function forward_with_retry_and_simplify(method, path, body, params) {
    const total_attempts = max_retries + 2;
    let last_result = null;

    for (let attempt = 0; attempt < total_attempts; attempt++) {
      if (attempt > 0) {
        const backoff = backoff_base_ms * Math.pow(2, Math.min(attempt - 1, 3));
        console.log(`[mcp] retry attempt ${attempt + 1}/${total_attempts} after ${backoff}ms (simplify_level=${attempt})`);
        await new Promise(r => setTimeout(r, backoff));
        rotate_identity();
        destroy_h2_client();
      }

      let current_body = body;

      if (attempt === 1 && params && typeof params === "object" && params._workspace) {
        console.log(`[mcp] simplifying: removing workspace context`);
        current_body = build_llm_request(simplify_for_sandbox(params));
      } else if (attempt >= 2) {
        console.log(`[mcp] simplifying: plain text mode`);
        current_body = build_plain_text_request(params || body || {});
      }

      try {
        const result = await forward_to_proxy(method, path, current_body);

        if (result.sandbox_reconnecting) {
          console.log(`[mcp] sandbox_reconnecting on attempt ${attempt + 1}`);
          last_result = result;
          continue;
        }

        return result;
      } catch (err) {
        console.error(`[mcp] attempt ${attempt + 1} failed: ${err.message}`);
        last_result = err;
      }
    }

    return last_result;
  }

  async function handle_mcp_request(jsonrpc_request) {
    const { id, method, params } = jsonrpc_request;

    console.log(`[mcp] incoming request: id=${id} method=${method}`);

    if (!method || typeof method !== "string" || method.length === 0) {
      console.log(`[mcp] ERROR: missing or invalid method field`);
      return jsonrpc_error(id || null, -32600, "Invalid Request: method must be a non-empty string");
    }

    if (jsonrpc_request.jsonrpc !== "2.0") {
      return jsonrpc_error(id || null, -32600, "Invalid Request: jsonrpc must be '2.0'");
    }

    const route = resolve_route(method);

    if (!route) {
      console.log(`[mcp] WARNING: unmapped method "${method}" — trying LLM fallback`);
      const llm_route = resolve_route("tools/call");
      if (llm_route) {
        const prism_input = build_llm_request(params);
        const result = await forward_with_retry_and_simplify(llm_route.method, llm_route.path, prism_input, params);
        return handle_llm_result(id, method, result, params);
      }
      return jsonrpc_error(id, -32601, `Method not found: ${method}`);
    }

    let request_body = null;
    if (route.method === "POST") {
      if (route.route_key === "llm.start") {
        const enriched = build_workspace_context(config, params);
        request_body = build_llm_request(enriched);
      } else if (route.route_key === "llm.status") {
        request_body = { request_id: params?.request_id, turn_state: params?.turn_state };
      } else if (route.route_key === "llm.stop") {
        request_body = { request_id: params?.request_id, conversation_id: params?.conversation_id, turn_state: params?.turn_state };
      } else {
        request_body = params || {};
      }
    }

    let result;
    try {
      if (route.route_key === "llm.start") {
        result = await forward_with_retry_and_simplify(route.method, route.path, request_body, params);
      } else {
        result = await forward_to_proxy(route.method, route.path, request_body);
      }
    } catch (err) {
      console.error(`[mcp] connection error: ${err.message}`);
      return jsonrpc_error(id, -32000, `Connection error: ${err.message}`);
    }

    if (!result || result.status === undefined) {
      console.error(`[mcp] no result after retries`);
      return jsonrpc_error(id, -32000, "All retries failed");
    }

    if (result.status === 401) {
      console.log(`[mcp] ============================================`);
      console.log(`[mcp] UNAUTHORIZED (401) — TOKENS EXPIRED`);
      console.log(`[mcp] Waiting ${refresh_wait_ms}ms for token refresh...`);
      console.log(`[mcp] ============================================`);

      await new Promise((resolve) => setTimeout(resolve, refresh_wait_ms));

      try {
        result = await forward_to_proxy(route.method, route.path, request_body);
      } catch (retry_err) {
        console.error(`[mcp] retry failed: ${retry_err.message}`);
        return jsonrpc_error(id, -32000, `Retry failed: ${retry_err.message}`);
      }

      if (result.status === 401) {
        return jsonrpc_error(id, -32001, "Unauthorized: tokens expired and refresh failed");
      }
    }

    if (result.status >= 400 && result.status !== 401) {
      console.log(`[mcp] upstream error: ${result.status}`);
      return jsonrpc_error(id, -32002, `Upstream error: ${result.status}`, result.data);
    }

    if (route.route_key === "llm.start") {
      return handle_llm_result(id, method, result, params);
    }

    const analysis = analyze_response_quality(result.data, method);
    if (analysis.warnings.length > 0) {
      console.log(`[mcp] titan_check warnings: ${analysis.warnings.join(", ")}`);
    }

    console.log(`[mcp] request completed: id=${id} method=${method}`);
    return jsonrpc_result(id, result.data);
  }

  async function handle_llm_result(id, method, result, params) {
    const parsed = parse_prism_response(result.data);

    if (parsed.status === "started" && parsed.request_id) {
      console.log(`[mcp] LLM started, polling for completion... (request_id=${parsed.request_id})`);
      const final = await poll_llm_status(parsed.request_id, parsed.turn_state);
      if (final.status === "completed") {
        console.log(`[mcp] LLM completed with response`);
        set_sandbox_state("ready");
        return jsonrpc_result(id, { text: final.text, raw: final.raw });
      }
      if (final.status === "unauthorized") {
        return jsonrpc_error(id, -32001, final.error);
      }
      return jsonrpc_error(id, -32003, final.error || "LLM polling failed");
    }

    if (parsed.status === "completed") {
      console.log(`[mcp] LLM completed synchronously`);
      set_sandbox_state("ready");
      return jsonrpc_result(id, { text: parsed.text, raw: parsed.raw });
    }

    if (parsed.status === "sandbox_reconnecting") {
      set_sandbox_state("reconnecting");
      return jsonrpc_error(id, -32003, `Prism sandbox restarting (state=${sandbox_status.state}, failures=${sandbox_status.consecutive_failures}). Retrying with simplified request...`);
    }

    console.log(`[mcp] LLM response: status=${parsed.status}`);
    return jsonrpc_result(id, result.data);
  }

  return {
    handle_mcp_request,
    forward_to_proxy,
    sandbox_status,
  };
}

module.exports = { create_mcp_connector };
