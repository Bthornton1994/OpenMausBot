# Windows setup: local factory bridge sidecar

The factory bridge (`scripts/factory-bridge.ts`) is a **loopback-only** HTTP
sidecar on `127.0.0.1:8798`. It is meant for local tools such as Grok Shell on
the same machine.

> **Security**
> - Loopback only. Never bind it to `0.0.0.0`, port-forward it, or put it
>   behind a tunnel (ngrok, Cloudflare Tunnel, Tailscale Funnel, etc.).
> - Never paste the bridge token into chat, prompts, commits, issues, or logs.
>   Refer to it only by its env var name.

## Ports

| Service | Address |
| --- | --- |
| OpenMausBot bots / server | `127.0.0.1:8799` (unchanged) |
| Factory bridge sidecar | `127.0.0.1:8798` |

Neither port should be exposed or tunneled.

## Environment variables

Names only. Secret values never belong in this file.

| Name | Purpose |
| --- | --- |
| `FACTORY_BRIDGE_TOKEN` | Bearer secret. Without it, every route except `/health` returns 401. |
| `COS_FACTORY_PROTECT_DIR` | Protect-gate directory, e.g. `C:\Users\Bthor\src\omb-factory-pilot\_cos\protect`. If it is unset, mutating operations fail closed. |
| `OMB_DATA_DIR` | Data store. Defaults to `~/.openmausbot`; use an isolated directory for testing. |
| `FACTORY_BRIDGE_PORT` | `8798` |
| `FACTORY_BRIDGE_LOG` | Path to the access log file. |

## Set User-scoped env vars

The token is set from a hidden prompt, so it never appears on screen or in
shell history. Run this in **PowerShell**:

```powershell
# Token: typed into a hidden prompt, not echoed and not saved to history
$s = Read-Host -AsSecureString "FACTORY_BRIDGE_TOKEN"
$t = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
       [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
[Environment]::SetEnvironmentVariable('FACTORY_BRIDGE_TOKEN', $t, 'User')
Remove-Variable s, t

# Non-secret values
[Environment]::SetEnvironmentVariable('COS_FACTORY_PROTECT_DIR', 'C:\Users\Bthor\src\omb-factory-pilot\_cos\protect', 'User')
[Environment]::SetEnvironmentVariable('OMB_DATA_DIR', 'C:\path\to\omb-data', 'User')
[Environment]::SetEnvironmentVariable('FACTORY_BRIDGE_PORT', '8798', 'User')
[Environment]::SetEnvironmentVariable('FACTORY_BRIDGE_LOG', 'C:\path\to\bridge-access.log', 'User')
```

In **cmd**, `setx` works for the non-secret values:

```bat
setx COS_FACTORY_PROTECT_DIR "C:\Users\Bthor\src\omb-factory-pilot\_cos\protect"
setx OMB_DATA_DIR "C:\path\to\omb-data"
setx FACTORY_BRIDGE_PORT 8798
setx FACTORY_BRIDGE_LOG "C:\path\to\bridge-access.log"
```

Don't use `setx FACTORY_BRIDGE_TOKEN <value>`, because the value stays in
command history and process listings. Use the PowerShell prompt above instead.

User-scoped variables only reach **new** terminals, so open a new one after
setting them. To check that the token is set without printing it:

```powershell
[bool][Environment]::GetEnvironmentVariable('FACTORY_BRIDGE_TOKEN', 'User')
```

## Start the bridge

Run this from the worktree root:

```bat
node --experimental-strip-types scripts\factory-bridge.ts
```

At startup the bridge prints `protectDir`, `dataDir`, and
`auth=configured|MISSING`. It never prints the token.

## Grok Shell / curl examples

The token always comes from the env var. Never type it literally.

cmd:

```bat
curl http://127.0.0.1:8798/health
curl -H "Authorization: Bearer %FACTORY_BRIDGE_TOKEN%" http://127.0.0.1:8798/factory/lanes
```

PowerShell (use `curl.exe`, not the `curl` alias):

```powershell
curl.exe -H "Authorization: Bearer $env:FACTORY_BRIDGE_TOKEN" http://127.0.0.1:8798/factory/lanes
```

Don't run curl with `-v` or `--trace`, and don't save its output anywhere that
shows request headers, because the Authorization header would be printed.
