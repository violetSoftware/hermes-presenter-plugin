# Hermes Presenter

Present a local JSON slide deck in a browser with your current Hermes conversation as co-presenter. The browser connects **paused**; only an explicit handover requests an answer and speech. Stop detaches the presenter without ending your conversation.

Native plugin **0.1.2**, companion engine **0.1.0**. Linux, local CLI/TUI/Desktop surfaces only; messaging and unattended sessions are not supported. Includes a neutral purple sample, system fonts and a geometric mark.

## Requirements and compatibility

- An installed Hermes runtime with `PluginContext.session_surface`, profile-aware secrets and existing-session gateway transport. Source tests use Hermes commit `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19` on Linux. That installed checkout contains unrelated local modifications; this is not a clean upstream-release compatibility certification.
- Node satisfying `^22.22.2 || ^24.15.0 || >=26.0.0` and npm. Node `v22.22.3` was used for source verification.
- An ElevenLabs account/key and voice ID, plus the model provider already configured for your Hermes conversation. Model, speech and optional transcription can incur charges.

No minimum Hermes release has been established; `requires_hermes` is deliberately undeclared rather than inventing a version floor. Older versions are unsupported unless separately tested. The transport imports `hermes_cli.gateway_client` and `hermes_cli.gateway_runtime`, which are undocumented/private APIs and can break after a Hermes update. The catalog validator warns on these imports; maintainer review is still required. No runtime override of Hermes core is used.

## Install from source

These commands are installation instructions, not something the plugin performs automatically. Replace `my-profile` with your chosen profile. For the default profile, omit `-p my-profile` and use `$HOME/.hermes` as its home.

```sh
git clone https://github.com/violetSoftware/hermes-presenter-plugin.git
cd hermes-presenter-plugin
# For a reviewed installation, check out the full SHA supplied by the catalog
# or publisher before continuing. Use this same checkout for both components.
git rev-parse HEAD
(cd engine && npm ci --omit=dev)

PROFILE_HOME="$HOME/.hermes/profiles/my-profile"
mkdir -p "$PROFILE_HOME/plugins"
# Do not overwrite an existing installation without backing it up first.
test ! -e "$PROFILE_HOME/plugins/hermes-presenter" && \
  cp -R plugin "$PROFILE_HOME/plugins/hermes-presenter"
hermes -p my-profile config set plugins.entries.hermes-presenter.settings.engine_root "$PWD/engine"
hermes -p my-profile config set plugins.entries.hermes-presenter.settings.voice YOUR_ELEVENLABS_VOICE_ID
hermes -p my-profile setup
hermes -p my-profile plugins enable hermes-presenter
hermes -p my-profile plugins doctor hermes-presenter
hermes -p my-profile tools enable hermes-presenter --platform cli
```

In Hermes setup, configure `ELEVENLABS_API_KEY` for **that profile** using its secret-management route. Never put the key in plugin settings, a deck, command arguments or this repository. The plugin reads it at call time through `agent.secret_scope.get_secret`; status and stop do not require a key. Voice can alternatively come from `tts.elevenlabs.voice_id`.

The **engine is external to the installed plugin package**, but its complete source and lockfile are in this repository's `engine/` directory. Installing only `plugin/` (including through a future catalog listing with `subdir: plugin`) does not install the engine or npm dependencies. Obtain `engine/` from **the same reviewed full commit SHA** as the plugin, install its dependencies and set its absolute `engine_root`. Do not point at a moving branch or mix engine and plugin checkouts. Keep that engine directory available after installation. Nothing downloads or updates it at runtime. Vite is a direct runtime build dependency; `--omit=dev` retains it.

If using TUI or Desktop, enable the toolset for the corresponding supported platform and start a fresh conversation if its tool schema is stale. No gateway restart is required by these source instructions; check your runtime's reload result separately.

## Use

In an identified local Hermes conversation, ask:

> Start the sample presentation. I approve sharing the sample deck and attended model/ElevenLabs costs.

The start tool selects `registered_deck: sample`, with explicit `approve_share` and `approve_paid`. It returns a URL. **Let the tool turn finish before opening it.** Click Connect: the presenter remains paused and performs no inference. Explicitly hand over in the browser to request co-presentation; keep the original conversation idle. Reconnect and later handovers attach to that same caller conversation. Ask Hermes to stop when finished.

