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
│ 4. download, validate and re-host each cover image           │
│ 5. build index.json + rejected.json (deterministic)          │
└─────────────────────────────────────────────────────────────┘
        │
        ▼  upload to a Cloudflare R2 bucket (S3-compatible, CDN-fronted)
index.json · rejected.json · manifest.schema.json · covers/
        │
        ▼
every Gladys instance downloads and caches the index
(catalog, one-click install, update detection)
```

## Publish your integration

No account to create, no PR to get approved:

1. Create a **public** GitHub repository for your integration (start from the [`integration-template-js`](https://github.com/GladysAssistant/integration-template-js) template).
2. Put a valid **`gladys-assistant-integration.json`** manifest at the root of the default branch.
3. Add the **`gladys-assistant-integration`** topic to the repository.
4. Wait for the next hourly indexing: your integration appears in the catalog of every Gladys instance.
5. Publish a new version = bump `version` and `docker_image` in the manifest and push. That's it.

If your integration does not show up, check the public `rejected.json` (at `<STORE_BASE_URL>/rejected.json`): every rejected manifest is listed with the reason, so you can diagnose it yourself.

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
      "key": "latitude",
      "type": "number",
      "label": { "en": "Latitude", "fr": "Latitude" },
      "placeholder": { "en": "48.85", "fr": "48,85" },
      "required": true,
      "default": 48.85,
      "min": -90,
      "max": 90
    }
  ]
}
```

### Validation rules

| Field              | Required | Rules                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest_version` | yes      | `1`; a manifest with a higher version is rejected                                                                                                                                                                                                                                                                         |
| `type`             | yes      | `"device"` (only value in v1)                                                                                                                                                                                                                                                                                             |
| `name`             | yes      | 3–30 characters (title of the catalog card)                                                                                                                                                                                                                                                                               |
| `description`      | yes      | object `{lang: text}`, `en` key mandatory, each value 10–100 characters                                                                                                                                                                                                                                                   |
| `version`          | yes      | strict semver; bump it to trigger "update available" in Gladys                                                                                                                                                                                                                                                            |
| `docker_image`     | yes      | well-formed image reference on any public registry, with an **explicit tag or digest**                                                                                                                                                                                                                                    |
| `gladys_version`   | yes      | semver range (npm syntax), used for the compatibility filter                                                                                                                                                                                                                                                              |
| `cover_image`      | no       | `https` URL of a **JPEG or PNG**, **exactly 800×534 px**, **≤ 150 KB**                                                                                                                                                                                                                                                    |
| `config_schema`    | no       | flat list of fields: `key` (`[a-z0-9_]`, unique), `type` (`string` \| `number` \| `boolean` \| `select` \| `secret`), `label` (multi-language, `en` mandatory), `description`, `placeholder` (multi-language, `string`/`number`/`secret` only), `required`, `default`, `min`/`max` (number only), `options` (select only) |

A missing or invalid **cover** never rejects an integration: it is indexed with a placeholder and a `level: "warning"` entry is published in `rejected.json`. Valid covers are **re-hosted** in the store bucket (no dead links in the catalog, no user IP leaked to third-party servers, guaranteed size and format).

The cover URL must be **direct** (redirects are not followed) and point to a public host (private and reserved addresses are refused); requests time out after 30 seconds. A raw GitHub URL of a file in your own repository (`https://raw.githubusercontent.com/<owner>/<repo>/main/cover.jpg`) satisfies all of this.

There is deliberately **no `permissions` field** in v1: outbound network access from an integration container is open and the Gladys installation screen says so — we do not specify what we cannot enforce.

## Published files

Everything is uploaded to the R2 bucket and served over its public URL (`<STORE_BASE_URL>/...`):

| File                                | Content                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.json`                        | `{ index_format, generated_at, integrations: [{ store_slug, repo_url, manifest, cover_url, github: { stars, pushed_at, owner_avatar_url } }] }`, sorted by `store_slug` |
| `rejected.json`                     | `[{ store_slug, level, reason, checked_at }]` — `error` = not indexed, `warning` = indexed with a degradation (e.g. placeholder cover)                                  |
| `manifest.schema.json`              | canonical JSON Schema of the manifest                                                                                                                                   |
| `covers/<owner>--<repo>.<jpg\|png>` | re-hosted, validated cover images                                                                                                                                       |
| `covers/placeholder.png`            | cover used when an integration has none                                                                                                                                 |

## Moderation (v1: none, on purpose)

There is **no moderation in v1**: no blocklist, no manual removal. The real defenses are the strict Docker sandbox on the Gladys side, the explicit warning shown before installation, and the GitHub metadata (stars, repository age) visible in the catalog. A blocklist can be added later on the indexer side without touching any Gladys client.

Files are uploaded to R2, never deleted: the freshly written `index.json`/`rejected.json` always reference the current covers, so a cover left behind by a removed integration is simply unreferenced (pruning is left out on purpose, so the credentials never need delete rights). The index and rejection documents are served with a short `Cache-Control` (they change on every crawl); covers and the schema are cached hard.

Uploads are also incremental: every crawl re-writes `index.json` and `rejected.json` (they change each time), but a cover or the schema is only re-uploaded when its bytes actually differ from what's already in the bucket (compared via a cheap `HEAD` on the object's ETag). Covers almost never change, so a steady-state crawl performs a near-constant number of writes regardless of how many integrations the store holds — which keeps the run comfortably inside R2's free write tier at any realistic scale.

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
