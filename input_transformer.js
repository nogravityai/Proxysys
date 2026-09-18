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
  const req = {
    input,
    model: params.model || "o3",
    tools: params.tools || [
      {
        type: "function",
        function: {
          name: "code_execution",
          description: "Execute code in a sandbox environment",
          parameters: {
            type: "object",
            properties: {
              code: { type: "string", description: "Code to execute" },
              language: { type: "string", description: "Programming language" },
            },
          },
        },
      },
    ],
    previousResponseId: params.previousResponseId || params.previous_response_id || null,
    metadata: {
      conversationMode: params.conversationMode || params.conversation_mode || "main",
    },
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
