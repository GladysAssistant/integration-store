# Gladys Assistant Integration Store

Automated indexer of the **decentralized Gladys Assistant integration store**.

Publishing an integration does not require anyone's permission: the source of truth is distributed on GitHub, and this repository only hosts the robot that rebuilds a public, static index from it. The maintainer approves nothing and is never a bottleneck — the validation code is public, the admission rules are verifiable by everyone, and anyone can regenerate the index by forking this repository.

## How it works

```
GitHub topic `gladys-assistant-integration`      (source of truth, distributed)
        │
        ▼  hourly GitHub Action (+ manual trigger)
┌─────────────────────────────────────────────────────────────┐
│ 1. search public repositories tagged with the topic          │
│ 2. fetch gladys-assistant-integration.json from each repo    │
│ 3. validate mechanically (JSON Schema + code rules)          │
│ 4. check the mandatory user docs (docs/en.md + docs/fr.md)   │
│ 5. check the Docker image exists on its registry             │
│ 6. download, validate and re-host each cover image           │
│ 7. build index.json + rejected.json (deterministic)          │
└─────────────────────────────────────────────────────────────┘
        │
        ▼  upload to a Cloudflare R2 bucket (S3-compatible, CDN-fronted)
index.json · rejected.json · manifest.schema.json · covers/ · docs/
        │
        ▼
every Gladys instance downloads and caches the index
(catalog, one-click install, update detection)
```

## Publish your integration

No account to create, no PR to get approved:

