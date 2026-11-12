// Who the docked ask card says is asking (ui-mockup-v3: UC-06 a plain chat names the agent, UC-14 a task chat its teammate).
// The optional module names a chat's teammate (`choruspro.chatTeammate`, chorus-core 72cc8f3); an older module, a plain chat, or
// a module whose data has not loaded yet gives none, and the card names the agent.

/** { name, agent, teammate }: the teammate running the chat's work session when there is one, else the chat's agent. */
export function askWho(chat, pro, agents) {
  let t = null;
  try {
    t = typeof pro?.chatTeammate === 'function' ? pro.chatTeammate(chat.id) : null;
  } catch {
    t = null; // the module failed: the agent's name is still right
  }
  if (t && typeof t.name === 'string' && t.name) return { name: t.name, agent: t.agent || chat.agent, teammate: true };
  return { name: agents[chat.agent]?.name ?? chat.agent, agent: chat.agent, teammate: false };
}
