---
name: qa-test
description: Smoke-test a CCWeb deployment after deploy or on demand
when_to_use: After deploying CCWeb, or when user asks to test/verify a server
argument-hint: host[:port]
---

# Q&A Smoke Test

Run smoke tests against a CCWeb deployment to verify everything works.

## Steps

### 1. Health Check
```bash
curl -sf http://HOST:PORT/api/health
```
Expected: `{"status":"ok","version":"..."}` — confirms server is running.

### 2. Sessions List
```bash
curl -sf http://HOST:PORT/api/sessions
```
Expected: JSON with `sessions` array and `activeId`. Confirms session manager works.

### 3. Skills Available
```bash
curl -sf http://HOST:PORT/api/skills
```
Expected: JSON array of skills. Verify deploy and qa-test skills are present.

### 4. MCP / Plugins Status
```bash
curl -sf http://HOST:PORT/api/mcp
```
Expected: JSON with `enabledPlugins` and `servers`. Check that expected plugins are enabled.

### 5. WebSocket Chat Test
Send a test message via WebSocket and verify Claude responds:
```bash
# Use websocat or node one-liner to:
# 1. Connect to ws://HOST:PORT/ws
# 2. Send: {"type":"send","text":"Say hello in exactly 3 words"}
# 3. Wait for response chunks (type: "chunk") and completion (type: "finished")
# 4. Verify response is non-empty

node -e "
const ws = require('ws');
const c = new ws('ws://HOST:PORT/ws');
let chunks = [];
c.on('open', () => {
  c.send(JSON.stringify({type:'send',text:'Say hello in exactly 3 words'}));
  setTimeout(() => {
    console.log('Chunks received:', chunks.length);
    console.log('Content:', chunks.join(''));
    c.close();
    process.exit(chunks.length > 0 ? 0 : 1);
  }, 30000);
});
c.on('message', d => {
  const m = JSON.parse(d);
  if (m.type === 'chunk') chunks.push(m.text);
  if (m.type === 'finished') {
    console.log('PASS: Got response with', chunks.length, 'chunks');
    console.log('Content:', chunks.join(''));
    c.close();
    process.exit(0);
  }
});
c.on('error', e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

### 6. Memory API
```bash
curl -sf http://HOST:PORT/api/memory
```
Expected: JSON with memory content (may be empty on fresh server, that's OK).

### 7. Report
Summarize results:
- Health: OK/FAIL
- Sessions: OK/FAIL
- Skills: OK/FAIL (list names)
- Plugins: OK/FAIL (list enabled)
- Chat: OK/FAIL (response received/empty)
- Memory: OK/FAIL

If any test fails, suggest fixes.
