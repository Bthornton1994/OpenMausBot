# OMB Cloud Pro: the home machine

Cloud Pro gives one person an always-on OpenMausBot server of their own. Each
customer gets one Fly app with one `home` machine that is always on, a volume
at `/data`, and TLS at `https://<app>.fly.dev`. The desktop app, the phone and
the web are windows onto it. Local use of the app is unchanged and free.

This page is the OpenMausBot half of a contract with three parties:

- **the home machine**: this repository's `deploy/fly/` image;
- **the Admin** (openmaus-cloud, `docs/consumer-cloud.md` there): provisions
  the app, holds the machine's signing secret, runs the metered model gateway,
  and answers the desktop's Cloud session;
- **the desktop app**: signs in to Cloud, lists the machine under Servers,
  and offers **Connect to my Cloud**.

Contract version: `1` (`cloudContractVersion` on the wire).

## What the person sees

1. They subscribe on the Cloud site. The Admin creates the Fly app and machine.
2. They open the desktop app, go to **Settings → OMB Cloud** and sign in (the
   existing device sign-in). A **Your Cloud** card says **Setting up** until
   the machine is up.
3. When it is ready, the machine appears under **Servers** as **My Cloud**, and
   the card offers **Connect to my Cloud**. One click opens the machine in the
   app window, signed in. There is no second confirmation.
4. Their first bot runs immediately on the models **Included with Pro**. The
   model picker lists them as ready under the **OMB Cloud** engine, with no
   sign-in or setup.
5. They can still sign in to their own Claude Code (paste-code) or Codex
   (device code) under **Settings → Engines** on the Cloud. Those logins stay
   on the machine's volume, beside the included models.
6. When the month's included allowance is spent, the chat says **Included AI
   used up this month**, the picker marks the included engine, and the Cloud
   card says so too. Their own engines keep working.

The card shows one of: **Setting up**, **Ready**, **Stopped**, **Payment
problem**, **Could not be set up yet**, **Included AI used up**. Only Ready
and Included AI used up can be connected to. Signed out of Cloud, the app
makes no Cloud request and nothing on this page runs.

## The image

`deploy/fly/Dockerfile` builds on the published server image
(`ghcr.io/milind-soni/openmausbot`) and adds:

- the engine CLIs from `ENGINES` (default Claude Code and Codex; the base
  image already carries agent-browser and its Chrome);
- Caddy, as the only listener the network can reach (`0.0.0.0:8080`);
- `server/cloud-home-start.ts` (bundled to `dist-server/cloud-home-start.js`)
  as the entry point.

```sh
docker build -t openmausbot .
docker build -f deploy/fly/Dockerfile --build-arg BASE_IMAGE=openmausbot -t omb-cloud-home .
```

At boot the launcher, running as root only for this step, hands the volume's
mount point to the `maus` user, drops privileges for good, binds the volume to
this machine (`/data/.omb-cloud-home.json`; another machine's volume, or an
unmarked volume with data on it, is refused), and runs two children: the
server on `127.0.0.1:8799` (webhooks on `127.0.0.1:8800`) and Caddy on
`:8080`. If either exits, both stop and Fly restarts the machine.

`HOME=/data`, so `~/.claude`, `~/.codex` and OpenMausBot's own data
(`/data/.openmausbot`) persist on the volume.

### Why the server stays on loopback

`server/request-auth.ts` treats an unproxied loopback request as the
machine's owner. The server therefore never binds a public interface. Caddy
(`deploy/fly/Caddyfile`) forwards every request with `X-Forwarded-Proto:
https` and `X-Forwarded-For`, so the server sees each one as remote: it needs
a paired session, whatever `Host` it claims. Caddy trusts `Fly-Client-IP`
only from Fly's private ranges; that address feeds the pairing lockout, never
authorization. Apart from `/api/health`, Caddy answers only for the machine's
own name (`OMB_PUBLIC_URL`) and refuses any other `Host`.

### Fly

