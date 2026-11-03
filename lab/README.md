# RED WHALE local lab

A tiny web server you may point **active** tools at, so you can test them without touching anyone else's machine.
It runs in Docker on the tools network (`redwhale-tools`), next to the job containers, and is reachable **only from
them**: it publishes no ports on your machine, so you can't open it in your browser.

| Name (from a job container) | What it answers |
|---|---|
| `http://lab.redwhale.test/` | `301` to `https://elsewhere.redwhale.test/` (another host: a tool must **not** follow it) |
| `https://lab.redwhale.test/` | `200`, page title `Northwind Lab`, self-signed certificate |
| both | `Server: nginx/1.30.6` and `X-Powered-By: PHP/8.3.12` (something for tech detection to find) |

The lab's address is fixed: `172.29.250.10` (host `.10` of the tools subnet, `172.29.250.0/24` by default). Job
containers get addresses from the upper half of the subnet only, so they never take it. `elsewhere.redwhale.test`
is the same container under a second name: if a tool followed the redirect, the lab's log would show it.

## Use it (PowerShell)

Docker Desktop must be running. From the repo root:

```powershell
pnpm lab:up
```

The first run builds the image (it downloads the pinned nginx image). `lab:up` is safe to run again: an up-to-date
lab is left alone, an old one is replaced.

`lab:up` **never changes your scope**. It prints the two rules to add; add them in the Scope panel (or with the API):

```text
include  domain  lab.redwhale.test
include  ip      172.29.250.10
```

Active tools also need **passive-only turned off** (Scope panel). Then, in the graph, add the node yourself (canvas
right-click ▸ Add node ▸ subdomain `lab.redwhale.test`), right-click it ▸ Run tool ▸ httpx, read the confirmation and
click **Run active scan**.

Check it, or stop it:

```powershell
pnpm lab:status
pnpm lab:down
```

`lab:down` removes the container. The image and the `redwhale-tools` network stay (job containers use the network).
Your scope rules stay too: remove them in the Scope panel if you like.

See what the lab received (one line per request, with the `Host` asked for):

```powershell
docker logs redwhale-lab
```

## If the subnet clashes

If another Docker network or a VPN already uses `172.29.250.0/24`, `lab:up` (and every tool run) says so. Pick a
free range, set it for the server and the lab commands, and restart the server:

```powershell
$env:REDWHALE_NET_SUBNET = "172.30.250.0/24"
docker network rm redwhale-tools
pnpm lab:up
```

The lab is then at `172.30.250.10`; `lab:up` prints the scope rules for the new address. Set the same variable in the
terminal where you run `pnpm dev`.

## Files

- `Dockerfile`: nginx alpine pinned by digest; the certificate is generated at build time (no key in the repo).
- `nginx.conf`: the two servers above, logging `host=<Host>` for every request.
- `index.html`: the page.

The image is tagged `redwhale-lab:<hash of these three files>`, so editing one makes `lab:up` rebuild it. The
container is labelled `redwhale.lab`, runs as nginx's own user with a read-only filesystem and no capabilities, and
is created by `server/src/runner/lab.ts` (through the same Docker client as the tool runner).
