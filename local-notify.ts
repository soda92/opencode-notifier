/**
 * local-notify — minimal OpenCode 2 notifier (Linux/KDE, zero dependencies).
 *
 * Native desktop notifications via `notify-send` and theme sounds via
 * `canberra-gtk-play` for:
 *   - turn complete        (session.execution.succeeded / session.idle)
 *   - permission needed    (permission.asked; auto-approved ones are skipped)
 *   - error / interruption (session.execution.failed / .interrupted)
 *   - question tool        (execute.before hook, tool === "question")
 *
 * Sub-agent sessions (parentID set) are ignored for completion.
 *
 * Optional config: ~/.config/opencode/local-notify.json
 *   {
 *     "sound": true,
 *     "events": { "complete": true, "permission": true,
 *                 "error": true, "question": true, "interrupted": false }
 *   }
 *
 * Debug: LOCAL_NOTIFIER_DEBUG=1 appends every seen event to
 *        /tmp/opencode/live-events.log
 */

import { appendFileSync, readFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync } from "node:fs"
import { basename, join } from "node:path"
import { spawn as nodeSpawn } from "node:child_process"

const ID = "local-notify"
const PERMISSION_GRACE_MS = 300
const COMPLETE_DEDUP_MS = 30_000
const DEBUG_LOG = "/tmp/opencode/live-events.log"

type Ctx = any
type Urgency = "low" | "normal" | "critical"

interface Config {
  sound: boolean
  events: Record<string, boolean>
}

const DEFAULT_CONFIG: Config = {
  sound: true,
  events: {
    complete: true,
    permission: true,
    error: true,
    question: true,
    interrupted: false,
  },
}

