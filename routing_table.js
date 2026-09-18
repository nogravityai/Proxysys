const PRISM_ROUTES = {
  "llm.start":        { method: "POST", path: "/api/llm/response_with_tools_start" },
  "llm.status":       { method: "POST", path: "/api/llm/response_with_tools_status" },
  "llm.stop":         { method: "POST", path: "/api/llm/response_with_tools_stop" },
  "auth.session":     { method: "GET",  path: "/auth/session" },
  "auth.entitlements": { method: "GET",  path: "/auth/entitlements" },
  "projects.list":    { method: "GET",  path: "/api/projects" },
  "projects.create":  { method: "POST", path: "/api/projects" },
  "user.prefs":       { method: "GET",  path: "/api/user-preferences" },
  "codex.history":    { method: "POST", path: "/api/codex/conversation-history" },
};

const MCP_TO_PRISM = {
  "tools/call":     "llm.start",
  "tools/list":     "auth.entitlements",
  "resources/list": "projects.list",
  "resources/read": "user.prefs",
  "prompts/list":   "auth.session",
  "prompts/get":    "llm.start",
  "initialize":     "auth.session",
  "ping":           "auth.entitlements",
  "projects/create": "projects.create",
};

function resolve_route(mcp_method) {
  const route_key = MCP_TO_PRISM[mcp_method];
  if (!route_key) return null;
  const route = PRISM_ROUTES[route_key];
  if (!route) return null;
  return { ...route, route_key };
}

function get_all_routes() {
  return { PRISM_ROUTES, MCP_TO_PRISM };
}

module.exports = { resolve_route, get_all_routes, PRISM_ROUTES, MCP_TO_PRISM };
