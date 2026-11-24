# gau fixture

`raw.txt` is real gau v2.2.4 output, captured on 2026-11-24 against an authorized bug-bounty target (a registrable
domain), inside the `redwhale-tools/urls` image as user 10001 with a read-only root filesystem, by
`run.py --target <domain> --target-type domain` (`REDWHALE_TOOL_TIMEOUT=870`, as the runner sets it for
`timeoutSec` 900). The script ran gau three times, one provider each, one after another (`build_command`):

```
/usr/local/bin/gau --providers <wayback|commoncrawl|otx> --threads 2 --blacklist png,jpg,jpeg,gif,svg,ico,webp,bmp,tif,tiff,avif,woff,woff2,ttf,otf,eot,mp3,mp4,m4a,m4v,avi,mov,mkv,webm,wav,ogg,flac --json --verbose --timeout 180 --retries 1 <domain>
```

The format is run.py's own (see its docstring): a `#provider <name> exit=<code>` line, gau's stdout unchanged,
`#stderr <name>`, gau's stderr unchanged. The capture was 29 lines; all are kept (well under the 200-URL limit for
this fixture, so nothing was trimmed).

What it shows, as captured:

- **wayback failed**, though gau exited 0: its only sign is the `level=warning … failed to fetch wayback results page
  0: timeout` line (the result is `partial`, naming wayback). It timed out the same way on every try that day.
- **commoncrawl**: 7 URLs on the target host.
- **otx**: 2 URLs, both on other hosts (`api.` and `www.` of the target), although gau ran without `--subs`: ignored.
- The `error reading config` warning (there is no config file: no API keys) is not a failure.

**Anonymized:** the target domain → `northwind.example`; its `rdap` host → `api`; the paths named the target's
customers' domains and a distinctive endpoint, so they were reworded with the same shape (`/domain/<name>.action`
→ `/product/<word>.action`, `/rdap/domain/<NAME>` → `/api/v1/item/<WORD>`, `bulk…Favorites…rpc` →
`bulkSetWatchlistShow.rpc`, `/store/sellers/` → `/store/vendors/`). Timestamps and everything else as captured.

**Edited lines** (otx's stdout, after its 2 real lines; the capture had none of these cases):

- `https://northwind.example/download.action`: also in commoncrawl's list, so `source` is `["commoncrawl", "otx"]`.
- `https://northwind.example/download.action#top`: a fragment; the same URL again.
- `http://northwind.example:80/`: a default port; reported as `http://northwind.example/`.
- `https://northwind.example:99999/`: an archived string that isn't a usable URL; ignored.

The 5,000-URL cap is tested on a synthetic file in `test_gau.py`, not here.

`expected.json` (with `"target_type": "domain"`, which `pnpm tools:check` passes as `--target-type`) is what
`run.py --target northwind.example --target-type domain --replay fixtures/raw.txt` must produce.
