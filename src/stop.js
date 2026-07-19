// Stops the running graf-memory daemon (if any).
const port = process.env.GRAF_MCP_PORT || 7688;
fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" })
  .then(() => console.log(`graf-memory daemon on port ${port} stopped`))
  .catch(() => console.log(`no graf-memory daemon running on port ${port}`));
