// Probe the four service ports and report health.
const targets = [
  { name: "node-api", port: 8787, path: "/api/health" },
  { name: "sidecar-akshare", port: 8788, path: "/health" },
  { name: "tdx", port: 8789, path: "/health" },
  { name: "vite", port: 5173, path: "/" },
];

async function probe(t) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(`http://127.0.0.1:${t.port}${t.path}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const txt = await r.text();
    return { ...t, ok: r.ok, status: r.status, len: txt.length };
  } catch (e) {
    clearTimeout(timer);
    return { ...t, ok: false, status: 0, error: String(e && e.message || e) };
  }
}

const results = [];
for (const t of targets) results.push(await probe(t));
console.log(JSON.stringify(results, null, 2));
