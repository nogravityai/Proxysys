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

  project_root: "/home/hya/hyasoft_mobile",

  discovery_mode: true,
  discovery_endpoints: ["/auth/entitlements", "/api/projects", "/auth/session"],
  llm_poll_interval_ms: 1000,
  llm_max_poll_attempts: 60,
  throttle_ms: 800,
  max_retries: 3,
  backoff_base_ms: 2000,

  injected_headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "sec-ch-ua": "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Cache-Control": "no-cache",
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
    "x-forwarded-for",
    "x-real-ip",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-client-ip",
    "via",
    "forwarded",
  ],
});
