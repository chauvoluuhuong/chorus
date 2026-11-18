// Settings › Projects (task #11): the page's builders draw what the mockup draws, never a value, and the proposal card waits
// for a typed value before Approve.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { deleteDialogHtml, deletedText, projectPageHtml, projectsListHtml, proposalCardHtml, proposalTitle, variableDialogHtml } from '../../src/desktop/projects-ui.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const h = { esc, md: (s: string) => `<p>${esc(s)}</p>`, tilde: (p: string) => p.replace('/Users/you', '~'), base: (p: string) => p.split('/').pop() };

const project = (o: Record<string, unknown> = {}) => ({
  folder: '/Users/you/chorus',
  name: 'chorus',
  chats: { total: 24, running: 2 },
  artifacts: 31,
  note: '',
  note_by: '',
  folders: [
    { path: '/Users/you/chorus-core', why: 'launch flags', by: 'you', created: false, exists: true },
    { path: '/Users/you/chorus-workspace', why: 'plans', by: 'claude 3 (claude)', created: true, exists: true },
  ],
  variables: [{ name: 'GITHUB_TOKEN', why: 'gh', by: 'you' }],
  stale: 2,
  ...o,
});

test('the list: chat counts, and tasks only when the paid module counts them', () => {
  const html = projectsListHtml([{ folder: '/Users/you/chorus', name: 'chorus', chats: 24, tasks: 10 }, { folder: '/Users/you/x', name: 'x', chats: 1 }], h);
  assert.match(html, /24 chats · 10 tasks/);
  assert.match(html, /1 chat</);
  assert.match(html, /data-act="project-page" data-arg="\/Users\/you\/chorus"/);
});

test('the page: folders with who and why, names but no value, no stale banner, Export, the Danger zone', () => {
  const html = projectPageHtml(project(), {}, h);
  assert.match(html, /project folder/);
  assert.match(html, /added by you/);
  assert.match(html, /asked by claude 3</);
  assert.match(html, /class="tag new">new/);
  assert.match(html, /GITHUB_TOKEN/);
  assert.match(html, /••••••••/);
  // stale: 2 running chats, but the page shows no banner (owner, 2026-11-18): get_project tells each chat what it is missing
  assert.doesNotMatch(html, /still use|Restart idle ones|proj-banner/);
  assert.match(html, /No description yet\. A chat can propose one, or write it here\./);
  assert.match(html, /Danger zone/);
  assert.match(html, /data-act="rm-project"/);
  // no tasks without Pro
  assert.doesNotMatch(html, /tasks/);
  assert.doesNotMatch(projectPageHtml(project(), { phone: true }, h), /still use|Restart idle ones/);
  assert.doesNotMatch(projectPageHtml(project(), { phone: true, part: 'folders' }, h), /still use|Restart idle ones/);
  assert.match(projectPageHtml(project({ tasks: { total: 10, open: 2 } }), {}, h), /<b>10<\/b><span>tasks/);
});

test('a phone: the project as rows, and each list on its own screen', () => {
  const html = projectPageHtml(project(), { phone: true }, h);
  assert.match(html, /Working folders<span class="val">3/);
  assert.match(html, /Variables<span class="val">1/);
  assert.match(html, /Delete this project…/);
  assert.match(projectPageHtml(project(), { phone: true, part: 'variables' }, h), /Environment variables/);
});

test('edit a variable: the value field starts empty', () => {
  const html = variableDialogHtml(project(), { name: 'GITHUB_TOKEN', why: 'gh' }, h);
  assert.match(html, /id="pv-value" type="password"[^>]*placeholder="leave empty to keep"/);
  assert.doesNotMatch(html, /id="pv-value"[^>]*value=/);
});

test('delete: what goes, what stays, Delete disabled until the name is typed', () => {
  const html = deleteDialogHtml(project({ tasks: { total: 10, open: 1 } }), h);
  assert.match(html, /24 chats, with their messages and records/);
  assert.match(html, /10 tasks, with their steps/);
  assert.match(html, /2 working folders and 1 variable \(the folders themselves stay\)/);
  assert.match(html, /The folder ~\/chorus and every file in it stay/);
  assert.match(html, /data-x="ok" disabled>Delete project/);
  assert.equal(deletedText(project({ tasks: { total: 10 } }), 24), 'Deleted chorus from Chorus: 24 chats, 10 tasks. The folder stays on your disk.');
});

