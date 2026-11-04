# agy: no Chorus tools after the trust dialog

**Issue:** https://github.com/chauvoluuhuong/chorus/issues/19 · **Found:** 2026-11-01, agy 1.4.12

**What happened:** if agy's folder-trust dialog is answered 2 s or more after it shows, the first message runs but the workspace's MCP server never starts, so that chat has no Chorus tools. Answered at once, it starts. It looks like a normal chat either way.

**Why it was easy to miss:** `smoke:ask` answers the dialog at once, faster than a person, and the chat itself works, so only a tool server's log shows the difference.

**Lesson:** a test that answers dialogs instantly can hide a race a person hits. Check that the MCP server started, not only that the agent answered. Trust a chat's folder per session where the CLI allows it (`--settings` on agy).
