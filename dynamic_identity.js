const crypto = require("crypto");

const USER_AGENTS = {
  chrome_windows: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  ],
  chrome_mac: [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  ],
  firefox_windows: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  ],
  firefox_mac: [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
  ],
  safari_mac: [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  ],
};

const ACCEPT_LANGUAGES = [
  "en-US,en;q=0.9",
  "en-US,en;q=0.9,ar;q=0.8",
  "en-US,en;q=0.9,es;q=0.8",
  "en-GB,en;q=0.9",
  "en-US,en;q=0.9,fr;q=0.8",
  "en-US,en;q=0.9,de;q=0.8",
  "en-US,en;q=0.9,ja;q=0.8",
];

const CHROME_UA_KEYS = [
  { key: "sec-ch-ua", values: [
    '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="24"',
    '"Google Chrome";v="129", "Chromium";v="129", "Not_A Brand";v="24"',
    '"Chromium";v="131", "Google Chrome";v="131", "Not?A_Brand";v="24"',
  ]},
  { key: "sec-ch-ua-mobile", values: ["?0"] },
  { key: "sec-ch-ua-platform", values: ['"Windows"', '"macOS"', '"Linux"'] },
];

const FIREFOX_UA_KEYS = [
  { key: "Accept", values: ["text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"] },
];

const SAFARI_UA_KEYS = [
  { key: "Accept", values: ["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"] },
];

const FETCH_MODES = ["cors", "same-origin", "navigate"];
const FETCH Dest = ["document", "empty", "script"];
const FETCH_SITES = ["same-origin", "cross-site", "none"];

const CONTENT_TYPE_PROFILES = {
  api_json: {
    accept: "application/json, text/plain, */*",
    sec_fetch_mode: "cors",
    sec_fetch_dest: "empty",
    sec_fetch_site: "same-origin",
  },
  html_page: {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    sec_fetch_mode: "navigate",
    sec_fetch_dest: "document",
    sec_fetch_site: "none",
  },
  script: {
    accept: "*/*",
    sec_fetch_mode: "no-cors",
    sec_fetch_dest: "script",
    sec_fetch_site: "cross-site",
  },
};

function pick_random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function get_browser_family(ua) {
  if (ua.includes("Firefox")) return "firefox";
  if (ua.includes("Safari") && !ua.includes("Chrome")) return "safari";
  return "chrome";
}

function generate_identity(options = {}) {
  const {
    content_type = "api_json",
    force_browser = null,
    force_os = null,
  } = options;

  let ua_pool;
  if (force_browser) {
    ua_pool = USER_AGENTS[force_browser] || USER_AGENTS.chrome_windows;
  } else {
    const all_keys = Object.keys(USER_AGENTS);
    const key = pick_random(all_keys);
    ua_pool = USER_AGENTS[key];
  }

  const ua = pick_random(ua_pool);
  const browser = get_browser_family(ua);
  const profile = CONTENT_TYPE_PROFILES[content_type] || CONTENT_TYPE_PROFILES.api_json;

  const headers = {
    "User-Agent": ua,
    "Accept": profile.accept,
    "Accept-Language": pick_random(ACCEPT_LANGUAGES),
    "Accept-Encoding": "gzip, deflate, br",
    "sec-ch-ua-platform": pick_random(CHROME_UA_KEYS[2].values),
    "Sec-Fetch-Mode": profile.sec_fetch_mode,
    "Sec-Fetch-Dest": profile.sec_fetch_dest,
    "Sec-Fetch-Site": profile.sec_fetch_site,
  };

  if (browser === "chrome") {
    headers["sec-ch-ua"] = pick_random(CHROME_UA_KEYS[0].values);
    headers["sec-ch-ua-mobile"] = "?0";
  }

  if (browser === "firefox") {
    delete headers["sec-ch-ua"];
    delete headers["sec-ch-ua-mobile"];
    delete headers["sec-ch-ua-platform"];
    headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  }

  if (browser === "safari") {
    delete headers["sec-ch-ua"];
    delete headers["sec-ch-ua-mobile"];
    delete headers["sec-ch-ua-platform"];
    headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  }

  return {
    ua,
    browser,
    headers,
    fingerprint: crypto.createHash("sha256").update(ua).digest("hex").substring(0, 12),
  };
}

function naturalize_request(incoming_headers, identity) {
  const natural = {};

  const passthrough = [
    "content-type", "content-length", "cookie", "authorization",
    "accept", "accept-language", "accept-encoding",
    "origin", "referer", "host",
  ];

  for (const [key, value] of Object.entries(incoming_headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith(":")) continue;
    if (lower === "user-agent") continue;
    if (lower.startsWith("sec-ch-ua") && identity.browser !== "chrome") continue;
    if (lower.startsWith("sec-fetch") && !CONTENT_TYPE_PROFILES.api_json) continue;
    if (passthrough.includes(lower)) {
      natural[lower] = value;
    }
  }

  Object.assign(natural, identity.headers);

  if (incoming_headers.referer) {
    natural["referer"] = incoming_headers.referer;
  }
  if (incoming_headers.origin) {
    natural["origin"] = incoming_headers.origin;
  }

  return natural;
}

function rotate_identity(current_fingerprint, cooldown_ms = 300000) {
  let new_identity;
  let attempts = 0;
  do {
    new_identity = generate_identity();
    attempts++;
  } while (new_identity.fingerprint === current_fingerprint && attempts < 5);
  return new_identity;
}

module.exports = {
  generate_identity,
  naturalize_request,
  rotate_identity,
  get_browser_family,
  CONTENT_TYPE_PROFILES,
  USER_AGENTS,
};