The Admin creates the machine through the Machines API; `deploy/fly/fly.toml`
is the same shape for a manual deploy: `internal_port = 8080`, `force_https`,
no auto-stop, one machine always running, a volume `omb_home` at `/data`,
restart policy `always`, and an HTTP check on `GET /api/health` (it answers
`{"app":"openmausbot"}` with no session). Each customer's app lives in its
own Fly private network, so no machine can reach another's over 6PN.

## Boot contract

Set by openmaus-cloud's provisioner (`server/cloud-machines.ts`). Any of the
first four switches the server into Cloud home mode; then all of them are
required and the whole contract is validated. A partial or invalid contract
stops the server before it serves, with a message that names the variable and
never echoes a secret.

| Variable | Fly | Value |
| --- | --- | --- |
| `OMB_CLOUD_ROLE` | env | `home`. (`desktop` belongs to the Cloud desktop image and is refused here.) |
| `OMB_CLOUD_MACHINE_ID` | env | The Admin's machine id (a UUID). Binds the volume. |
| `OMB_CLOUD_ADMIN_URL` | secret | The Cloud origin, exact `https://`, e.g. `https://cloud.openmausbot.com`. |
| `OMB_CLOUD_BOOTSTRAP_SECRET` | secret | 43 base64url characters (256 bits): the key the Admin signs pairing requests with. |
| `OMB_PUBLIC_URL` | env | The machine's exact `https://` origin, `https://<app>.fly.dev`. |
| `OMB_HOSTED_MODEL_URL` | env | The gateway base, `${OMB_CLOUD_ADMIN_URL}/api/cloud/gateway/<gatewayId>`. Must be on the Admin's origin. |
| `OMB_HOSTED_MODEL_TOKEN` | secret | This machine's gateway token, `omb_cloudai_` + 43 base64url characters. |
| `OMB_HOSTED_MODELS` | env | The included catalog, JSON: `{"anthropic":[…],"openai":[…],"openrouter":[…]}`. |

- The last three go together, or none of them (a machine without included models).
- The machine must not also carry `OMB_ADMIN_URL`, `OMB_ADMIN_WORKSPACE` or
  `OMB_ADMIN_MEMBERSHIP`: a Cloud home is a personal server with pairing codes
  on, not a hosted team workspace with portal membership.
- `HOME=/data` and `OMB_DATA_DIR=/data/.openmausbot` are set by the image.
- The server keeps the secret and the token in memory and removes them from
  its environment at startup; no engine or tool it starts ever inherits them.

### Which included models run, and where

| Catalog key | Runs as | Route |
| --- | --- | --- |
| `openrouter` | `included.agent` ("OMB Cloud"): OpenMausBot's own agent (`openai-compat`) | `${OMB_HOSTED_MODEL_URL}/openrouter/v1` |
| `openai` | `included.codex` ("OMB Cloud · Codex"): Codex, gateway as its custom provider | `${OMB_HOSTED_MODEL_URL}/openai/v1` |
| `anthropic` | **nothing**: ignored, with a startup warning | never `/anthropic` |

