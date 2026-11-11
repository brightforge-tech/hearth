// tests/helpers/resend-stub.mjs — a local stand-in for the Resend API
// (task t11).
//
// The e-mail endpoints build their provider URL from RESEND_API_BASE, so a
// suite that owns its server's environment can point them here and capture
// every byte the endpoint would have sent: method, path, Authorization
// header, and the parsed JSON body ({from,to,subject,html}). The stub always
// answers JSON; tests set a responder to make it fail on purpose.
//
// Nothing in the API knows about this file — the milestones'
// "sends exactly one POST to $RESEND_API_BASE/emails" and "performs no
// request" are checked against `requests.length`.

import http from 'node:http';

// startResendStub({id, respond}) -> { port, baseUrl, requests, setResponder,
// close }. `requests` collects, in arrival order, {method, url, headers,
// body (raw text), json (parsed or null)}.
export async function startResendStub({ id = 're_stub_test_id', respond } = {}) {
  const requests = [];
  let responder =
    respond ??
    ((req) => ({ status: 200, body: { id: `${id}_${requests.length}` } }));

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        /* the caller sent non-JSON — still recorded */
      }
      const record = { method: req.method, url: req.url, headers: req.headers, body, json };
      requests.push(record);

      const out = responder(record) ?? {};
      res.statusCode = out.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.body ?? { id: `re_stub_${requests.length}` }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    setResponder(fn) {
      responder = fn;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
