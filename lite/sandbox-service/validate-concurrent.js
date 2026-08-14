// Operational validation driver (not a test file): spawns N sandboxes
// concurrently against a running sandbox-service, polls each to a terminal
// status, and reports whether each produced its own correct, uncontaminated
// output -- the live-execution witness for the 3-simultaneous-agent
// concurrency requirement.
'use strict';

const http = require('node:http');

const BASE = process.env.SANDBOX_SERVICE_URL || 'http://127.0.0.1:8787';
const N = Number(process.argv[2] || 3);

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${BASE}${urlPath}`,
      {
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* logs endpoint returns plain text */ }
          resolve({ statusCode: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function appFor(agentIndex) {
  return {
    entry: 'index.js',
    files: {
      'index.js': `
        console.log("agent ${agentIndex} says hello");
        console.log("marker:AGENT_${agentIndex}_UNIQUE_OUTPUT");
        console.log("pid namespace check, argv:", process.argv.slice(2));
      `,
    },
    timeoutMs: 120_000,
  };
}

async function pollUntilDone(id) {
  for (;;) {
    const { json } = await request('GET', `/sandboxes/${id}`);
    if (['completed', 'failed', 'timed_out', 'stopped'].includes(json.status)) return json;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  console.log(`spawning ${N} concurrent sandboxes against ${BASE}`);
  const spawned = await Promise.all(
    Array.from({ length: N }, (_, i) => request('POST', '/sandboxes', appFor(i))),
  );
  spawned.forEach((r, i) => {
    if (r.statusCode !== 202) throw new Error(`spawn ${i} failed: ${r.statusCode} ${JSON.stringify(r.json)}`);
  });
  const ids = spawned.map((r) => r.json.id);
  console.log('spawned ids:', ids);

  const finals = await Promise.all(ids.map(pollUntilDone));
  const logs = await Promise.all(ids.map((id) => request('GET', `/sandboxes/${id}/logs`)));

  let allOk = true;
  finals.forEach((f, i) => {
    const log = logs[i].text;
    const expectedMarker = `marker:AGENT_${i}_UNIQUE_OUTPUT`;
    const hasOwnMarker = log.includes(expectedMarker);
    const hasOtherMarkers = finals.some((_, j) => j !== i && log.includes(`marker:AGENT_${j}_UNIQUE_OUTPUT`));
    const ok = f.status === 'completed' && hasOwnMarker && !hasOtherMarkers;
    allOk = allOk && ok;
    console.log(`agent ${i} (${ids[i]}): status=${f.status} ownMarker=${hasOwnMarker} crossContaminated=${hasOtherMarkers} => ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) console.log(`  log:\n${log}`);
  });

  console.log(allOk ? '\nALL AGENTS PASSED, NO CROSS-CONTAMINATION' : '\nFAILURE DETECTED');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('validation driver error:', err);
  process.exit(1);
});
