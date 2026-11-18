// Settings › Projects (task #11, @workspace/mockups/projects-settings.html): the list, one project's page, its dialogs, and the
// propose_project_change card. Plain functions that return HTML; app.js gives them the page's helpers (esc, md, tilde, base) and
// wires the buttons. A variable's VALUE never comes here: the page only ever has names, and the card's typed values live in the
// page's memory until Approve sends them.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "claude 3 (claude)" → "claude 3": the card's who, without the agent the server adds */
const who = by => String(by ?? '').replace(/ \((claude|codex|agy)\)$/, '');
const byText = by => (!by || by === 'you' ? 'added by you' : `asked by ${who(by)}`);

/** Scene 3: every project that has a chat, newest activity first. Without Pro, only chat counts. */
export function projectsListHtml(list, h) {
  const { esc, tilde } = h;
  if (!list) return '<div class="page proj-page"><p class="muted">Loading the projects…</p></div>';
  const rows = list
    .map(p => `<button class="prow" data-act="project-page" data-arg="${esc(p.folder)}"><span class="n">${esc(p.name)}</span><span class="p">${esc(tilde(p.folder))}</span><span class="c">${plural(p.chats, 'chat')}${p.tasks != null ? ` · ${plural(p.tasks, 'task')}` : ''}</span><span class="chev">›</span></button>`)
    .join('');
  return `<div class="page proj-page">${rows ? `<div class="card proj-card">${rows}</div>` : '<p class="muted">No projects yet: a project shows here once it has a chat, or once a chat creates it.</p>'}<p class="sub">Every project, newest activity first.</p></div>`;
}

/** The stats row: chats, tasks (only when the paid module counts them), artifacts. */
function statsHtml(p) {
  const s = [[p.chats.total, p.chats.total === 1 ? 'chat' : 'chats'], ...(p.tasks ? [[p.tasks.total, p.tasks.total === 1 ? 'task' : 'tasks']] : []), [p.artifacts, p.artifacts === 1 ? 'artifact' : 'artifacts']];
  return `<div class="stats" style="--n:${s.length}">${s.map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('')}</div>`;
}

/** "About this project": the note (Markdown), its Edit, and who wrote it. */
function aboutHtml(p, ui, h) {
  const { esc, md } = h;
  const head = `<div class="hm-h">About this project${ui.editNote ? '' : `<button class="add" data-act="proj-note-edit">${p.note ? 'Edit' : '＋ Write one…'}</button>`}</div>`;
  if (ui.editNote) {
    return `${head}<div class="card about"><textarea id="proj-note" class="proj-note" data-input="proj-note" rows="5" aria-label="About this project" placeholder="What this project is, and how its folders relate">${esc(ui.noteDraft ?? p.note ?? '')}</textarea><div class="btns"><button class="btn" data-act="proj-note-cancel">Cancel</button><button class="btn primary" data-act="proj-note-save">Save</button></div></div>`;
  }
  const body = p.note ? `<div class="md">${md(p.note)}</div>` : '<p class="faint">No description yet. A chat can propose one, or write it here.</p>';
  return `${head}<div class="card about">${body}${p.note && p.note_by ? `<div class="by">by ${esc(who(p.note_by))}</div>` : ''}</div>`;
}

function foldersHtml(p, h) {
  const { esc, tilde } = h;
  const rows = p.folders
    .map(f => `<div class="lrow"><div class="m2"><span class="m" title="${esc(f.path)}">${esc(tilde(f.path))}</span>${f.why ? `<span class="why">${esc(f.why)}</span>` : ''}</div>${f.created ? '<span class="tag new">new</span>' : ''}${f.exists === false ? '<span class="tag gone" title="This folder is not on disk">missing</span>' : ''}<span class="by">${esc(byText(f.by))}</span><button class="x" data-act="proj-folder-rm" data-arg="${esc(f.path)}" title="Remove ${esc(tilde(f.path))} (it stays on disk)" aria-label="Remove ${esc(tilde(f.path))}">×</button></div>`)
    .join('');
  return `<div class="hm-h">Working folders<button class="add" data-act="proj-folder-add">＋ Add folder…</button></div>
    <div class="card"><div class="lrow"><span class="m">${esc(tilde(p.folder))}</span><span class="by">project folder</span></div>${rows}</div>
    <p class="sub">Every chat started here can read and edit these folders too: Claude and Codex through <code>--add-dir</code>, Antigravity through its own flag. Your CLI settings are never changed.</p>`;
}