For your own deck, explicitly select its absolute JSON `deck_path`, or map a name to a local JSON file under `plugins.entries.hermes-presenter.settings.decks`. Selection shares the JSON **including speaker notes** and its referenced flat raster assets with the browser. Review those files first. The sample and schemas are in `plugin/sample/` and `engine/src/schema/`.

Tools: `presenter_start`, `presenter_status`, `presenter_stop`. Session identity is runtime-owned, never a tool argument. Another conversation cannot stop or reuse the owned service.

## Network, processes, files and privacy

- Start launches a child Node service/build; Connect starts an installed-Hermes Python transport. These are long-running children, stopped by the owning stop/unload path. No self-updater or runtime downloads.
- Handovers use the existing conversation's model provider and ElevenLabs speech API. Optional microphone transcription uses ElevenLabs and is separately billed. Set `microphone: true` only intentionally; browser consent is also required. No telemetry or usage reporting is implemented.
- Reads include the selected deck/assets, installed engine/dependencies, installed Hermes modules, and active-profile settings/secrets via Hermes APIs. Child processes receive a restricted environment; the ElevenLabs key is passed privately over child stdin, not command arguments. No direct credential-store reads by this plugin.
- Runtime copies, logs and receipts are retained under the active home's `plugin-data/hermes-presenter/` by default (or explicit `runtime_dir`) until you remove them deliberately after stopping. Treat those files as private; stop is not deletion.
- The original conversation retains its tools and policy. **This is not a sandbox**: tool-bearing output can only be refused after observation, without rollback. Do not treat presenter checks as protection against actions already executed by the caller's model.
- Local HTTP binds loopback, default port `5174` (`port: 0` selects a free port). Loopback refers to the machine/network namespace running Hermes, not necessarily your physical desktop. There is no built-in authentication or TLS. For remote browsers, establish an independently authenticated HTTPS reverse proxy protecting the **entire origin**, preserve Host/Origin and configure the exact HTTPS `base_url`. The plugin does not create proxies, tunnels or authentication. Never expose the loopback service directly to an untrusted network.

## Bounds

Deck JSON: 64,000 bytes, 1–16 slides; optional running order: 32 segments. Each note/visible text: 2,000 characters; serialized grounding: 24,000 UTF-8 bytes. Referenced flat raster assets: 256,000 bytes each. Existing handover: 32,000 UTF-16 code units; prompt receipt: 34,000; compact proof: 220,000 UTF-8 bytes; complete output frame: 228,000 bytes. Oversize input is refused, not silently truncated. This is a bounded presentation MVP, not a general context framework.

## Verify source behavior

Use the dependency-enabled Python belonging to your installed Hermes, with its source on `PYTHONPATH`, from this repository root:

```sh
PYTHONPATH=/path/to/installed/hermes python3 -B verification/test_relocated.py
PYTHONPATH=/path/to/installed/hermes python3 -B plugin/tests/test_dependency.py
```

The relocation smoke builds/serves the sample and checks real tool schemas, exact deck HTTP bytes, paused Connect and owned stop, using native/speech doubles. The dependency regression exercises a detached base-Python helper with activated dependencies and inert attach/detach RPC doubles. They do not contact providers or live sessions. Engine npm dependencies must already be installed.

Optional visual check: install dev dependencies with `npm ci` in `engine/`, provide an existing Playwright Chromium installation, then run `node verification/visual.mjs /absolute/output-directory`. It does not download Chromium; screenshots/evidence belong outside the source tree.

`EXPORT-MANIFEST.json` inventories source file sizes and SHA-256 values, excluding itself and Git/runtime/dependency outputs. These checks are source/relocation evidence, not fresh-machine dependency-install, live paid-provider, microphone, remote-deployment or catalog acceptance. Catalog inclusion requires a separate human-reviewed PR in [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/README.md).

## License

MIT, copyright 2026 violetSoftware. See [LICENSE](LICENSE), [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [THIRD-PARTY.json](THIRD-PARTY.json). Dependencies retain their own licenses and notices; no dependency binaries, user talks, credentials, proprietary fonts or employer branding are bundled.