1. Create a **public** GitHub repository for your integration (start from the [`integration-template-js`](https://github.com/GladysAssistant/integration-template-js) template).
2. Put a valid **`gladys-assistant-integration.json`** manifest at the root of the default branch.
3. Write the **mandatory user documentation**: `docs/en.md` **and** `docs/fr.md` (the two languages of the project; at least 300 characters each), following the template sections (Overview / Prerequisites / Configuration / Troubleshooting). Both files are re-hosted by the indexer and shown in the Gladys install and configuration screens.
4. Add the **`gladys-assistant-integration`** topic to the repository.
5. Wait for the next hourly indexing: your integration appears in the catalog of every Gladys instance.
6. Publish a new version = bump `version` and `docker_image` in the manifest and push. That's it.

If your integration does not show up, check the public `rejected.json` (at `<STORE_BASE_URL>/rejected.json`): every rejected manifest is listed with the reason, so you can diagnose it yourself.

## Test your integration locally

No need to wait for the hourly indexing to discover a rejection: run the exact same admission checks locally, from the root of your integration repository:

```bash
npx github:GladysAssistant/integration-store
```

(or point it at a directory: `npx github:GladysAssistant/integration-store path/to/my-integration`)

It replays the validation of the indexer against your local `gladys-assistant-integration.json`:

- JSON Schema + code rules (same `validateManifest` code as the robot);
- the mandatory user documentation (`docs/en.md` and `docs/fr.md` next to the manifest, at least 300 characters each);
- the Docker images (main and sub-containers) exist on their registry and are anonymously pullable;
- the cover contract (JPEG or PNG, exactly 800x534, ≤ 150 KB).

The exit code is `0` when the integration would be indexed and `1` when it would be rejected; warnings are the non-blocking degradations also published in `rejected.json` (e.g. placeholder cover). Unlike the hourly robot, the local run reports **all** problems at once, so everything can be fixed in a single pass.

What a local run cannot verify: that the repository is public, tagged with the `gladys-assistant-integration` topic, and that the manifest is pushed at the root of the default branch.

## The manifest

The canonical JSON Schema lives in [`schemas/manifest.schema.json`](schemas/manifest.schema.json) and is published next to the index at `<STORE_BASE_URL>/manifest.schema.json`. Full example:

```json
{
  "manifest_version": 1,
  "type": "device",
  "name": "Open-Meteo Demo",
  "description": {
    "en": "Weather sensor and virtual switch demo integration.",
    "fr": "Intégration démo : capteur météo et interrupteur virtuel."
  },
  "version": "1.2.0",
  "docker_image": "ghcr.io/john/gladys-open-meteo-demo:1.2.0",
  "gladys_version": ">=4.62.0",
  "cover_image": "https://raw.githubusercontent.com/john/gladys-open-meteo-demo/main/cover.jpg",
  "config_schema": [
    {
      "key": "intro",
      "type": "section",
      "label": { "en": "Getting started", "fr": "Pour commencer" },
      "description": { "en": "Create a developer account to get your API key." },
      "links": [{ "url": "https://open-meteo.com/en/docs", "label": { "en": "Open-Meteo docs" } }]
    },
    {
      "key": "latitude",
      "type": "number",
      "label": { "en": "Latitude", "fr": "Latitude" },
      "placeholder": { "en": "48.85", "fr": "48,85" },
      "required": true,
      "default": 48.85,
      "min": -90,
      "max": 90
    }
  ],
  "transports": ["local", "cloud"],
  "containers": [
    {
      "name": "mqtt",
      "docker_image": "eclipse-mosquitto:2.0.18",
      "start": "manual",
      "volumes": ["/mosquitto/config"],
      "ports": [{ "container_port": 1883, "label": { "en": "MQTT broker" } }]
    }
  ],
  "network_discovery": [{ "type": "mdns", "service": "_hue._tcp" }],
  "webhooks": [
    { "key": "events", "label": { "en": "Weather events" }, "mode": "fire_and_forget" },
    { "key": "callback", "label": { "en": "Subscription callback" }, "mode": "sync" }
  ],
  "actions": [
    {
      "key": "test_connection",
      "label": { "en": "Test connection" },
      "timeout_seconds": 30,
      "fields": [{ "key": "device", "type": "select", "source": "devices", "label": { "en": "Device" } }]
    }
  ]
}
```

### Validation rules

| Field               | Required  | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest_version`  | yes       | `1`; a manifest with a higher version is rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `type`              | yes       | `"device"` (publishes discovered devices) or `"communication"` (messaging channel, Configuration screen only; its family is declared by the mandatory `messaging` field)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `name`              | yes       | 3–30 characters (title of the catalog card)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `description`       | yes       | object `{lang: text}`, `en` key mandatory, each value 10–100 characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `version`           | yes       | strict semver; bump it to trigger "update available" in Gladys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docker_image`      | yes       | well-formed image reference on any public registry, with an **explicit tag or digest**; the image must **actually exist** on its registry and be anonymously pullable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `gladys_version`    | yes       | semver range (npm syntax), used for the compatibility filter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cover_image`       | no        | `https` URL of a **JPEG or PNG**, **exactly 800×534 px**, **≤ 150 KB**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `config_schema`     | no        | flat list of fields: `key` (`[a-z0-9_]`, unique), `type` (`string` \| `number` \| `boolean` \| `select` \| `multi_select` \| `secret` \| `oauth2` \| `section`), `label` (multi-language, `en` mandatory), `description`, `placeholder` (multi-language, `string`/`number`/`secret` only), `required`, `default` (matches the field type, forbidden on `secret`/`oauth2` and dynamic-`source` selects), `min`/`max` (number only), `options` **or** `source` (`"devices"`: options provided by the Gladys core, mutually exclusive with `options`; select/multi_select only), `display` (`dropdown` \| `radio`, select only). `section` fields are purely presentational intro blocks: no stored value (`required`/`default`/`placeholder` forbidden), plain-text `description` (≤ 1000 characters per language) and up to 5 `links` (`https` only, multi-language `label`) |
| `transports`        | no        | non-empty unique subset of `local`/`cloud`; declaring both renders the standard "Prefer local (LAN) connection" toggle in Gladys (reserved `GLADYS_PREFER_LOCAL` config key)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `containers`        | no        | up to 5 sub-container declarations (multi-container integrations, e.g. Frigate + Mosquitto): `name` (`[a-z0-9-]{2,20}`, unique), `docker_image` (same rules as the main image, existence verified too), `start` (`auto` \| `manual`), `env` (strings, `GLADYS_*` reserved), `volumes` (≤ 5 absolute paths, no `..`), `ports` (≤ 3, labelled), `devices` (`coral-usb` \| `coral-pcie` \| `gpu` \| `video`, unique), `read_only`, `memory_mb` (32–4096), `cpu` (0.1–2), `shm_mb` (64–512), `command`                                                                                                                                                                                                                                                                                                                                                                          |
| `network_discovery` | no        | 1–5 mediated capture requests: `udp-broadcast` (passive listen, 1–5 unique `ports`), `udp-active-broadcast` (active query/response: the core broadcasts an integration-forged payload on one of the 1–5 declared `ports` and relays the unicast replies), `mdns` (DNS-SD `service`, e.g. `_hue._tcp`) or `ssdp` (`st`, ≤ 200 characters) — each type only carries its own field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `actions`           | no        | 1–10 on-demand operations rendered as buttons: `key` (`[a-z0-9_]`, unique), `label`/`description` (multi-language), `timeout_seconds` (5–120), `fields` (optional mini form, same format and rules as `config_schema` entries, keys unique within the action)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `messaging`         | see rules | mandatory when `type` is `"communication"`, forbidden otherwise: `{ "receive": true\|false }` — the family of the channel (contract B.15). `receive: true` = bidirectional chat channel (Telegram-like: users link their account with a short code sent in the channel); `receive: false` = send-only notification channel (Free Mobile/CallMeBot-like: no incoming path, guaranteed server-side)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `contact_schema`    | see rules | mandatory when `messaging.receive` is `false`, forbidden otherwise: per-user identity of the send-only channel, same flat field format and rules as `config_schema` — rendered as the "My account" block of the Configuration screen, where each user enters their own values (passed to the integration with every outgoing message)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `webhooks`          | no        | 1–3 incoming webhooks relayed by Gladys Plus (contract B.17), shown on the install screen: `key` (`[a-z0-9_]`, unique — last segment of the public relay URL), `label` (multi-language, `en` mandatory), `mode` (`fire_and_forget` default: the third party only awaits an acknowledgment; `sync`: the integration response — status 200–499, body ≤ 64 KB — is returned to the caller through Gladys Plus)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The **Docker images are verified against their registry** (Docker Registry HTTP API v2, with an anonymous pull token when the registry asks for one — Docker Hub, GHCR, Quay and self-hosted registries all speak this protocol): a manifest whose image — main or sub-container — does not exist, or cannot be pulled anonymously, is rejected — a catalog entry must have images at the end. Only a definitive registry answer rejects; a transient failure (registry unreachable, 5xx) never evicts an integration that may already be published: it is indexed anyway with a `level: "warning"` entry in `rejected.json`. The check is a `HEAD` on the image manifest, so nothing is downloaded and it does not count against Docker Hub's pull rate limit.

The **user documentation is mandatory**: `docs/en.md` and `docs/fr.md` at the root of the repository, at least 300 characters each — missing, empty or undownloadable files **reject** the integration (`level: "error"` in `rejected.json`). Valid files are **re-hosted** in the store bucket and referenced by the index (`docs` URLs, one per language), so Gladys can show them in the install and configuration screens without hitting third-party servers. The fine structure of the files (template sections) stays conventional.

A missing or invalid **cover** never rejects an integration: it is indexed with a placeholder and a `level: "warning"` entry is published in `rejected.json`. Valid covers are **re-hosted** in the store bucket (no dead links in the catalog, no user IP leaked to third-party servers, guaranteed size and format).

The cover URL must be **direct** (redirects are not followed) and point to a public host (private and reserved addresses are refused); requests time out after 30 seconds. A raw GitHub URL of a file in your own repository (`https://raw.githubusercontent.com/<owner>/<repo>/main/cover.jpg`) satisfies all of this.

There is deliberately **no `permissions` field** in v1: outbound network access from an integration container is open and the Gladys installation screen says so — we do not specify what we cannot enforce.

## Published files

Everything is uploaded to the R2 bucket and served over its public URL (`<STORE_BASE_URL>/...`):

| File                                | Content                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.json`                        | `{ index_format, generated_at, integrations: [{ store_slug, repo_url, manifest, cover_url, docs: { en, fr }, github: { stars, pushed_at, owner_avatar_url } }] }`, sorted by `store_slug` |
| `rejected.json`                     | `[{ store_slug, level, reason, checked_at }]` — `error` = not indexed, `warning` = indexed with a degradation (e.g. placeholder cover)                                                    |
| `manifest.schema.json`              | canonical JSON Schema of the manifest                                                                                                                                                     |
| `covers/<owner>--<repo>.<jpg\|png>` | re-hosted, validated cover images                                                                                                                                                         |
| `covers/placeholder.png`            | cover used when an integration has none                                                                                                                                                   |
| `docs/<owner>--<repo>/<lang>.md`    | re-hosted mandatory user documentation (`en` and `fr`)                                                                                                                                    |

## Moderation (v1: none, on purpose)

There is **no moderation in v1**: no blocklist, no manual removal. The real defenses are the strict Docker sandbox on the Gladys side, the explicit warning shown before installation, and the GitHub metadata (stars, repository age) visible in the catalog. A blocklist can be added later on the indexer side without touching any Gladys client.

Files are uploaded to R2, never deleted: the freshly written `index.json`/`rejected.json` always reference the current covers and docs, so a file left behind by a removed integration is simply unreferenced (pruning is left out on purpose, so the credentials never need delete rights). The index and rejection documents are served with a short `Cache-Control` (they change on every crawl); documentation pages get a medium one (stable URL, content follows the repository); covers and the schema are cached hard.

Uploads are also incremental: every crawl re-writes `index.json` and `rejected.json` (they change each time), but a cover, a documentation page or the schema is only re-uploaded when its bytes actually differ from what's already in the bucket (compared via a cheap `HEAD` on the object's ETag). Covers and docs rarely change, so a steady-state crawl performs a near-constant number of writes regardless of how many integrations the store holds — which keeps the run comfortably inside R2's free write tier at any realistic scale.

## Hosting: Cloudflare R2

The index is published to a **Cloudflare R2 bucket** through its S3-compatible API. To publish (repository Settings → Secrets and variables → Actions):

- Create an R2 bucket and expose it publicly — prefer a **custom domain on Cloudflare** over the bucket's raw `r2.dev` URL: the custom domain is CDN-cached (honouring the `Cache-Control` we set), so reads are served from the edge instead of hitting R2 on every request.
- Create an R2 **API token** scoped to that bucket with object **read + write** (read is used to skip re-uploading unchanged covers; delete is never needed).
- Set the variables and secrets listed under [Development](#development).

The store stays forkable: point `STORE_BASE_URL` at your own bucket URL and the whole pipeline works unchanged. Switching object stores later is a one-file change — any S3-compatible provider works by overriding `R2_ENDPOINT`.

## Resilience

The bucket is fronted by Cloudflare's CDN (no rate limit for Gladys instances); each Gladys keeps a local cache of the index, and installed integrations never depend on the index to run. The worst case (the bucket fully down) suspends the discovery of new integrations, never the operation of existing ones.

## Development

```bash
npm install
npm test              # unit tests (mocha + chai)
npm run coverage      # tests with 100% coverage enforcement
npm run lint          # eslint + prettier
npm run build-index   # build dist/ for real (crawls GitHub)
```

The indexer is plain Node.js (≥ 24), fully unit-tested against fixtures — network clients are injected, so the whole pipeline (validation, cover re-hosting, index generation) is tested deterministically offline.

Configuration of `npm run build-index`, via environment variables:

| Variable               | Required | Role                                                                                                                     |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `STORE_BASE_URL`       | yes      | public base URL of the bucket, no trailing slash (e.g. `https://store.example.com`); used to build every `cover_url`     |
| `R2_ACCOUNT_ID`        | yes\*    | Cloudflare account id; builds the endpoint `https://<id>.r2.cloudflarestorage.com`                                       |
| `R2_BUCKET`            | yes\*    | target bucket name; **when unset, the run is a local build only** (writes `dist/`, uploads nothing)                      |
| `R2_ACCESS_KEY_ID`     | yes\*    | R2 API token access key id (secret)                                                                                      |
| `R2_SECRET_ACCESS_KEY` | yes\*    | R2 API token secret access key (secret)                                                                                  |
| `R2_ENDPOINT`          | no       | explicit S3 endpoint override (takes precedence over `R2_ACCOUNT_ID`; use for another provider or a jurisdiction bucket) |
| `GITHUB_TOKEN`         | no       | GitHub API token (higher rate limit); provided automatically in the Action                                               |
| `STORE_TOPIC`          | no       | topic to crawl (default `gladys-assistant-integration`)                                                                  |
| `OUTPUT_DIR`           | no       | local build directory (default `dist`)                                                                                   |

\* Required only to publish. Omit `R2_BUCKET` to do a local build (`dist/`) without uploading — handy for a dry run.

`assets/placeholder-cover.png` is generated by `npm run generate-placeholder-cover` (dependency-free PNG writer) and committed.

## License

Apache-2.0, like Gladys Assistant.