function variablesHtml(p, h) {
  const { esc } = h;
  const rows = p.variables
    .map(v => `<div class="lrow"><div class="m2"><span class="m">${esc(v.name)}</span>${v.why ? `<span class="why">${esc(v.why)}</span>` : ''}</div><span class="v" aria-label="value hidden">••••••••</span><button class="e" data-act="proj-var-edit" data-arg="${esc(v.name)}">Edit</button><button class="x" data-act="proj-var-rm" data-arg="${esc(v.name)}" title="Remove ${esc(v.name)}" aria-label="Remove ${esc(v.name)}">×</button></div>`)
    .join('');
  return `<div class="hm-h">Environment variables<button class="add" data-act="proj-var-add">＋ Add variable…</button></div>
    <div class="card">${rows || '<div class="lrow"><span class="faint">No variables yet.</span></div>'}</div>
    <p class="sub">Given to every chat started here. Values stay on this Mac, in a file only you can read, and never go into an export. Models see the names only.</p>`;
}

function exportHtml(p, exporting) {
  return `<div class="act"><div><b>Export this project</b>Its ${p.tasks ? 'chats, tasks and' : 'chats and'} artifacts in one .zip in Downloads, plus the folder and variable names (never the values). Nothing is uploaded.</div><button class="btn primary" data-act="proj-export"${exporting ? ' disabled' : ''}>${exporting ? 'Exporting…' : '⤓ Export'}</button></div>`;
}

const DELETE_TEXT = p => `Removes its chats, ${p.tasks ? 'tasks, ' : ''}folders and variables from Chorus. The folder and its files stay on your disk.`;

/**
 * Scene 4 (a desktop or tablet) and scene 10 (a phone): one project. `ui`: {editNote, noteDraft, part, exporting}; on a phone
 * `part` 'folders' or 'variables' shows that list on its own screen.
 */
export function projectPageHtml(p, ui, h) {
  const { esc, tilde } = h;
  if (!p) return '<div class="page proj-page"><p class="muted">Loading the project…</p></div>';
  if (p.error) return `<div class="page proj-page"><p class="err">${esc(p.error)}</p></div>`;
  if (ui.phone && ui.part === 'folders') return `<div class="page proj-page">${foldersHtml(p, h)}</div>`;
  if (ui.phone && ui.part === 'variables') return `<div class="page proj-page">${variablesHtml(p, h)}</div>`;
  const top = `<div class="ptitle">${esc(p.name)}</div><div class="ppath">${esc(tilde(p.folder))}</div>`;
  if (ui.phone) {
    const r = (act, ic, t, val, chev = true) => `<button class="mrow" data-act="${act}"><span class="ico">${ic}</span>${t}<span class="val">${val}</span>${chev ? '<span class="chev">›</span>' : ''}</button>`;
    return `<div class="page proj-page phone">${top}${statsHtml(p)}${aboutHtml(p, ui, h)}
      <div class="card">${r('proj-part', '▤', 'Working folders', p.folders.length + 1).replace('data-act="proj-part"', 'data-act="proj-part" data-arg="folders"')}${r('proj-part', '$', 'Variables', p.variables.length).replace('data-act="proj-part"', 'data-act="proj-part" data-arg="variables"')}${r('proj-export', '⤓', ui.exporting ? 'Exporting…' : 'Export', 'to Downloads', false)}</div>
      <div class="dz">Danger zone</div>
      <div class="card"><button class="mrow danger" data-act="rm-project" data-arg="${esc(p.folder)}">Delete this project…</button></div></div>`;
  }
  return `<div class="page proj-page">${top}${aboutHtml(p, ui, h)}${statsHtml(p)}
    <div class="twocol"><div>${foldersHtml(p, h)}</div><div>${variablesHtml(p, h)}</div></div>
    <div class="hm-h" style="margin-top:16px">Export</div>${exportHtml(p, ui.exporting)}
    <div class="dz">Danger zone</div>
    <div class="act danger"><div><b>Delete this project</b>${DELETE_TEXT(p)}</div><button class="btn" data-act="rm-project" data-arg="${esc(p.folder)}">Delete…</button></div></div>`;
}

