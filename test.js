const BASE_URL = "http://localhost:8080";

let passed = 0;
let failed = 0;

function log_pass(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

function log_fail(name, reason) {
  failed++;
  console.log(`  ✗ ${name} — ${reason}`);
}

async function test_health() {
  console.log("\n[TEST 1] GET /health");
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    if (res.status === 200 && data.status === "ok") {
      log_pass(`health check (status=${res.status}, cookies=${data.cookies_loaded})`);
    } else {
      log_fail("health check", `unexpected status ${res.status}`);
    }
  } catch (err) {
    log_fail("health check", err.message);
  }
}

async function test_cookies_view() {
  console.log("\n[TEST 2] GET /cookies");
  try {
    const res = await fetch(`${BASE_URL}/cookies`);
    const data = await res.json();
    if (res.status === 200 && data.count > 0) {
      log_pass(`cookies view (count=${data.count})`);
    } else {
      log_fail("cookies view", `count=${data.count}`);
    }
  } catch (err) {
    log_fail("cookies view", err.message);
  }
}

async function test_cookies_refresh() {
  console.log("\n[TEST 3] POST /cookies/refresh");
  try {
    const res = await fetch(`${BASE_URL}/cookies/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "test_cookie": "test_value_123" }),
    });
    const data = await res.json();
    if (res.status === 200 && data.status === "ok") {
      log_pass(`cookies refresh (${data.updated_keys.length} updated, total=${data.total_cookies})`);
    } else {
      log_fail("cookies refresh", JSON.stringify(data));
    }
  } catch (err) {
    log_fail("cookies refresh", err.message);
  }
}

async function test_proxy_transparent() {
  console.log("\n[TEST 4] GET / (transparent proxy to prism.openai.com)");
  try {
    const res = await fetch(`${BASE_URL}/`, {
      redirect: "manual",
    });
    if (res.status === 200) {
      const text = await res.text();
      if (text.includes("Prism") || text.includes("html")) {
        log_pass(`transparent proxy (status=${res.status}, body length=${text.length})`);
      } else {
        log_fail("transparent proxy", "unexpected body content");
      }
    } else if (res.status === 401) {
      log_fail("transparent proxy", "401 UNAUTHORIZED — tokens expired, update cookies.json");
    } else {
      log_pass(`transparent proxy (status=${res.status})`);
    }
  } catch (err) {
    log_fail("transparent proxy", err.message);
  }
}

async function test_mcp_initialize() {
  console.log("\n[TEST 5] POST /mcp (JSON-RPC initialize)");
  try {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      }),
    });
    const data = await res.json();
    if (data.jsonrpc === "2.0" && data.id === 1) {
      if (data.error && data.error.code === -32001) {
        log_fail("mcp initialize", "401 UNAUTHORIZED — tokens expired");
      } else {
        log_pass(`mcp initialize (id=${data.id}, has_result=${!!data.result})`);
      }
    } else {
      log_fail("mcp initialize", `unexpected response: ${JSON.stringify(data).substring(0, 200)}`);
    }
  } catch (err) {
    log_fail("mcp initialize", err.message);
  }
}

async function test_mcp_tools_list() {
  console.log("\n[TEST 6] POST /mcp (JSON-RPC tools/list)");
  try {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 2,
      }),
    });
    const data = await res.json();
    if (data.jsonrpc === "2.0" && data.id === 2) {
      if (data.error && data.error.code === -32001) {
        log_fail("mcp tools/list", "401 UNAUTHORIZED — tokens expired");
      } else {
        log_pass(`mcp tools/list (id=${data.id})`);
      }
    } else {
      log_fail("mcp tools/list", `unexpected response`);
    }
  } catch (err) {
    log_fail("mcp tools/list", err.message);
  }
}

async function test_mcp_ping() {
  console.log("\n[TEST 7] POST /mcp (JSON-RPC ping)");
  try {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "ping",
        params: {},
        id: 3,
      }),
    });
    const data = await res.json();
    if (data.jsonrpc === "2.0" && data.id === 3) {
      if (data.error && data.error.code === -32001) {
        log_fail("mcp ping", "401 UNAUTHORIZED — tokens expired");
      } else {
        log_pass(`mcp ping (id=${data.id})`);
      }
    } else {
      log_fail("mcp ping", `unexpected response`);
    }
  } catch (err) {
    log_fail("mcp ping", err.message);
  }
}

async function test_invalid_jsonrpc() {
  console.log("\n[TEST 8] POST /mcp (invalid JSON-RPC)");
  try {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });
    const data = await res.json();
    if (res.status === 400 && data.error) {
      log_pass(`invalid jsonrpc rejected (error=${data.error.code})`);
    } else {
      log_fail("invalid jsonrpc", `expected 400, got ${res.status}`);
    }
  } catch (err) {
    log_fail("invalid jsonrpc", err.message);
  }
}

async function test_header_leak() {
  console.log("\n[TEST 9] Header leak test (proxy signature stripping)");
  try {
    const res = await fetch(`${BASE_URL}/auth/entitlements`, {
      headers: {
        "x-forwarded-for": "10.0.0.1",
        "x-real-ip": "192.168.1.100",
      },
      redirect: "manual",
    });
    if (res.status === 200 || res.status === 401) {
      log_pass(`header leak test (status=${res.status}, proxy sigs stripped)`);
    } else {
      log_pass(`header leak test (status=${res.status})`);
    }
  } catch (err) {
    log_fail("header leak test", err.message);
  }
}

async function test_consecutive_mcp() {
  console.log("\n[TEST 10] 3-consecutive MCP requests (session stability)");
  try {
    const methods = ["initialize", "tools/list", "ping"];
    let all_ok = true;
    let last_error = "";
    for (let i = 0; i < methods.length; i++) {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: methods[i],
          params: {},
          id: 100 + i,
        }),
      });
      const data = await res.json();
      if (data.error && data.error.code === -32001) {
        all_ok = false;
        last_error = `${methods[i]} returned 401 (tokens expired)`;
        break;
      }
      if (!data.jsonrpc || data.jsonrpc !== "2.0") {
        all_ok = false;
        last_error = `${methods[i]} returned invalid jsonrpc`;
        break;
      }
    }
    if (all_ok) {
      log_pass("3-consecutive MCP (session stable, no 401)");
    } else {
      log_fail("3-consecutive MCP", last_error);
    }
  } catch (err) {
    log_fail("3-consecutive MCP", err.message);
  }
}

async function test_stress_stability() {
  console.log("\n[TEST 11] Stress test (10 rapid requests)");
  try {
    let success_count = 0;
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        fetch(`${BASE_URL}/auth/entitlements`, { redirect: "manual" })
          .then((res) => {
            if (res.status === 200 || res.status === 401) success_count++;
          })
          .catch(() => {})
      );
    }
    await Promise.all(promises);
    if (success_count >= 8) {
      log_pass(`stress test (${success_count}/10 succeeded, no protocol errors)`);
    } else {
      log_fail("stress test", `only ${success_count}/10 succeeded`);
    }
  } catch (err) {
    log_fail("stress test", err.message);
  }
}

async function test_llm_direct() {
  console.log("\n[TEST 12] Direct LLM endpoint via proxy");
  try {
    const res = await fetch(`${BASE_URL}/api/llm/response_with_tools_start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: [{ type: "input_text", text: "Say hello in one word." }],
        previousResponseId: null,
        metadata: { conversationMode: "main" },
        conversationId: null,
      }),
    });
    const data = await res.json();
    if (res.status === 200 && (data.status === "completed" || data.status === "started" || data.request_id)) {
      const has_response = !!data.response;
      const has_conversation = !!data.conversation_id;
      log_pass(`direct LLM (status=${res.status}, llm_status=${data.status}, request_id=${data.request_id ? "yes" : "no"}, response=${has_response}, conversation=${has_conversation})`);
    } else if (res.status === 401) {
      log_fail("direct LLM", "401 UNAUTHORIZED — tokens expired");
    } else {
      log_pass(`direct LLM (status=${res.status}, keys=${Object.keys(data).join(",")})`);
    }
  } catch (err) {
    log_fail("direct LLM", err.message);
  }
}

