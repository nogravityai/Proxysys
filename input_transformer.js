function mcp_to_prism_input(params, method) {
  if (!params || typeof params !== "object") {
    return [{ type: "input_text", text: "" }];
  }

  if (Array.isArray(params)) {
    return params;
  }

  const text = params.message
    || params.prompt
    || params.text
    || params.input
    || params.query
    || (typeof params === "string" ? params : JSON.stringify(params));

  return [{ type: "input_text", text: String(text) }];
}

function clean_payload(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(clean_payload).filter((v) => v !== undefined);
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    result[key] = clean_payload(value);
  }
  return result;
}

function build_llm_request(params, conversation_id) {
  const input = mcp_to_prism_input(params);
  const sandbox_url = params.sandbox_url || params.metadata?.sandbox_url || null;
  const sandbox_token = params.sandbox_token || params.metadata?.sandbox_token || null;
  const project_id = params.project_id || params.metadata?.projectId || "6b12b4c3-90c6-4eb2-8b35-e5a7f6a25c49";
  const user_id = params.user_id || params.metadata?.userId || "user-50eExBVyN8G7EdyjTcxSfOH2";

  const metadata = {
    projectId: project_id,
    userId: user_id,
    model: params.model || "gpt-5.6-sol",
    reasoning_effort: params.reasoning_effort || "low",
    frontend_origin: "https://prism.openai.com",
  };
  if (sandbox_url) metadata.sandbox_url = sandbox_url;
  if (sandbox_token) metadata.sandbox_token = sandbox_token;

  const req = {
    input,
    previousResponseId: params.previousResponseId || params.previous_response_id || null,
    metadata,
    conversationId: conversation_id || params.conversationId || params.conversation_id || null,
  };
  return clean_payload(req);
}

function parse_prism_response(response_data) {
  if (!response_data || typeof response_data !== "object") {
    return { status: "unknown", data: response_data };
  }

  if (response_data.status === "started" && response_data.request_id) {
    return {
      status: "started",
      request_id: response_data.request_id,
      turn_state: response_data.turn_state,
    };
  }

  if (response_data.status === "completed" && response_data.response) {
    const resp = response_data.response;
    let text = "";
    if (resp.output && Array.isArray(resp.output)) {
      for (const item of resp.output) {
        if (item.type === "message" && item.content && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === "output_text" && c.text) {
              text += c.text;
            }
          }
        }
      }
    }
    return {
      status: "completed",
      text,
      raw: response_data,
    };
  }

  if (response_data.status === "pending") {
    return {
      status: "pending",
      turn_state: response_data.turn_state,
    };
  }

  return { status: "raw", data: response_data };
}

module.exports = { mcp_to_prism_input, build_llm_request, parse_prism_response, clean_payload };
