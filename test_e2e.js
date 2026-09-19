#!/usr/bin/env node
const http2 = require('http2');
const fs = require('fs');

const cookies = JSON.parse(fs.readFileSync('cookies.json', 'utf8'));
const cookieStr = Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');

let requestNum = 0;

function req(client, method, path, body, extraHeaders, timeout) {
  return new Promise((resolve) => {
    const h = {
      ':method': method, ':path': path, ':authority': 'prism.openai.com', ':scheme': 'https',
      'content-type': 'application/json', 'cookie': cookieStr,
      'authorization': 'Bearer ' + cookies.prism_oai_access_token,
      'origin': 'https://prism.openai.com', 'referer': 'https://prism.openai.com/',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      ...extraHeaders,
    };
    const r = client.request(h);
    let status;
    r.on('response', hh => { status = hh[':status']; });
    const ch = [];
    r.on('data', c => ch.push(c));
    r.setTimeout(timeout || 30000);
    r.on('timeout', () => { r.close(); resolve({ status: 'TIMEOUT' }); });
    r.on('end', () => {
      const b = Buffer.concat(ch).toString();
      try { resolve({ status, body: JSON.parse(b) }); }
      catch { resolve({ status, raw: b.substring(0, 500) }); }
    });
    r.on('error', e => resolve({ status: 'ERR', error: e.message }));
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
}

function freshClient() {
  return http2.connect('https://prism.openai.com:443', { rejectUnauthorized: false });
}

async function setupSandbox(c) {
  const ry = await req(c, 'POST', '/api/y', {
    docId: '6b12b4c3-90c6-4eb2-8b35-e5a7f6a25c49',
    requestContext: { source: 'initial-bootstrap' }
  });
  console.log('[y] ' + ry.status);

  const r1 = await req(c, 'POST', '/api/backend/1/new', {});
  console.log('[new] ' + r1.status);
  const { token, url: sandboxUrl } = r1.body;
  const sp = new URL(sandboxUrl).pathname;

  const r2 = await req(c, 'POST', '/api/projects/6b12b4c3-90c6-4eb2-8b35-e5a7f6a25c49/sandbox/resources-token', {
    sandbox_session_id: null, sandbox_token: token
  });
  console.log('[rt-api] ' + r2.status);

  await req(c, 'POST', sp + 'resources-token', {
    token: r2.body.access_token,
    resourceBaseUrl: ry.body.baseUrl + '/',
    projectId: '6b12b4c3-90c6-4eb2-8b35-e5a7f6a25c49'
  }, { 'x-crixet-sandbox-token': token });
  console.log('[rt-sandbox] done');

  await req(c, 'POST', sp + 'token', ry.body, { 'x-crixet-sandbox-token': token });
  console.log('[token] done');

  for (let i = 0; i < 5; i++) {
    const rw = await req(c, 'GET', sp + 'wait-for-sync?wait_ms=10000', null, { 'x-crixet-sandbox-token': token }, 20000);
    if (rw.body?.status === 'synced') { console.log('[sync] synced'); break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  return { token, sandboxUrl };
}

async function chat(c, token, sandboxUrl, message) {
  const r = await req(c, 'POST', '/api/llm/response_with_tools_start', {
    input: [{ type: 'input_text', text: message }],
    metadata: {
      projectId: '6b12b4c3-90c6-4eb2-8b35-e5a7f6a25c49',
      userId: 'user-50eExBVyN8G7EdyjTcxSfOH2',
      model: 'gpt-5.6-sol', reasoning_effort: 'low',
      frontend_origin: 'https://prism.openai.com',
      sandbox_url: sandboxUrl, sandbox_token: token,
    },
  }, null, 90000);

  if (r.status === 'TIMEOUT') {
    console.log('[LLM] TIMEOUT - retrying with fresh connection...');
    return null;
  }
  if (!r.body || !r.body.request_id) {
    console.log('[LLM] Failed: ' + JSON.stringify(r).substring(0, 200));
    return null;
  }

  console.log('[LLM] started: ' + r.body.request_id);
  let turnState = r.body.turn_state;

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pb = { request_id: r.body.request_id };
    if (turnState) pb.turn_state = turnState;
    const p = await req(c, 'POST', '/api/llm/response_with_tools_status', pb, null, 15000);
    if (!p.body) continue;
    if (p.body.turn_state) turnState = p.body.turn_state;
    const rs = p.body?.response?.status || '';
    const output = p.body?.response?.output || [];

    if (i < 3 || rs === 'completed' || rs === 'error' || output.length > 0) {
      console.log('[' + (i + 1) + '] ' + rs + ' items=' + output.length);
    }

    for (const item of output) {
      if (item.type === 'message') {
        for (const cc of (item.content || [])) {
          if (cc.type === 'output_text') {
            console.log('\n===== AGENT RESPONSE =====');
            console.log(cc.text);
            console.log('==========================\n');
          }
        }
      } else if (item.type === 'function_call') {
        console.log('  TOOL_CALL: ' + item.name);
      } else if (item.type === 'function_call_output') {
        console.log('  TOOL_OUTPUT: ' + String(item.output).substring(0, 100));
      }
    }

    if (rs === 'completed' || rs === 'error') {
      return p.body?.response;
    }
  }
  return null;
}

(async () => {
  let c = freshClient();
  const { token, sandboxUrl } = await setupSandbox(c);
  c.close();

  await new Promise(r => setTimeout(r, 2000));
  c = freshClient();

  const response = await chat(c, token, sandboxUrl, 'What is 2+2? Reply with just the number.');
  if (!response) {
    console.log('First attempt failed, trying again...');
    c.close();
    await new Promise(r => setTimeout(r, 3000));
    c = freshClient();
    await chat(c, token, sandboxUrl, 'What is 2+2? Reply with just the number.');
  }
  c.close();
})().catch(e => console.error(e.message || e));
