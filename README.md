# microvm-demo

A minimal Node.js app that demonstrates **AWS Lambda MicroVMs** lifecycle hooks:
per-session state that survives a freeze/thaw cycle.

Lambda MicroVMs let a container-based Lambda function keep a live VM around
between invocations instead of tearing it down — the VM can be **frozen**
(suspended) when idle and **thawed** (resumed) later with its in-memory state
intact. This repo is a tiny "sandbox" service that proves that out: it keeps a
running total in memory, lets you mutate it over HTTP, and exposes enough
lifecycle hooks to show the state survives a suspend/resume.

## How it works

[server.mjs](server.mjs) is a single-file HTTP server (no dependencies) with
two kinds of routes:

1. **Lifecycle hooks** — `POST /aws/lambda-microvms/runtime/v1/<hook>`, called
   by Lambda itself at fixed points in a MicroVM's life:

   | Hook | Fires | Purpose in this demo |
   | --- | --- | --- |
   | `/ready` | once, at image build time | reports the app is initialized |
   | `/validate` | once, on a throwaway VM after build | reports the image works |
   | `/run` | once, before the VM takes traffic | stamps a per-VM session id and resets state |
   | `/suspend` | before the VM freezes | no-op (nothing to flush here) |
   | `/resume` | on wake, before the VM goes live again | stamps `resumedAt`, proving the hook fired |
   | `/terminate` | before the VM is destroyed | no-op |

   See [HOOKS.md](HOOKS.md) for the full contract (timing, retry behavior,
   failure modes) behind each hook.

2. **App routes** — the actual sandbox API, called over HTTPS with an auth
   token once the VM is serving traffic:

   | Route | Effect |
   | --- | --- |
   | `POST /exec` | runs one op (`add`, `mul`, or `reset`) against the running total |
   | `GET /state` | returns the current session state |

The point of the demo: call `/exec` a few times, force the VM to suspend and
resume, then call `/state` again — the total, step count, and session id are
all unchanged, while `resumedAt` proves the `/resume` hook actually ran.

## Running it

Built as a container image for Lambda MicroVMs — see [Dockerfile](Dockerfile).
Locally, it's a plain Node server:

```bash
node server.mjs
# sandbox listening on :8080
```

## Trying the API

Once deployed behind a Lambda Function URL (or similar), see
[commands.md](commands.md) for ready-to-run `curl` commands against `/state`
and `/exec`.