/** Scene 5: add a variable, or edit one (its value field starts EMPTY: the page never has a value). */
export function variableDialogHtml(p, v, h) {
  const { esc } = h;
  const edit = !!v;
  return `<div class="dialog proj-dlg" role="dialog" aria-label="${edit ? `Edit ${esc(v.name)}` : 'Add a variable'}"><h2>${edit ? `Edit ${esc(v.name)} in "${esc(p.name)}"` : `Add a variable to "${esc(p.name)}"`}</h2><div class="body">
    <label class="f" for="pv-name">Name</label><input id="pv-name" class="in mono" autocomplete="off" spellcheck="false" placeholder="GITHUB_TOKEN" value="${esc(v?.name ?? '')}"${edit ? ' readonly' : ''}>
    <label class="f" for="pv-value">Value</label><div class="in pw"><input id="pv-value" type="password" class="mono" autocomplete="off" spellcheck="false"${edit ? ' placeholder="leave empty to keep"' : ''}><button class="eye" data-x="show" type="button">Show</button></div>
    <label class="f" for="pv-why">What is it for? <span class="faint">(optional)</span></label><input id="pv-why" class="in" autocomplete="off" value="${esc(v?.why ?? '')}">
    <div class="hint">Kept on this Mac only. New chats get it at once; running ones get it when they restart.</div><div class="err" data-x="err" hidden></div></div>
    <div class="foot"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="ok">${edit ? 'Save' : 'Add'}</button></div></div>`;
}

/** Scene 6: what goes, what stays; Delete only once the project's name is typed. */
export function deleteDialogHtml(p, h) {
  const { esc, tilde } = h;
  const nf = p.folders.length, nv = p.variables.length;
  const items = [
    `${plural(p.chats.total, 'chat')}, with their messages and records`,
    ...(p.tasks ? [`${plural(p.tasks.total, 'task')}, with their steps, cards and watch records`] : []),
    `${plural(p.artifacts, 'artifact')} it keeps`,
    ...(nf || nv || p.note ? [`${p.note ? 'its description, ' : ''}${plural(nf, 'working folder')} and ${plural(nv, 'variable')}${nf ? ' (the folders themselves stay)' : ''}`] : []),
  ];
  return `<div class="dialog proj-dlg" role="dialog" aria-label="Delete project ${esc(p.name)}?"><h2>Delete project "${esc(p.name)}"?</h2><div class="body">
    Chorus removes, from Chorus only:<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
    <div class="keep">✓ The folder ${esc(tilde(p.folder))} and every file in it stay.</div>
    <div class="hint" style="margin-top:10px">Export it first if you may want it back. Type <b>${esc(p.name)}</b> to confirm.</div>
    <input class="in mono" data-x="name" autocomplete="off" spellcheck="false" aria-label="Type ${esc(p.name)} to confirm"></div>
    <div class="foot"><button class="btn" data-x="export">Export first</button><span style="flex:1"></span><button class="btn" data-x="cancel">Cancel</button><button class="btn danger-fill" data-x="ok" disabled>Delete project</button></div></div>`;
}

export const deletedText = (p, removed) => `Deleted ${p.name} from Chorus: ${plural(removed, 'chat')}${p.tasks ? `, ${plural(p.tasks.total, 'task')}` : ''}. The folder stays on your disk.`;

/* ---------- the propose_project_change card (scenes 7 and 8, and the setup card) ---------- */

/** "Set up <project>?" for a description or 3+ changes, else the one change's question as drawn. */
export function proposalTitle(p, h) {
  const { esc } = h;
  const name = esc(p.name ?? (p.project.replace(/\/+$/, '').split('/').pop() || p.project));
  if (p.kind === 'new_project') return `Create project "${name}"?`;
  const c = p.changes;
  if (c.some(x => x.kind === 'set_note') || c.length >= 3) return `Set up "${name}"?`;
  if (c.length === 2) return `Make 2 changes to "${name}"?`;
  const one = c[0];
  return {
    add_folder: `Add a working folder to "${name}"?`,
    create_folder: `Create a folder and add it to "${name}"?`,
    remove_folder: `Remove a working folder from "${name}"?`,
    set_variable: `Set <code>${esc(one.name)}</code> for "${name}"?`,
    remove_variable: `Remove <code>${esc(one.name)}</code> from "${name}"?`,
  }[one.kind] ?? `Change "${name}"?`;
}

/** What Approve reads on the card: the plain "Approve" names the one change when there is one. */
export function optionLabel(p, option) {
  if (p.kind === 'new_project') return option;
  const one = p.changes.length === 1 ? p.changes[0].kind : '';
  if (option === 'Approve') return { add_folder: 'Add folder', create_folder: 'Create and add', set_variable: 'Set variable', remove_folder: 'Remove folder', remove_variable: 'Remove variable', set_note: 'Save description' }[one] ?? 'Approve';
  if (option === 'Approve and restart this chat' && one === 'set_variable') return 'Set and restart this chat';
  return option;
}

/**
 * The card's body: one row per change with its why quoted. `typed`: {values: {NAME: text}, note} the user typed so far (kept by
 * app.js across redraws). Approve waits for every variable's value.
 */
