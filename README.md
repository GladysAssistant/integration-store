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
│ 2. skip the ones listed in data/blocklist.json (fraud)       │
│ 3. fetch gladys-assistant-integration.json from each repo    │
│ 4. validate mechanically (JSON Schema + code rules)          │
│ 5. check the mandatory user docs (docs/en.md + docs/fr.md)   │
│ 6. check the Docker image exists on its registry             │
│ 7. download, validate and re-host each cover image           │
│ 8. resolve the browse categories (manifest, else fallback    │
│    mapping) and carry first_seen_at over the previous index  │
│ 9. build index.json + rejected.json (deterministic)          │
└─────────────────────────────────────────────────────────────┘
        │
        ▼  upload to a Cloudflare R2 bucket (S3-compatible, CDN-fronted)
index.json · rejected.json · manifest.schema.json · widget-content.schema.json · covers/ · docs/
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

If your integration does not show up, check the public `rejected.json` (at `<STORE_BASE_URL>/rejected.json`): every rejected manifest is listed with the reason, so you can diagnose it yourself. A reason prefixed by `blocklist:` means the repository is listed in [`data/blocklist.json`](data/blocklist.json) (see [Moderation](#moderation-the-blocklist)).

## Test your integration locally

No need to wait for the hourly indexing to discover a rejection: run the exact same admission checks locally, from the root of your integration repository:

```bash
npx github:GladysAssistant/integration-store
```

(or point it at a directory: `npx github:GladysAssistant/integration-store path/to/my-integration`)

It replays the validation of the indexer against your local `gladys-assistant-integration.json`:

- JSON Schema + code rules (same `validateManifest` code as the robot), including the `gladys_version` compatibility gates of the newer manifest fields;
- the browse categories (unknown keys the indexer would drop, and whether the integration would appear uncategorized in the catalog);
- the mandatory user documentation (`docs/en.md` and `docs/fr.md` next to the manifest, at least 300 characters each);
- the Docker images (main and sub-containers) exist on their registry and are anonymously pullable;
- the cover contract (JPEG or PNG, exactly 800x534, ≤ 150 KB).

The exit code is `0` when the integration would be indexed and `1` when it would be rejected; warnings are the non-blocking degradations also published in `rejected.json` (e.g. placeholder cover). Unlike the hourly robot, the local run reports **all** problems at once, so everything can be fixed in a single pass.

What a local run cannot verify: that the repository is public, tagged with the `gladys-assistant-integration` topic, and that the manifest is pushed at the root of the default branch.

### In the CI of your pull requests

A pull request that bumps `version` and `docker_image` references an image tag that the release has not pushed yet, and the very first image of a new integration does not exist until its first release: the registry check would fail on every such pull request. Skip it there with `--skip-image-check`:

```bash
npx github:GladysAssistant/integration-store --skip-image-check
```

Every other check still runs (schema and code rules, docs, cover, categories) and the image reference format is still validated; each skipped image is reported as a warning, so the run never claims a verification it did not do. With the flag, exit code `0` means every other check passes: the integration would be indexed only once its images are published.

The indexer itself always checks the images and rejects an integration whose image is missing — it is then dropped from the catalog until the next indexing. So publish the images **before** the manifest that references them reaches the default branch, and run the validator once more **without** the flag once they are published (e.g. as the last step of your release workflow).

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
  "gladys_version": ">=5.1.0",
  "categories": ["environment"],
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
    },
    {
      "key": "broker",
      "type": "section",
      "label": { "en": "Connect your devices" },
      "description": { "en": "Point your devices to mqtt://{{gladys_host}}:{{port:mqtt_broker}}" }
    }
  ],
  "transports": ["local", "cloud"],
  "containers": [
    {
      "name": "mqtt",
      "docker_image": "eclipse-mosquitto:2.0.18",
      "start": "manual",
      "volumes": ["/mosquitto/config"],
      "ports": [{ "container_port": 1883, "label": { "en": "MQTT broker" }, "name": "mqtt_broker", "browsable": false }]
    }
  ],
  "location": true,
  "network_wake": true,
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
  ],
  "widgets": [
    {
      "key": "forecast",
      "label": { "en": "Weather forecast", "fr": "Prévisions météo" },
      "icon": "cloud",
      "settings": [
        { "key": "station", "type": "select", "source": "devices", "label": { "en": "Station" }, "required": true }
      ]
    }
  ],
  "scene_triggers": [
    {
      "key": "storm_warning",
      "label": { "en": "Storm warning", "fr": "Alerte tempête" },
      "fields": [{ "key": "station", "type": "select", "source": "devices", "label": { "en": "Station" } }],
      "variables": [{ "key": "wind_speed", "type": "number", "label": { "en": "Wind speed (km/h)" } }]
    }
  ],
  "scene_actions": [
    {
      "key": "refresh_forecast",
      "label": { "en": "Refresh the forecast", "fr": "Rafraîchir les prévisions" },
      "fields": [
        { "key": "station", "type": "select", "source": "devices", "label": { "en": "Station" }, "required": true }
      ],
      "outputs": [{ "key": "temperature", "type": "number", "label": { "en": "Temperature" } }]
    }
  ]
}
```

### Validation rules

| Field               | Required  | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest_version`  | yes       | `1`; a manifest with a higher version is rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `type`              | yes       | the **primary contract** the Gladys core consumes: `"device"` (publishes discovered devices), `"communication"` (messaging channel, Configuration screen only; its family is declared by the mandatory `messaging` field), `"weather"` (weather provider, Configuration screen only: it answers the weather requests of the Gladys core over WebSocket, in the pivot format normalized by the core — contract B.18) or `"provider"` (an integration made **only of capabilities** — dashboard widgets, scene triggers and actions: no device surface, a configuration-only page, and at least one of `widgets`, `scene_triggers`, `scene_actions` is **required**). Any type may declare the capability fields on top of its primary contract. Declaring `"provider"` requires `gladys_version` ≥ 5.1.0 (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `name`              | yes       | 3–30 characters (title of the catalog card)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `description`       | yes       | object `{lang: text}`, `en` key mandatory, each value 10–100 characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `version`           | yes       | strict semver; bump it to trigger "update available" in Gladys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `docker_image`      | yes       | well-formed image reference on any public registry, with an **explicit tag or digest**; the image must **actually exist** on its registry and be anonymously pullable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `gladys_version`    | yes       | semver range (npm syntax), used for the compatibility filter. Its minimum must also cover every field or `type` value that **older Gladys releases reject as unknown** (their validator has a strict allowlist, so the range turns a cryptic install failure into the standard "requires Gladys ≥ X" catalog filter — enforced as a validation error): **≥ 4.86.0** when `categories` is declared, **≥ 5.1.0** when `type` is `"provider"` or when `widgets`, `scene_triggers` or `scene_actions` is declared                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `categories`        | no        | 1–3 **unique, non-empty strings**: the browse categories of the catalog (domains of use, decoupled from the technical `type`). Two-stage validation: the shape above **rejects** like any other malformed field, then the controlled vocabulary (`climate`, `lighting`, `energy`, `security`, `multimedia`, `appliances`, `environment`, `protocols`, `network`, `notifications`, `assistants`, `services`) **filters** — unknown keys are dropped with a `level: "warning"` in `rejected.json`, never a rejection, so a manifest published with a newer vocabulary than a running Gladys still installs. Declaring the field **requires a `gladys_version` range whose minimum is ≥ 4.86.0** (the first release accepting it, see `gladys_version`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cover_image`       | no        | `https` URL of a **JPEG or PNG**, **exactly 800×534 px**, **≤ 150 KB**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `config_schema`     | no        | flat list of fields: `key` (`[a-z0-9_]`, unique), `type` (`string` \| `number` \| `boolean` \| `select` \| `multi_select` \| `secret` \| `oauth2` \| `account_link` \| `section`), `label` (multi-language, `en` mandatory), `description`, `placeholder` (multi-language, `string`/`number`/`secret` only), `required`, `default` (matches the field type, forbidden on `secret`/`oauth2`/`account_link` and dynamic-`source` selects), `min`/`max` (number only), `options` **or** `source` (`"devices"`: options provided by the Gladys core, mutually exclusive with `options`; select/multi_select only), `display` (`dropdown` \| `radio`, select only). `oauth2` renders a Connect button (relayed OAuth2 authorization-code flow, tokens stored off-schema); `account_link` renders a Connect button too, for a provider that **never redirects back** (a QR sign-in approved in the vendor app, a pairing confirmed on a device): no redirect URI, no anti-CSRF state, no callback — the integration detects the approval itself and reports it through its connection status. `section` fields are purely presentational intro blocks: no stored value (`required`/`default`/`placeholder` forbidden), plain-text `description` (≤ 1000 characters per language) and up to 5 `links` (`https` only, multi-language `label`). The `label` and `description` of a `section` may embed the `{{gladys_host}}` and `{{port:<name>}}` placeholders (see below) |
| `transports`        | no        | non-empty unique subset of `local`/`cloud`; declaring both renders the standard "Prefer local (LAN) connection" toggle in Gladys (reserved `GLADYS_PREFER_LOCAL` config key)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `containers`        | no        | up to 5 sub-container declarations (multi-container integrations, e.g. Frigate + Mosquitto): `name` (`[a-z0-9-]{2,20}`, unique), `docker_image` (same rules as the main image, existence verified too), `start` (`auto` \| `manual`), `env` (strings, `GLADYS_*` reserved), `volumes` (≤ 5 absolute paths, no `..`), `ports` (≤ 3: `container_port`, `protocol`, multi-language `label`, optional `name` (`[a-z0-9_]{2,20}`, unique across the **whole** manifest — the target of the `{{port:<name>}}` placeholder), `browsable` (default `true`; `false` for a port serving no web UI, shown without an "Open" link)), `devices` (`coral-usb` \| `coral-pcie` \| `gpu` \| `video`, unique), `read_only`, `memory_mb` (32–4096), `cpu` (0.1–2), `shm_mb` (64–512), `command`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `location`          | no        | `true` requests access to the coordinates of the houses configured in Gladys (`GET /house` host API). The home location is sensitive personal data: the request is shown on the install screen, and an integration that did not declare it gets a `403` — enforced server-side, same authorization-contract pattern as `network_discovery` and `webhooks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `network_wake`      | no        | `true` requests permission to send **Wake-on-LAN magic packets** through the Gladys core host API (`POST /network/wake`). Shown on the install screen as an authorization contract; an integration that did not declare it gets a `403` — enforced server-side, same pattern as `location`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `network_discovery` | no        | 1–5 mediated capture requests: `udp-broadcast` (passive listen, 1–5 unique `ports`), `udp-active-broadcast` (active query/response: the core broadcasts an integration-forged payload on one of the 1–5 declared `ports` and relays the unicast replies), `mdns` (DNS-SD `service`, e.g. `_hue._tcp`) or `ssdp` (`st`, ≤ 200 characters) — each type only carries its own field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `actions`           | no        | 1–10 on-demand operations rendered as buttons: `key` (`[a-z0-9_]`, unique), `label`/`description` (multi-language), `timeout_seconds` (5–120), `fields` (optional mini form, same format and rules as `config_schema` entries, keys unique within the action)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `messaging`         | see rules | mandatory when `type` is `"communication"`, forbidden otherwise: `{ "receive": true\|false }` — the family of the channel (contract B.15). `receive: true` = bidirectional chat channel (Telegram-like: users link their account with a short code sent in the channel); `receive: false` = send-only notification channel (Free Mobile/CallMeBot-like: no incoming path, guaranteed server-side)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `contact_schema`    | see rules | mandatory when `messaging.receive` is `false`, forbidden otherwise: per-user identity of the send-only channel, same flat field format and rules as `config_schema`, minus `oauth2` and `account_link` fields (linking a provider account is integration-scoped, never per user) and minus the `{{port:<name>}}` placeholder — rendered as the "My account" block of the Configuration screen, where each user enters their own values (passed to the integration with every outgoing message)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `webhooks`          | no        | 1–3 incoming webhooks relayed by Gladys Plus (contract B.17), shown on the install screen: `key` (`[a-z0-9_]`, unique — last segment of the public relay URL), `label` (multi-language, `en` mandatory), `mode` (`fire_and_forget` default: the third party only awaits an acknowledgment; `sync`: the integration response — status 200–499, body ≤ 64 KB — is returned to the caller through Gladys Plus)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `widgets`           | no        | 1–5 **dashboard widgets** declared by the integration (capability field, any type may declare it — `capabilities/dashboard-widgets.md`): `key` (`[a-z0-9_]{2,32}`, unique), `label` (multi-language, `en` mandatory, 3–30 characters per language), `description` (multi-language, ≤ 100 characters per language), `icon` (Feather icon name, shape-validated only: an unknown name renders the generic icon, never an error), `settings` (≤ 10 per-instance fields, same format and rules as `config_schema` entries, keys unique within the widget, types restricted to `string` \| `number` \| `boolean` \| `select` \| `multi_select` \| `section` — settings live in a dashboard JSON readable by every user, so `secret`/`oauth2`/`account_link` are refused, and so is the `{{port:<name>}}` placeholder; `source: "devices"` binds an instance to one of the integration's devices), `action_timeout_seconds` (5–120, default 30). The manifest declares the widget's **identity**; its **content** is produced at runtime by the integration in the published [widget content vocabulary](#capability-fields-and-the-widget-content-vocabulary). Requires `gladys_version` ≥ 5.1.0                                                                                                                                                                                                                                                                        |
| `scene_triggers`    | no        | 1–20 **scene triggers** declared for the Gladys scene editor (capability field, any type — `capabilities/scene-triggers-and-actions.md`): `key` (`[a-z0-9_]`, ≤ 40 characters, unique among the triggers — the identifier the integration fires and the one the scenes store: **never renamed** once published), `label`/`description` (multi-language), `fields` (≤ 10 filters the scene author fills in, same format and rules as `config_schema` entries, keys unique within the trigger, types restricted to `string` \| `number` \| `select` \| `multi_select` \| `section` — no `boolean`, a toggle cannot express "any"; no `secret`/`oauth2`/`account_link`; no `{{port:<name>}}` placeholder), `variables` (≤ 20 `{ key, type: string \| number \| boolean, label, description }`, keys unique: the **only** event data a scene reads, as `{{triggerEvent.data.<key>}}`). Requires `gladys_version` ≥ 5.1.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `scene_actions`     | no        | 1–20 **scene actions** declared for the Gladys scene editor (capability field, any type): same `key`/`label`/`description` rules as the triggers (unique among the actions — triggers and actions are two namespaces), `timeout_seconds` (5–120, default 30: the ack delay granted to the relayed action), `fields` (≤ 10 parameters, same rules as the trigger filters plus `boolean`; `string` fields accept scene variables `{{…}}`, resolved by the core before the relay), `outputs` (≤ 20, same format as `variables`: the values the action returns to the following scene actions). Adding a `required` field without a `default` to a published action is a breaking change for the scenes using it. Requires `gladys_version` ≥ 5.1.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The `label` and `description` of a `section` field may embed two **plain-text placeholders**, substituted by the Gladys frontend at render time (exact syntax, no space inside the braces): **`{{gladys_host}}`**, the hostname of the address the browser currently uses to reach Gladys, and **`{{port:<name>}}`**, the host port Gladys assigned to the sub-container port declaring that `name`. They are the declarative way to spell out an address of the instance itself in a form ("point your charge point to `ws://{{gladys_host}}:{{port:ocpp}}/`") — the server cannot build it, the browser knows it. Two rules are enforced here: a `{{port:<name>}}` referencing a name declared by **no** port of the manifest **rejects** the integration (an unknown reference would stay unresolved on screen forever), and `{{port:<name>}}` is **refused in the `contact_schema`** — that per-user block is rendered from the reduced view a non-admin gets, which carries no container state, so the token would resolve for an admin and stay raw for everyone else. `{{gladys_host}}` needs no declaration and is allowed everywhere.

The **Docker images are verified against their registry** (Docker Registry HTTP API v2, with an anonymous pull token when the registry asks for one — Docker Hub, GHCR, Quay and self-hosted registries all speak this protocol): a manifest whose image — main or sub-container — does not exist, or cannot be pulled anonymously, is rejected — a catalog entry must have images at the end. Only a definitive registry answer rejects; a transient failure (registry unreachable, 5xx) never evicts an integration that may already be published: it is indexed anyway with a `level: "warning"` entry in `rejected.json`. The check is a `HEAD` on the image manifest, so nothing is downloaded and it does not count against Docker Hub's pull rate limit.

The **user documentation is mandatory**: `docs/en.md` and `docs/fr.md` at the root of the repository, at least 300 characters each — missing, empty or undownloadable files **reject** the integration (`level: "error"` in `rejected.json`). Valid files are **re-hosted** in the store bucket and referenced by the index (`docs` URLs, one per language), so Gladys can show them in the install and configuration screens without hitting third-party servers. The fine structure of the files (template sections) stays conventional.

A missing or invalid **cover** never rejects an integration: it is indexed with a placeholder and a `level: "warning"` entry is published in `rejected.json`. Valid covers are **re-hosted** in the store bucket (no dead links in the catalog, no user IP leaked to third-party servers, guaranteed size and format).

The cover URL must be **direct** (redirects are not followed) and point to a public host (private and reserved addresses are refused); requests time out after 30 seconds. A raw GitHub URL of a file in your own repository (`https://raw.githubusercontent.com/<owner>/<repo>/main/cover.jpg`) satisfies all of this.

There is deliberately **no `permissions` field** in v1: outbound network access from an integration container is open and the Gladys installation screen says so — we do not specify what we cannot enforce. What does exist are **targeted, enforceable authorization contracts** — `containers`, `network_discovery`, `webhooks`, `location`, `network_wake` — each declared in the manifest, shown to the user before install, and enforced server-side.

### Catalog categories and "Newest first"

Two index-level fields feed the navigation of the Gladys catalog (its sidebar shelves and its "Newest first" sort):

- **`categories`** — the browse categories of the entry: the manifest's `categories` when declared (filtered against the controlled vocabulary), else the entry of the **fallback mapping file** [`data/category-fallback.json`](data/category-fallback.json), else `[]` — uncategorized: the integration stays visible under "All" and in search, but sits on no shelf, and a `level: "warning"` entry is published in `rejected.json` (declaring the field is the author's incentive for a better placement). The fallback file is the one-time seed that categorized the pre-existing catalog without waiting for every author to republish; it is keyed by `store_slug` (never by display name, which is neither unique nor stable), it is amendable by simple PR — including by the integration's author — and it shrinks over time, since a manifest declaring its own `categories` always wins over it.
- **`first_seen_at`** — the first indexing date of the `store_slug`, persisted across hourly rebuilds: the indexer re-reads its own previously published `index.json` before rebuilding and carries the date over, so the "Newest first" sort of the catalog is stable. A slug never seen before is stamped with the crawl date; an entry indexed before the field existed is backfilled once from the GitHub repository creation date (never `github.pushed_at` — a documentation commit would reshuffle the sort). If the previous index cannot be fetched (anything but a clean 404), the run **aborts** rather than silently re-seeding every date.

### Capability fields and the widget content vocabulary

`widgets`, `scene_triggers` and `scene_actions` are **capability fields**: contracts the Gladys core does not consume through a dedicated interface, declarable by every integration type on top of its primary contract (a vacuum `device` integration with a widget, a `communication` channel with a "message received" trigger). An integration whose whole contract is made of capabilities — no device, no messaging, no weather — declares the technical type `"provider"`, and must then carry at least one capability field. The install screen lists each capability (the declared widgets, triggers and actions) as an information line; the scene editor and the dashboard box picker render them with the same form engine as the `config_schema`.

The manifest only declares a widget's **identity** (key, label, icon, settings): its **content** is produced at runtime by the integration (`widget.get` over WebSocket) in a declarative vocabulary the core normalizes, bounds and renders — no HTML, no script, no free color or size. That vocabulary is published by this repository as [`schemas/widget-content.schema.json`](schemas/widget-content.schema.json) (served at `<STORE_BASE_URL>/widget-content.schema.json`): eight component types (`text`, `value`, `gauge`, `status`, `chart`, `card-list`, `image`, `button`), semantic colors, curated icons, bounded texts, `https` links, images served by the integration itself and live bindings to its own device features. The SDK dev mode validates every content against this schema and the **content budget** (at most 8 components, one focal component, 6 tiles, 2 texts, 1 status list, 4 buttons — components beyond a cap are dropped in content order by the core, never the whole content), so a widget that ships is a widget that fits. Evolutions of the vocabulary are additive only.

## Published files

Everything is uploaded to the R2 bucket and served over its public URL (`<STORE_BASE_URL>/...`):

| File                                | Content                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.json`                        | `{ index_format, generated_at, integrations: [{ store_slug, repo_url, manifest, cover_url, docs: { en, fr }, github: { stars, pushed_at, owner_avatar_url }, categories, first_seen_at }] }`, sorted by `store_slug` |
| `rejected.json`                     | `[{ store_slug, level, reason, checked_at }]` — `error` = not indexed, `warning` = indexed with a degradation (e.g. placeholder cover)                                                                               |
| `manifest.schema.json`              | canonical JSON Schema of the manifest                                                                                                                                                                                |
| `widget-content.schema.json`        | canonical JSON Schema of the widget content vocabulary (what an integration returns for a declared dashboard widget)                                                                                                 |
| `covers/<owner>--<repo>.<jpg\|png>` | re-hosted, validated cover images                                                                                                                                                                                    |
| `covers/placeholder.png`            | cover used when an integration has none                                                                                                                                                                              |
| `docs/<owner>--<repo>/<lang>.md`    | re-hosted mandatory user documentation (`en` and `fr`)                                                                                                                                                               |

## Moderation: the blocklist

The store approves nothing a priori. The only moderation is a **public denylist of exceptions**, [`data/blocklist.json`](data/blocklist.json), applied by the indexer on top of the mechanical admission rules. It exists for the fraudulent case — an integration impersonating another one, a Docker image that exfiltrates credentials, phishing in the documentation — never for quality disputes. The real defenses for everything else remain the strict Docker sandbox on the Gladys side, the explicit warning shown before installation, and the GitHub metadata (stars, repository age) visible in the catalog.

- **Two kinds of entries**: `repositories`, keyed by `store_slug` (`owner/repo`), and `owners`, keyed by GitHub login — for an account that keeps republishing under new repository names (a `store_slug` alone is escaped by a simple repository rename). Matching is case-insensitive, and a `repositories` entry wins over an `owners` one. Every entry carries a public `reason` (published verbatim), a `reference` (an https URL — in practice the issue of this repository documenting the case) and a `blocked_at` date. The test suite validates the file, and an invalid file aborts the indexing run rather than silently re-admitting anything.
- **Effect**: a blocked repository is skipped **before any fetch** — no manifest, documentation, cover or registry request, so nothing of it is re-hosted on the store domain. It is listed in `rejected.json` with `level: "error"` and a reason prefixed by `blocklist:` carrying the public reason and reference, so every removal is auditable by anyone.
- **Process**: open an issue labelled `blocklist` describing the case, then a pull request adding the entry with the issue as `reference`. Merging publishes a new index within minutes — the build workflow runs on every push to `main` — without waiting for the hourly crawl. Unblocking is the reverse pull request. A fork of the store is free to empty or replace the file.
- **Limits**: the blocklist removes an integration from the catalog and stops its update detection; it does not uninstall it from running instances. Files already re-hosted (covers, docs) stay in the bucket, unreferenced, per the no-delete policy below. An integration blocked then unblocked is stamped with a new `first_seen_at`.

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
