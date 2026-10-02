// Errors the agent is meant to read. `code` is stable for the bridge to branch
// on; `message` tells the model what to do next.

export class AgentError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.data = data;
  }
}

export function badRequest(message) {
  return new AgentError('bad_request', message);
}

export function toErrorPayload(err) {
  if (err instanceof AgentError) {
    const payload = { code: err.code, message: err.message };
    if (err.data !== undefined) payload.data = err.data;
    return payload;
  }
  return { code: 'internal_error', message: errorText(err) };
}

// chrome.debugger rejects with the CDP error serialized as JSON in `message`.
export function errorText(err) {
  const raw = String(err?.message ?? err ?? 'unknown error');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON: use as is.
  }
  return raw;
}