Claude Code never runs on included AI. Anthropic's Claude Code terms say a
platform may not pay for, resell or intermediate Claude usage on its users'
behalf; each person signs in with their own Anthropic account or key
(https://code.claude.com/docs/en/legal-and-compliance). A gateway token the
platform pays for is exactly that, whichever key sits behind the gateway. To
include Claude models, list them under `openrouter`
(e.g. `anthropic/claude-sonnet-5`); OpenMausBot's own agent runs them. A
catalog whose only entries are `anthropic` boots with no included models
rather than failing the machine.

Included instances sit beside the person's own engines, never in place of
them, and cannot be edited (`/api/instances/included.*` refuses changes).
Until the person saves another default, new bots (including the first one)
start on the included models, unless this month's allowance is used up.

**Allowance used up**: the gateway answers `402` in the provider's own error
shape (`budget_exceeded` for OpenAI, `{"error":{"code":402,…}}` for
OpenRouter). The machine turns that into "Included AI used up this month…" in
the chat, marks the engine in the picker, and clears the mark after the next
successful turn.

## Pairing: the Admin's signed request

`POST https://<app>.fly.dev/api/cloud/pairing`

```http
POST /api/cloud/pairing
Content-Type: application/json
x-omb-cloud-timestamp: 1790000000
x-omb-cloud-nonce: <base64url, 16–128 characters>
x-omb-cloud-signature: v1=<base64url HMAC-SHA256(OMB_CLOUD_BOOTSTRAP_SECRET, canonical)>

{"label":"OpenMausBot app (Cloud)","ttlSeconds":300}
```

where `canonical` is

```text
v1\n<timestamp>\n<nonce>\nPOST\n/api/cloud/pairing\n<base64url SHA-256 of the raw body>
```

`200`:

```json
{ "code": "ABCD-EFGH-JKLM", "credential": "omb_pair_…", "expiresAt": 1790000300000 }
```

`code` and `credential` are two encodings of **one ordinary pairing window**
(`server/sessions.ts`): single use, admin and client scopes, redeemed at the
machine's existing `POST /api/auth/pair`.

| Status | Body | Meaning |
| --- | --- | --- |
| `401` | `{"error":"invalid_signature"}` | Wrong key, tampered request, or malformed headers. Counts toward the per-source pairing lockout. |
| `401` | `{"error":"stale_request"}` | Timestamp more than 300 s from the machine's clock. |
| `401` | `{"error":"replayed_request"}` | Nonce already used in the last 10 minutes. |
| `429` | `{"error":"rate_limited","retryAfterSeconds":n}` | Too many bad signatures from this source. |
| `400` | `invalid_body`, `invalid_label`, `invalid_ttl` | Not a JSON object; label not plain text of 80 characters or fewer; TTL not a positive integer. |
| `405`, `415` | | Not a POST; not JSON. |

Rules the machine enforces: the signature is checked first, in constant time;
the timestamp within ±300 s; each nonce refused for 10 minutes; `ttlSeconds`
defaults to 300 and is capped at 600; nothing about the request (headers, body
or code) is logged. Nonces live in memory, so a restart forgets them; a
captured request is still bounded by its five-minute timestamp window and TLS.

## What the desktop reads from the Admin

The desktop polls `GET /api/cloud/desktop/session` with its personal device
token (`Authorization: Bearer omc_…`). Contract version 1 adds:

```json
"cloud": { "state": "ready", "origin": "https://omb-u-1a2b3c4d5e6f.fly.dev", "pairingAvailable": true }
```

- `null` or absent when the account has no machine; the app then shows nothing new.
- `state` is `setting_up`, `ready`, `stopped`, `payment_problem` or `failed`
  (the app also accepts `allowance_used`). `origin` is required for `ready`.
- Optional `allowance: {"includedUsd": 25, "usedUsd": 25.4, "resetsAt": <ms>}`
  (the Admin's `cloudAllowance` shape): a running machine whose allowance is
  spent shows **Included AI used up** with the reset date.

**Connect to my Cloud** first asks the machine whether this app is already
signed in there (`GET <origin>/api/auth/session` with its cookie). If not, it
calls `POST /api/cloud/desktop/pairing` (same device token) and expects
`{"cloudContractVersion":1,"origin":…,"code":…,"expiresAt":…}` for the same
origin, with `expiresAt` at most ten minutes away. It then adds or selects the
**My Cloud** server entry and opens `<origin>/pair#code=<code>`, the same
pairing-link flow as Connect to a server. The code stays in main-process
memory for that one navigation: never on disk, never in a renderer. A
malformed session summary or grant is treated as none.

## Security summary

- The server never listens on the network; only Caddy does, and nothing it
  forwards is the loopback owner.
- Pairing windows are opened only for a request signed with the machine's
  secret, fresh and never replayed; each window is single use and short lived.
- The signing secret and gateway token are removed from the server's
  environment at startup and are never passed to engines or to Caddy.
- Claude Code never receives included AI.
- A volume binds to one machine and is never adopted by another.
- Each customer's app lives in its own Fly private network.