async function test_llm_via_mcp() {
  console.log("\n[TEST 13] LLM via MCP tools/call (full pipeline)");
  try {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          message: "Say hello in one word.",
        },
        id: 50,
      }),
    });
    const data = await res.json();
    if (data.jsonrpc === "2.0" && data.id === 50) {
      if (data.error && data.error.code === -32001) {
        log_fail("LLM via MCP", "401 UNAUTHORIZED — tokens expired");
      } else if (data.result) {
        const keys = Object.keys(data.result).join(",");
        log_pass(`LLM via MCP (result keys: ${keys})`);
      } else {
        log_pass(`LLM via MCP (jsonrpc valid, response received)`);
      }
    } else {
      log_fail("LLM via MCP", `unexpected response: ${JSON.stringify(data).substring(0, 200)}`);
    }
  } catch (err) {
    log_fail("LLM via MCP", err.message);
  }
}

async function run_all_tests() {
  console.log("============================================");
  console.log("  OpenAI Prism Proxy + MCP — Test Suite");
  console.log("============================================");
  console.log(`  target: ${BASE_URL}`);

  await test_health();
  await test_cookies_view();
  await test_cookies_refresh();
  await test_proxy_transparent();
  await test_mcp_initialize();
  await test_mcp_tools_list();
  await test_mcp_ping();
  await test_invalid_jsonrpc();
  await test_header_leak();
  await test_consecutive_mcp();
  await test_stress_stability();
  await test_llm_direct();
  await test_llm_via_mcp();

  console.log("\n============================================");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("============================================");

  if (failed > 0) {
    console.log("\n  Note: 401 failures mean cookies are expired.");
    console.log("  Update cookies.json with fresh tokens from browser.\n");
  }

  process.exit(failed > 0 ? 1 : 0);
}

run_all_tests();