export function proposalCardHtml(a, typed, h) {
  const { esc, tilde, md } = h;
  const p = a.proposal;
  const name = p.name ?? (p.project.replace(/\/+$/, '').split('/').pop() || p.project);
  const fresh = p.kind === 'new_project';
  const req = `data-arg="${esc(a.id)}" data-req="${esc(a.request)}"`;
  const vals = typed?.values ?? {};
  const q = why => (why ? `<div class="why">"${esc(why)}"</div>` : '');
  let lock = false;
  const rows = p.changes
    .map(c => {
      switch (c.kind) {
        case 'set_note':
          return `<div class="pp-row"><label class="f">Description</label><textarea class="in pp-input pp-note" data-input="pp-note" data-req="${esc(a.request)}" rows="4" aria-label="Description of ${esc(name)}">${esc(typed?.note ?? c.note ?? '')}</textarea>${fresh ? '' : q(c.why)}</div>`;
        case 'add_folder':
          return `<div class="pp-row"><div class="in mono">${esc(tilde(c.path))}</div>${q(c.why)}</div>`;
        case 'create_folder':
          return `<div class="pp-row"><div class="in mono">${esc(tilde(c.path))}<span class="tag new">new folder</span></div><div class="hint">Chorus will create it.</div>${q(c.why)}</div>`;
        case 'remove_folder':
          return `<div class="pp-row"><div class="in mono gone"><s>${esc(tilde(c.path))}</s><span class="tag">remove</span></div><div class="hint">It stays on disk.</div>${q(c.why)}</div>`;
        case 'remove_variable':
          return `<div class="pp-row"><div class="in mono gone"><s>${esc(c.name)}</s><span class="tag">remove</span></div>${q(c.why)}</div>`;
        case 'set_variable': {
          lock = true;
          const v = vals[c.name] ?? c.suggested_value ?? '';
          const label = p.changes.length === 1 ? 'Value: you type it, the model never sees it' : `<code>${esc(c.name)}</code>: you type the value, the model never sees it`;
          return `<div class="pp-row">${p.changes.length === 1 && !fresh ? q(c.why) : ''}<label class="f">${label}</label><div class="in pw"><input type="password" class="mono pp-input pp-val" data-input="pp-val" data-req="${esc(a.request)}" data-name="${esc(c.name)}" autocomplete="off" spellcheck="false" value="${esc(v)}" aria-label="Value of ${esc(c.name)}"><button class="eye" data-act="pp-show" type="button">Show</button></div>${p.changes.length === 1 && !fresh ? '' : q(c.why)}</div>`;
        }
        default:
          return '';
      }
    })
    .join('');
  const missing = p.changes.filter(c => c.kind === 'set_variable' && !(vals[c.name] ?? c.suggested_value ?? '')).map(c => c.name);
  const single = p.changes.length === 1 && !fresh;
  const hint = fresh ? `<div class="hint">Every chat started in ${esc(name)} gets these. Nothing is made until you choose.</div>` : single && p.changes[0].kind === 'add_folder' ? `<div class="hint">Every chat in ${esc(name)} will get it, running ones too.</div>` : !single ? `<div class="hint">Every chat in ${esc(name)} gets these. Nothing changes until you choose.</div>` : '';
  // Decline first, the agent's first option last and lit (the mockup's order: right-aligned, the main one at the end)
  const opts = [...a.options].reverse();
  const btns = opts
    .map(o => {
      const main = o === a.options[0];
      const wait = o !== 'Decline' && missing.length;
      return `<button class="btn${main ? ' primary' : ''}" data-act="pp-pick" ${req} data-value="${esc(o)}"${wait ? ' disabled' : ''}>${esc(optionLabel(p, o))}</button>`;
    })
    .join('');
  // the new project's main folder first, with "new folder" when Chorus makes it
  const main = fresh ? `<div class="pp-row"><label class="f">Project folder</label><div class="in mono">${esc(tilde(p.project))}${p.create ? '<span class="tag new">new folder</span>' : ''}</div></div>` : '';
  return `<div class="ask-q">${proposalTitle(p, h)}</div>${p.reason ? `<div class="why reason">${md(p.reason)}</div>` : ''}<div class="pp-rows">${main}${rows}</div>${hint}
    ${lock ? '<div class="lock">🔒 Kept on this Mac. The chat hears only that it is set.</div>' : ''}
    ${missing.length ? `<div class="hint pp-wait">Type a value for ${missing.map(esc).join(', ')} to approve.</div>` : ''}
    <div class="btns">${btns}</div>`;
}
