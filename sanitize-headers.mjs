export function sanitizeHeaders(req) {
  if (req.headers["user-agent"]?.startsWith("OpenAI/Python")) {
    req.headers["user-agent"] = "Hermes-Agent/0.20.1";
  }
}