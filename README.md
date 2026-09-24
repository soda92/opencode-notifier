# local-notify

Minimal, dependency-free desktop-notification plugin for **OpenCode 2** on Linux
(designed for KDE; anything with `notify-send` works).

A single TypeScript file, loaded directly by OpenCode — no build step, no npm
package, no third-party dependencies.

## Notifications

| Event | Alert | Sound |
| --- | --- | --- |
| Turn complete (`session.execution.succeeded` / `session.idle`) | ✅ normal | `complete` |
| Permission needed (`permission.asked`, auto-approvals skipped) | 🔑 critical | `dialog-question` |
| Execution failed (`session.execution.failed`) | ❌ critical | `dialog-error` |
| Interrupted (`session.execution.interrupted`, off by default) | ⏹️ low | `dialog-warning` |
| Question tool (`execute.before`, tool `question`) | ❓ normal | `dialog-question` |

Sub-agent sessions (with a parent session) stay silent. Completion alerts are
deduplicated across `succeeded`/`idle` and across the multiple plugin instances
the OpenCode service spawns (lock files under `/tmp/opencode/notify-claims`).

Requirements on `PATH`: `notify-send` (libnotify) and `canberra-gtk-play`
(libcanberra) for sounds.

## Install

```sh
./install.sh
```

This symlinks `local-notify.ts` into `~/.config/opencode/plugins/` (honoring
`XDG_CONFIG_HOME`), checks for `notify-send` / `canberra-gtk-play`, and sends a
test notification. The symlink tracks this checkout, so a `git pull` is enough
to update.

Options:

| Flag | Effect |
| --- | --- |
| `--copy` | Copy the file instead of symlinking (static snapshot) |
| `--force` | Replace an existing plugin file/symlink |
| `--no-test` | Skip the test notification |
| `--uninstall` | Remove the plugin from the plugins dir |

Or install manually:

```sh
mkdir -p ~/.config/opencode/plugins
cp local-notify.ts ~/.config/opencode/plugins/local-notify.ts
# or symlink to track this checkout:
# ln -sf "$PWD/local-notify.ts" ~/.config/opencode/plugins/local-notify.ts
```

Restart OpenCode (or save the file — the service hot-reloads file plugins).

## Configure (optional)

`~/.config/opencode/local-notify.json`:

```json
{
  "sound": true,
  "events": {
    "complete": true,
    "permission": true,
    "error": true,
    "question": true,
    "interrupted": false
  }
}
```

Debug: run OpenCode with `LOCAL_NOTIFIER_DEBUG=1`; seen events are appended to
`/tmp/opencode/live-events.log`.