test('the proposal card: titles, rows per change, Approve waits for a typed value', () => {
  const card = (changes: unknown[], options = ['Approve and restart this chat', 'Approve', 'Decline']) => ({ id: 't_1', request: 'r_1', options, proposal: { project: '/Users/you/chorus', changes } });
  assert.equal(proposalTitle(card([{ kind: 'add_folder', path: '/Users/you/chorus-core', why: 'w' }]).proposal, h), 'Add a working folder to "chorus"?');
  assert.equal(proposalTitle(card([{ kind: 'set_note', note: 'n', why: 'w' }]).proposal, h), 'Set up "chorus"?');
  const v = card([{ kind: 'set_variable', name: 'POLAR_SANDBOX_TOKEN', why: 'tests' }]);
  const html = proposalCardHtml(v, undefined, h);
  assert.match(html, /Set <code>POLAR_SANDBOX_TOKEN<\/code> for "chorus"\?/);
  assert.match(html, /Value: you type it, the model never sees it/);
  assert.match(html, /data-value="Approve" disabled>Set variable/);
  assert.match(html, /data-value="Decline">Decline/);
  assert.doesNotMatch(proposalCardHtml(v, { values: { POLAR_SANDBOX_TOKEN: 'x' } }, h), /data-value="Approve" disabled/);
  const setup = proposalCardHtml(card([{ kind: 'set_note', note: 'A desktop app', why: 'so chats know' }, { kind: 'create_folder', path: '/Users/you/notes', why: 'notes' }, { kind: 'set_variable', name: 'A', why: 'a', suggested_value: 'dev' }]), undefined, h);
  assert.match(setup, /textarea[^>]*pp-note[^>]*>A desktop app</);
  assert.match(setup, /new folder/);
  assert.match(setup, /Chorus will create it/);
  assert.match(setup, /value="dev"/);
  assert.doesNotMatch(setup, /disabled/);
});

test('the new-project card: its title, the main folder with "new folder", the rows, Create / Create and open / Decline', () => {
  const a = {
    id: 't_1',
    request: 'r_9',
    options: ['Create', 'Create and open New chat there', 'Decline'],
    proposal: {
      kind: 'new_project',
      project: '/Users/you/dummy-app',
      create: true,
      name: 'dummy-app',
      reason: 'The user asked for it.',
      changes: [
        { kind: 'set_note', note: 'A dummy app.', why: 'the description of the new project' },
        { kind: 'add_folder', path: '/Users/you/dummy-lib', why: 'its library' },
        { kind: 'create_folder', path: '/Users/you/dummy-notes', why: 'notes' },
        { kind: 'set_variable', name: 'DUMMY_TOKEN', why: 'the API' },
      ],
    },
  };
  const html = proposalCardHtml(a, { values: {} }, h);
  assert.match(html, /<div class="ask-q">Create project "dummy-app"\?<\/div>/);
  assert.match(html, /Project folder<\/label><div class="in mono">~\/dummy-app<span class="tag new">new folder<\/span>/);
  assert.match(html, /~\/dummy-lib/);
  assert.match(html, /~\/dummy-notes<span class="tag new">new folder/);
  assert.match(html, /data-name="DUMMY_TOKEN"/);
  assert.match(html, /A dummy app\./);
  // Decline first, Create last and lit; the two Create buttons wait for the typed value
  const btns = [...html.matchAll(/<button class="btn( primary)?" data-act="pp-pick"[^>]*data-value="([^"]+)"( disabled)?/g)].map(m => [m[2], !!m[1], !!m[3]]);
  assert.deepEqual(btns, [['Decline', false, false], ['Create and open New chat there', false, true], ['Create', true, true]]);
  assert.doesNotMatch(proposalCardHtml({ ...a, proposal: { ...a.proposal, create: false } }, { values: { DUMMY_TOKEN: 'x' } }, h), /~\/dummy-app<span class="tag new">/);
});

test('a card for This computer says This computer, never "computer"', () => {
  assert.equal(proposalTitle({ project: '/Users/you/.chorus/computer', name: 'This computer', changes: [{ kind: 'set_note', note: 'n', why: 'w' }] }, h), 'Set up "This computer"?');
});
