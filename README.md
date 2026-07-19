# opencode-qoder

Qoder Global provider plugin for [opencode](https://opencode.ai/). This is a port of the global-only pieces of `pi-provider-qoder`: PAT exchange, COSY request signing, Qoder body encoding, chat SSE parsing, reasoning, image input, and tool calls.

Qoder China endpoints and model aliases are intentionally not included.

## Build

```bash
npm install
npm run build
```

## Installation

Add the built plugin to `opencode.json` in this repo, or adjust the relative path for your config location:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qoder"],
  "model": "qoder/auto"
}
```

The plugin registers provider `qoder` and these models: `auto`, `ultimate`, `performance`, `efficient`, `lite`, `qmodel_preview`, `qmodel`, `qmodel_latest`, `dmodel`, `dfmodel`, `gm51model`, `kmodel_latest`, `kmodel`, and `mmodel`.

## Authenticate

Use a Qoder Personal Access Token (`pt-...`). A PAT is exchanged for a short-lived Qoder job token automatically before requests.

```bash
export QODER_PERSONAL_ACCESS_TOKEN="pt-..."
opencode
```

You can also run opencode's auth flow after the plugin is loaded:

```text
/connect qoder
```

Choose `Personal Access Token` and paste the PAT.

After adding or changing the plugin config, quit and restart opencode. Plugins and provider config are loaded at startup.