const debug = (...parts: unknown[]) => {
  if (process.env.LOCAL_NOTIFIER_DEBUG !== "1") return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${parts.join(" ")}\n`)
  } catch {
    // ignore
  }
}

function loadConfig(): Config {
  const cfg: Config = {
    sound: DEFAULT_CONFIG.sound,
    events: { ...DEFAULT_CONFIG.events },
  }
  try {
    const path =
      process.env.LOCAL_NOTIFY_CONFIG ??
      `${process.env.HOME}/.config/opencode/local-notify.json`
    const raw = JSON.parse(readFileSync(path, "utf8"))
    if (typeof raw.sound === "boolean") cfg.sound = raw.sound
    if (raw.events && typeof raw.events === "object") {
      for (const key of Object.keys(cfg.events)) {
        if (typeof raw.events[key] === "boolean") cfg.events[key] = raw.events[key]
      }
    }
  } catch {
    // no config file — defaults
  }
  return cfg
}

function spawn(cmd: string, args: string[]): void {
  try {
    const child = nodeSpawn(cmd, args, {
      stdio: "ignore",
      env: process.env,
    })
    child.on("error", (err) => debug("SPAWN_ERROR", cmd, String(err)))
    child.unref()
  } catch (err) {
    debug("SPAWN_THREW", cmd, String(err))
  }
}

function notify(kind: string, summary: string, body: string, urgency: Urgency, sound?: string): void {
  const config = loadConfig()
  if (config.events[kind] === false) return

  debug("NOTIFY", kind, body)
  spawn("notify-send", ["--app-name=OpenCode", `--urgency=${urgency}`, summary, body])
  if (config.sound && sound) spawn("canberra-gtk-play", ["-i", sound])
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The service can instantiate a global file plugin more than once per boot,
 * and every instance sees the same event stream. Claim files in /tmp act as a
 * cross-process lock so exactly one notification is sent per event.
 * Returns true when THIS caller won the claim.
 */
const CLAIM_DIR = "/tmp/opencode/notify-claims"

function claim(key: string, ttlMs: number): boolean {
  const safe = key.replace(/[^a-zA-Z0-9:._-]/g, "_")
  const file = join(CLAIM_DIR, safe)
  const retry = (attempt: number): boolean => {
    try {
      mkdirSync(CLAIM_DIR, { recursive: true })
      const fd = openSync(file, "wx")
      closeSync(fd)
      setTimeout(() => {
        try {
          unlinkSync(file)
        } catch {
          // already gone
        }
      }, ttlMs).unref?.()
      return true
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        // Stale claim from a crashed instance?
        try {
          if (Date.now() - statSync(file).mtimeMs > ttlMs && attempt < 2) {
            unlinkSync(file)
            return retry(attempt + 1)
          }
        } catch {
          // unlink raced — treat as claimed
        }
        return false
      }
      debug("CLAIM_ERROR", key, String(err))
      return true // fail open rather than swallow a notification
    }
  }
  return retry(0)
}

export default {
  id: ID,

  async setup(ctx: Ctx) {
    debug("SETUP", "app=" + JSON.stringify(ctx.app ?? null), "location=" + JSON.stringify(ctx.location ?? null))

    const project = (() => {
      const dir: string | undefined = ctx.location?.directory
      return dir ? basename(dir) : "opencode"
    })()

    // Session metadata cache (parent / title).
    const sessions = new Map<string, { parentID?: string | null; title?: string | null }>()
    // Last completion alert per session (dedupe succeeded vs idle).
    const lastCompleteAt = new Map<string, number>()

    const remember = (sessionID: string | null | undefined, patch: object) => {
      if (!sessionID) return
      sessions.set(sessionID, { ...(sessions.get(sessionID) ?? {}), ...patch })
    }

    const describe = async (
      sessionID: string
    ): Promise<{ parentID: string | null; title: string | null }> => {
      const cached = sessions.get(sessionID)
      if (cached && (cached.parentID !== undefined || cached.title !== undefined)) {
        return { parentID: cached.parentID ?? null, title: cached.title ?? null }
      }
      try {
        const info = await ctx.session.get({ sessionID })
        const next = {
          parentID: info?.parentID ?? null,
          title: typeof info?.title === "string" ? info.title : null,
        }
        sessions.set(sessionID, next)
        return next
      } catch {
        return { parentID: null, title: null }
      }
    }

    const notifyComplete = async (sessionID: string | null | undefined) => {
      if (!sessionID) return
      if (Date.now() - (lastCompleteAt.get(sessionID) ?? 0) < COMPLETE_DEDUP_MS) return

      const info = await describe(sessionID)
      if (info.parentID) return // sub-agent completion — stay quiet

      // Cross-instance lock: succeeded + idle, or multiple plugin instances.
      if (!claim(`complete:${sessionID}`, COMPLETE_DEDUP_MS)) return

      lastCompleteAt.set(sessionID, Date.now())
      notify(
        "complete",
        "✅ OpenCode finished",
        info.title ? `${info.title} · ${project}` : project,
        "normal",
        "complete"
      )
    }

    const isStillPending = async (sessionID: string, permissionID: string): Promise<boolean> => {
      try {
        const list = await ctx.permission.list({ sessionID })
        const pending = Array.isArray(list) ? list : list?.data
        if (!Array.isArray(pending)) return true // fail open: unknown => notify
        return pending.some((p: any) => p?.id === permissionID)
      } catch {
        return true
      }
    }

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const envelope of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const type: string | undefined = envelope?.type
            const data = envelope?.data ?? envelope?.properties ?? {}
            const eventID: string | undefined = envelope?.id
            debug("EVENT", type, JSON.stringify(data).slice(0, 200))

            switch (type) {
              case "session.created":
                remember(data.sessionID, { parentID: data.parentID, title: data.title })
                break

              case "session.execution.started":
                lastCompleteAt.delete(data.sessionID)
                break

              case "session.execution.succeeded":
                await notifyComplete(data.sessionID)
                break

              case "session.idle":
                // Long-lived TUI service emits idle; standalone runs only emit
                // succeeded. Deduped above so we never double-alert.
                await notifyComplete(data.sessionID)
                break

              case "session.execution.failed":
                if (eventID && !claim(`event:${eventID}`, COMPLETE_DEDUP_MS)) break
                notify("error", "❌ OpenCode hit an error", project, "critical", "dialog-error")
                break

              case "session.execution.interrupted": {
                if (eventID && !claim(`event:${eventID}`, COMPLETE_DEDUP_MS)) break
                const reason = data.reason ?? data.cause ?? data.source
                if (reason === "user") {
                  notify("interrupted", "⏹️ OpenCode interrupted", project, "low", "dialog-warning")
                } else {
                  notify("error", "❌ OpenCode interrupted", project, "critical", "dialog-error")
                }
                break
              }

              case "permission.asked": {
                const sessionID: string | undefined = data.sessionID
                const permissionID: string | undefined = data.id
                if (sessionID && permissionID && !claim(`permission:${sessionID}:${permissionID}`, COMPLETE_DEDUP_MS)) {
                  break
                }
                if (sessionID && permissionID) {
                  await sleep(PERMISSION_GRACE_MS)
                  if (!(await isStillPending(sessionID, permissionID))) break
                }
                notify(
                  "permission",
                  "🔑 OpenCode needs permission",
                  `Waiting for approval · ${project}`,
                  "critical",
                  "dialog-question"
                )
                break
              }
            }
          } catch (err) {
            debug("HANDLER_ERROR", String(err))
          }
        }
      } catch (err) {
        debug("SUBSCRIBE_ERROR", String(err))
      }
    })()

    try {
      await ctx.tool.hook("execute.before", (event: any) => {
        try {
          debug("HOOK", event?.tool)
          if (event?.tool === "question") {
            const key = event.id ?? `${event.sessionID}:${event.messageID ?? ""}`
            if (claim(`question:${key}`, COMPLETE_DEDUP_MS)) {
              notify(
                "question",
                "❓ OpenCode has a question",
                project,
                "normal",
                "dialog-question"
              )
            }
          }
        } catch (err) {
          debug("HOOK_ERROR", String(err))
        }
      })
    } catch (err) {
      debug("HOOK_REGISTER_ERROR", String(err))
    }

    return () => controller.abort()
  },
}
