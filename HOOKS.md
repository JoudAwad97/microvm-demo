# Lambda MicroVMs — Lifecycle Hooks

Hooks are HTTP **POST** endpoints your app exposes, all under the fixed prefix
`/aws/lambda-microvms/runtime/v1/<hook>` on the port you declare in the image's
hook config. They're optional — enable only the ones you implement. They fall
into two groups: **build-time** (run while the _image_ is created) and
**runtime** (run per _MicroVM instance_).

## The six hooks at a glance

| Hook         | Group   | When it fires                                                     | How often                                                  | Return                                           | On failure                                      |
| ------------ | ------- | ----------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| `/ready`     | build   | during image build, after your app starts                         | **polled** until 200 or timeout — a gate for **one build** | `503` = not yet (retry), `200` = snapshot me now | build fails                                     |
| `/validate`  | build   | after build, on a throwaway VM launched from the new image        | **polled** until 200 or timeout — once per build           | `503` = need more time, `200` = passed           | build fails                                     |
| `/run`       | runtime | once the VM starts from the snapshot, **before any traffic**      | **exactly once** per MicroVM                               | `200` to open the endpoint                       | VM goes straight to `TERMINATING`, never serves |
| `/suspend`   | runtime | right before the VM freezes                                       | **once per suspend** → 0…N times over its life             | `200`                                            | suspend proceeds anyway (best-effort)           |
| `/resume`    | runtime | on wake, while still `SUSPENDED`; VM → `RUNNING` after it returns | **once per resume** → 0…N times                            | `200` to go live                                 | caller gets `502`                               |
| `/terminate` | runtime | right before the VM is destroyed                                  | **once** per MicroVM (best-effort)                         | `200`                                            | teardown proceeds anyway                        |

Key: **build hooks run 0 times at runtime** (they only shape the image), and
`/run` + `/terminate` bookend each VM's life, while `/suspend` + `/resume` repeat
as many times as the VM sleeps and wakes (capped by the 8-hour total lifespan).

## What each should do

**`/ready`** — Do all your **expensive one-time initialization here** and only
return `200` when the app is fully warmed: load models, warm caches/JIT, run
migrations, open the connections you _want_ frozen into the snapshot. Everything
done before `200` is captured once and reused by every launched VM — that's the
whole point. Return `503` (immediately, don't hold the request) while you're
still initializing.

**`/validate`** — Exercise your real code paths with a mock request to (a)
**confirm the image actually works** before it's marked usable, and (b) let
Lambda **sample which snapshot regions those paths touch and prefetch them**, so
future launches are faster. Return `200` when satisfied.

**`/run`** — Per-VM / per-tenant setup, on the critical path before traffic.
**Regenerate anything that must be unique** (session ids, nonces, keys) so it
isn't shared from the snapshot, and **apply the per-VM payload** (tenant id,
secret path, session token) Lambda hands you in `{ microvmId, runHookPayload }`.
Open per-tenant connections. You _must_ return `200` or the VM never serves.

**`/suspend`** — **Make the VM safe to freeze:** flush pending writes to durable
storage, gracefully close sockets/file handles/DB connections that would be dead
or stale when thawed, checkpoint external state. Keep it fast — it's on the
suspend path.

**`/resume`** — **Repair what a freeze breaks:** refresh short-lived credentials
that may have expired while frozen, reopen the connections you closed in
`/suspend`, re-sync anything time-sensitive (leases, tokens, clocks). Return
`200` to transition back to `RUNNING`. This adds latency to the first request
after a wake, so keep it tight.

**`/terminate`** — **Graceful teardown:** flush/persist final results, deregister
from service discovery or routing, release external locks/leases, notify
downstream systems. It's best-effort (and also fires when max duration is hit),
so don't rely on it as your only durability guarantee.

### Contract rules worth internalizing

- All hooks are **POST**; return `200` to let the lifecycle proceed.
- Build hooks (`/ready`, `/validate`) are **polled** — return `503` _immediately_
  when not ready (never hold the request open, or the timeout kills the build).
- Make handlers **fast and idempotent** — polled hooks and `/resume` can be
  called more than once.
- `/run` is a **hard gate**: no `200`, no traffic.

## 4 things hooks are actually for

1. **Per-tenant identity & secrets — use `/run`.**
   Each sandbox needs its own session id and its tenant's API key. Generate the
   id and fetch the secret (from the run payload / Secrets Manager) in `/run`, so
   no two VMs share credentials baked into the common snapshot.

2. **Pay expensive startup once — use `/ready`.**
   Loading a 2 GB ML model or warming a language runtime takes seconds. Do it
   before `/ready` returns `200`; Lambda snapshots the warmed process, and every
   future VM starts already-warm instead of repeating that cost.

3. **Survive freeze/thaw cleanly — use `/suspend` + `/resume`.**
   Long-lived DB/Redis/WebSocket connections die or go stale across a freeze.
   Close them in `/suspend`; reopen them and refresh any expired token in
   `/resume` — so a thawed VM never tries to use a dead socket or an expired
   credential.

4. **Graceful shutdown & result persistence — use `/terminate`.**
   When a session ends, flush the user's work to S3/DynamoDB, remove the VM from
   your routing table / service registry, and release any locks it held — before
   the machine disappears.
