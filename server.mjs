import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = 8080; // MicroVM traffic + hooks default to port 8080.
const HOOK = "/aws/lambda-microvms/runtime/v1"; // fixed prefix for every hook path

// ============================================================================
// 1. THE STATE  — the whole demo exists to prove THIS survives a freeze.
// ============================================================================
const session = {
  id: null, // set per-VM in the /run hook, NOT here (else it bakes into the snapshot)
  total: 0, // running total, changed by /exec
  steps: 0, // how many /exec calls happened
  startedAt: null, // stamped by /run
  resumedAt: null, // stamped by /resume — proves the resume hook fired
};

function runStep(op, value) {
  switch (op) {
    case "add":
      session.total += Number(value);
      break;
    case "mul":
      session.total *= Number(value);
      break;
    case "reset":
      session.total = 0;
      break;
    default:
      throw new Error(`unknown op: ${op}`);
  }
  session.steps += 1;
  return session.total;
}

// ============================================================================
// 2. HELPERS
// ============================================================================

// Write a JSON response with a status code.
function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Read the request body and JSON-parse it.
//
// Node delivers an HTTP body as a STREAM, not a ready-made string: the bytes
// arrive in one or more chunks. So we:
//   1. collect every chunk with `for await` (async iteration over the stream),
//   2. concatenate them into a single Buffer,
//   3. decode that Buffer as UTF-8 text, and
//   4. JSON.parse it into an object.
// If the request had no body (e.g. a GET, or an empty POST), we return {} so
// callers can safely destructure (const { op } = ...) without a null check.
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ============================================================================
// 3. LAMBDA LIFECYCLE HOOKS  — Lambda calls these; every one is a POST to
//    `${HOOK}/<name>`. Returning 200 lets that lifecycle step proceed. Each
//    handler receives the parsed request body and returns the response body.
// ============================================================================
const hooks = {
  // Build time: return 200 once the app is initialized and ready to snapshot.
  ready: () => ({ status: "ready" }),
  // Build time: return 200 to confirm a VM from the new image works.
  validate: () => ({ status: "ok" }),

  // Runtime: fires once, AFTER this VM starts from the snapshot and BEFORE any
  // external traffic. Set anything that must be UNIQUE per MicroVM here, so it
  // is not baked into the shared snapshot. Lambda sends { microvmId,
  // runHookPayload } — runHookPayload is the (max 16 KB) STRING from run-microvm.
  run: (body) => {
    session.id = body.runHookPayload?.trim() || body.microvmId || randomUUID();
    session.startedAt = Date.now();
    session.total = 0;
    session.steps = 0;
    return { ok: true, sessionId: session.id };
  },

  // Runtime: flush pending writes / close connections before the freeze. No-op here.
  suspend: () => ({ ok: true }),

  // Runtime: refresh anything that went stale while frozen (creds, DB conns).
  // Here we just stamp the time, which proves on /state that this hook ran.
  resume: () => {
    session.resumedAt = Date.now();
    return { ok: true };
  },

  // Runtime: last chance to flush data / notify external systems. No-op here.
  terminate: () => ({ ok: true }),
};

// ============================================================================
// 4. YOUR APP ROUTES  — you call these over HTTPS with an auth token. Keyed by
//    "METHOD path"; each handler receives the parsed body and returns the response.
// ============================================================================
const app = {
  // Run one step in this session's sandbox and report the new total.
  "POST /exec": (body) => {
    const total = runStep(body.op, body.value);
    return {
      sessionId: session.id,
      op: body.op,
      value: body.value,
      total,
      steps: session.steps,
    };
  },

  // Read the current state. Used after resume to prove the state survived.
  "GET /state": () => ({ ...session }),
};

// ============================================================================
// 5. THE SERVER  — route each request to a hook or an app handler.
// ============================================================================
const server = http.createServer(async (req, res) => {
  try {
    const { method, url } = req;

    // (a) Lifecycle hooks: any POST under the fixed hook prefix.
    if (method === "POST" && url.startsWith(`${HOOK}/`)) {
      const name = url.slice(HOOK.length + 1); // e.g. "run", "resume"
      const handler = hooks[name];
      if (!handler) return send(res, 404, { error: `unknown hook: ${name}` });
      return send(res, 200, handler(await readJson(req)));
    }

    // (b) App routes: look up "METHOD path" in the app map.
    const handler = app[`${method} ${url}`];
    if (handler) {
      const body = method === "POST" ? await readJson(req) : {};
      return send(res, 200, handler(body));
    }

    // (c) Anything else.
    return send(res, 404, { error: "not found", method, url });
  } catch (err) {
    return send(res, 400, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`sandbox listening on :${PORT}`);
});
