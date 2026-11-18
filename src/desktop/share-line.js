// Share (owner, 2026-11-18): one line that names a chat, to paste into another Chorus chat. Only the id and where the sidebar
// shows it: no full path, no transcript. A model reading the line opens the chat with get_handoff_context or get_thread_turns.

const base = p => (p || '').replace(/\/+$/, '').split('/').pop() || '/';

/** The project as the sidebar names it: "This computer" for the computer folder, else the folder's last part. */
export function shareProject(chat, computer) {
  const folder = chat.project ?? chat.cwd ?? '';
  return computer && folder.replace(/\/+$/, '') === computer.replace(/\/+$/, '') ? 'This computer' : base(folder);
}

/** "Chorus thread t_568328d4 · chorus › Planner · Projects". A task's chat is named as its row under the task (`pro.chatPath`:
 *  Planner, Step 2 · …); every other chat, sub threads included, by its current title (after rename_chat too). */
export function shareLine(chat, { computer, pro } = {}) {
  let name = chat.title ?? '';
  try {
    const t = typeof pro?.chatPath === 'function' ? pro.chatPath(chat.id) : null;
    if (t?.part) name = t.part;
  } catch {
    // an older module: the chat's own title
  }
  return `Chorus thread ${chat.id} · ${shareProject(chat, computer)} › ${String(name).replace(/\s+/g, ' ').trim()}`;
}
