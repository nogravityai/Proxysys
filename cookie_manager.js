const fs = require("fs");
const path = require("path");

function get_cookies_path(config) {
  return path.resolve(config.cookies_file);
}

function load_cookies(config) {
  const cookies_path = get_cookies_path(config);
  try {
    const data = fs.readFileSync(cookies_path, "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      const result = {};
      for (const c of parsed) {
        if (c.name && c.value !== undefined) result[c.name] = c.value;
      }
      return result;
    }
    return parsed;
  } catch (err) {
    console.error(`[cookie_manager] failed to load cookies: ${err.message}`);
    return {};
  }
}

function load_cookies_full(config) {
  const cookies_path = get_cookies_path(config);
  try {
    const data = fs.readFileSync(cookies_path, "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      const result = {};
      for (const c of parsed) {
        if (c.name) result[c.name] = c;
      }
      return result;
    }
    const result = {};
    for (const [k, v] of Object.entries(parsed)) {
      result[k] = { name: k, value: v };
    }
    return result;
  } catch (err) {
    console.error(`[cookie_manager] failed to load full cookies: ${err.message}`);
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

function build_cookie_string(cookies_input) {
  const now = Math.floor(Date.now() / 1000);
  return Object.entries(cookies_input)
    .filter(([_, val]) => {
      if (val && typeof val === "object" && val.value !== undefined) {
        if (val.expirationDate && val.expirationDate <= now) return false;
      }
      return true;
    })
    .map(([key, val]) => {
      const value = (val && typeof val === "object" && val.value !== undefined) ? val.value : val;
      return `${key}=${value}`;
    })
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
  load_cookies_full,
  save_cookies,
  build_cookie_string,
  parse_cookie_header,
  capture_set_cookie,
  merge_cookies,
  replace_all_cookies,
};
