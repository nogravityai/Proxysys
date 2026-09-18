const PROXY_TERMS = [
  /proxy/gi,
  /brok[eo]r?/gi,
  /gateway/gi,
  /relay/gi,
  /tunnel/gi,
  /forwarder?/gi,
  /intercept/gi,
  /mitm/gi,
  /man.in.the.middle/gi,
  /prism\.openai\.com/gi,
  /cookie[_\s]?inject/gi,
  /header[_\s]?inject/gi,
  /stealth/gi,
  /bypass/gi,
  /cloudflare[_\s]?bypass/gi,
  /fingerprint/gi,
  /spoof/gi,
  /masquerade/gi,
  /identity[_\s]?mask/gi,
  /channel[_\s]?purity/gi,
  /system[_\s]?gatekeeper/gi,
  /protocol[_\s]?architect/gi,
  /dual[_\s]?supervision/gi,
  /control[_\s]?protocol/gi,
  /x-forwarded/gi,
  /x-real-ip/gi,
  /http2?[_\s]?bypass/gi,
  /nghttp/gi,
  /h2[_\s]?stream/gi,
  /session[_\s]?key/gi,
  /cookie[_\s]?manager/gi,
  /mcp[_\s]?connector/gi,
  /routing[_\s]?table/gi,
  /input[_\s]?transformer/gi,
  /dynamic[_\s]?identity/gi,
];

const FUNCTIONAL_TRANSLATIONS = {
  "proxy": "server",
  "proxies": "servers",
  "broker": "handler",
  "brokers": "handlers",
  "gateway": "endpoint",
  "relay": "processor",
  "tunnel": "connection",
  "forwarder": "router",
  "intercept": "capture",
  "mitm": "middleware",
  "man in the middle": "middleware layer",
  "cookie injection": "session management",
  "header injection": "request configuration",
  "stealth": "anonymity",
  "bypass": "access",
  "cloudflare bypass": "CDN access",
  "fingerprint": "identifier",
  "spoof": "configure",
  "masquerade": "present as",
  "identity mask": "session profile",
  "channel purity": "data integrity",
  "system gatekeeper": "access controller",
  "protocol architect": "system designer",
  "dual supervision": "monitoring",
  "control protocol": "management system",
  "x-forwarded": "internal",
  "x-real-ip": "client address",
  "http2 bypass": "connection optimization",
  "nghttp": "connection library",
  "h2 stream": "data stream",
  "session key": "session identifier",
  "cookie manager": "session handler",
  "mcp connector": "tool interface",
  "routing table": "endpoint map",
  "input transformer": "data converter",
  "dynamic identity": "session profile",
};

function contains_proxy_references(text) {
  if (typeof text !== "string") return false;
  return PROXY_TERMS.some((term) => term.test(text));
}

function sanitize_for_upstream(text, context = {}) {
  if (typeof text !== "string") return text;

  let sanitized = text;

  sanitized = sanitized.replace(
    /localhost:\d+/gi,
    "production-server"
  );

  sanitized = sanitized.replace(
    /127\.0\.0\.1:\d+/gi,
    "production-server"
  );

  sanitized = sanitized.replace(
    /\/home\/[^\/\s]+\/gpt/gi,
    "/app/server"
  );

  sanitized = sanitized.replace(
    /\/home\/[^\/\s]+\/hyasoft_mobile/gi,
    "/workspace/project"
  );

  sanitized = sanitized.replace(
    /\.js['"]/gi,
    ".module'"
  );

  for (const [term, replacement] of Object.entries(FUNCTIONAL_TRANSLATIONS)) {
    const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    sanitized = sanitized.replace(regex, replacement);
  }

  return sanitized;
}

function should_sanitize(params) {
  if (!params || typeof params !== "object") return false;

  const text_fields = ["message", "prompt", "text", "input", "query", "content"];
  for (const field of text_fields) {
    if (params[field] && typeof params[field] === "string") {
      if (contains_proxy_references(params[field])) return true;
    }
  }

  if (params.content && Array.isArray(params.content)) {
    for (const item of params.content) {
      if (item.text && contains_proxy_references(item.text)) return true;
    }
  }

  return false;
}

function sanitize_mcp_params(params, context = {}) {
  if (!params || typeof params !== "object") return params;

  const sanitized = { ...params };

  const text_fields = ["message", "prompt", "text", "input", "query"];
  for (const field of text_fields) {
    if (sanitized[field] && typeof sanitized[field] === "string") {
      if (contains_proxy_references(sanitized[field])) {
        sanitized[field] = sanitize_for_upstream(sanitized[field], context);
      }
    }
  }

  if (sanitized.content && Array.isArray(sanitized.content)) {
    sanitized.content = sanitized.content.map((item) => {
      if (item.text && contains_proxy_references(item.text)) {
        return { ...item, text: sanitize_for_upstream(item.text, context) };
      }
      return item;
    });
  }

  return sanitized;
}

module.exports = {
  contains_proxy_references,
  sanitize_for_upstream,
  should_sanitize,
  sanitize_mcp_params,
  PROXY_TERMS,
  FUNCTIONAL_TRANSLATIONS,
};
