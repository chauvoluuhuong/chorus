# Desktop notifications

The desktop server checks the Chorus notification API once per process launch. Opening a window, changing projects, focusing the app, and opening the inbox read the local cache. There are no notification polling timers, background workers, focus checks, or automatic retries. A failed launch check leaves the existing cache available until the next launch.

The inbox uses the current desktop theme. The bell shows unread messages; opening a message marks it read locally and sends a deduplicated opened event. Mark all as read changes local state without reporting that the messages were opened. Failed events stay queued for the next launch or an explicit message open. Receipt events are included with the next launch or explicit open request. Counts describe reporting installations and unique opens, not verified people or proof that someone read the content.

A random installation ID and credential are persisted in `~/.chorus/notifications/inbox.json` (or under `CHORUS_HOME`). The file is private to the current OS user. The browser never receives the credential. The API receives only the installation identity, platform, app version, and notification receipt/open events. Chats, prompts, repositories, and local paths are not included. Set `CHORUS_NOTIFICATIONS=0` before launching to disable the feature.

Only sanitized HTML returned by the API is rendered. Content lives in an opaque sandboxed iframe with a restrictive content security policy. Publisher scripts, forms, frames, and native APIs are unavailable. A host-owned nonce-authorized script forwards trusted link clicks; the local server allows only HTTPS links present in the cached notification and opens them in the external browser. Images are limited to the configured Google Cloud Storage host. HTML never enters the application's main DOM.

The client validates feed size and item shape, preserves the cache on malformed responses, bounds network calls to eight seconds, and never prevents the app from opening when the cloud service is unavailable. An unreadable installation file is preserved instead of silently registering a new installation.
