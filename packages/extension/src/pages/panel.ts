import type { OperationData, OperationName, PlacementNode, ProjectNode, Team } from '../api/operations';
import { AnnotationModel } from '../lib/annotations';
import { assembleCapture } from '../lib/capture';
import { normalizeOrigin } from '../lib/connect';
import { buildBugReportInput, defaultSteps, validateForm, type BugForm, type Location, type Severity } from '../lib/form';
import { ask, type CaptureResult, type PickerMessage } from '../lib/messages';
import type { ConnectionStatus } from '../lib/settings';
import type { PageInfo, PickedElement, RecorderSnapshot } from '../lib/types';
import { ScreenshotEditor } from './editor';

/**
 * The side panel (INV-1147): screenshot editor, element picker and the bug
 * form. It is opened for one tab (`?tab=<id>`, set by the background when the
 * toolbar button or shortcut opens it); "Open larger" opens the same page in a
 * tab with the same draft. Every request to Involute goes through the
 * background, which holds the token.
 */
const TRIAGE = '__triage';
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tab'));
const draftKey = `draft:${tabId}`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  connection: $<HTMLSpanElement>('connection'),
  notice: $<HTMLParagraphElement>('notice'),
  canvas: $<HTMLCanvasElement>('canvas'),
  shotStatus: $<HTMLParagraphElement>('shot-status'),
  undo: $<HTMLButtonElement>('undo'),
  redo: $<HTMLButtonElement>('redo'),
  textTool: $<HTMLLabelElement>('text-tool'),
  annotationText: $<HTMLInputElement>('annotation-text'),
  pick: $<HTMLButtonElement>('pick'),
  retake: $<HTMLButtonElement>('retake'),
  larger: $<HTMLButtonElement>('larger'),
  picked: $<HTMLParagraphElement>('picked'),
  form: $<HTMLFormElement>('form'),
  title: $<HTMLInputElement>('title'),
  similar: $<HTMLUListElement>('similar'),
  steps: $<HTMLTextAreaElement>('steps'),
  description: $<HTMLTextAreaElement>('description'),
  priority: $<HTMLSelectElement>('priority'),
  severity: $<HTMLSelectElement>('severity'),
  team: $<HTMLSelectElement>('team'),
  project: $<HTMLSelectElement>('project'),
  location: $<HTMLSelectElement>('location'),
  formError: $<HTMLParagraphElement>('form-error'),
  submit: $<HTMLButtonElement>('submit'),
  result: $<HTMLParagraphElement>('result'),
};

const state: {
  connection: ConnectionStatus | null;
  page: PageInfo | null;
  recorder: RecorderSnapshot | null;
  screenshot: string | null;
  element: PickedElement | null;
  stepsTouched: boolean;
  teams: Team[];
  projects: ProjectNode[];
  placements: PlacementNode[];
} = { connection: null, page: null, recorder: null, screenshot: null, element: null, stepsTouched: false, teams: [], projects: [], placements: [] };

const editor = new ScreenshotEditor(ui.canvas, () => ui.annotationText.value, () => {
  refreshHistoryButtons();
  void saveDraft();
});

function gql<Name extends OperationName>(name: Name, variables: Record<string, unknown> = {}): Promise<OperationData[Name]> {
  return ask<OperationData[Name]>({ type: 'graphql', name, variables });
}

function show(element: HTMLElement, text: string | null): void {
  element.hidden = !text;
  element.textContent = text ?? '';
}

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function refreshHistoryButtons(): void {
  ui.undo.disabled = !editor.model.canUndo;
  ui.redo.disabled = !editor.model.canRedo;
}

// ---- Draft: survives reopening the panel and "Open larger" ------------------

async function saveDraft(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [draftKey]: {
        screenshot: state.screenshot,
        page: state.page,
        recorder: state.recorder,
        element: state.element,
        annotations: editor.model.toJSON(),
        form: { title: ui.title.value, steps: ui.steps.value, description: ui.description.value, stepsTouched: state.stepsTouched },
      },
    });
  } catch {
    // A very large screenshot may not fit session storage; the panel itself keeps working.
  }
}

async function loadDraft(): Promise<boolean> {
  const stored = ((await chrome.storage.session.get(draftKey).catch(() => ({}))) as Record<string, unknown>)[draftKey] as
    | { screenshot: string | null; page: PageInfo | null; recorder: RecorderSnapshot | null; element: PickedElement | null; annotations: unknown; form: { title: string; steps: string; description: string; stepsTouched: boolean } }
    | undefined;
  if (!stored?.screenshot || !stored.page) return false;
  state.page = stored.page;
  state.recorder = stored.recorder;
  state.element = stored.element;
  ui.title.value = stored.form?.title ?? '';
  ui.steps.value = stored.form?.steps ?? '';
  ui.description.value = stored.form?.description ?? '';
  state.stepsTouched = Boolean(stored.form?.stepsTouched);
  await showScreenshot(stored.screenshot, stored.page);
  editor.setModel(AnnotationModel.fromJSON(stored.annotations as { history?: unknown; index?: unknown }));
  refreshHistoryButtons();
  describePicked();
  return true;
}

// ---- Screenshot -------------------------------------------------------------

async function showScreenshot(screenshot: string, page: PageInfo): Promise<void> {
  state.screenshot = screenshot;
  await editor.load(screenshot, page.viewport.dpr);
  show(ui.shotStatus, null);
}

async function applyCapture(result: CaptureResult): Promise<void> {
  state.page = result.page;
  state.recorder = result.recorder;
  await showScreenshot(result.screenshot, result.page);
  if (!state.stepsTouched) ui.steps.value = defaultSteps(result.page.url, state.element);
  await saveDraft();
}

async function retake(): Promise<void> {
  show(ui.shotStatus, 'Taking the screenshot…');
  show(ui.notice, null);
  try {
    await applyCapture(await ask<CaptureResult>({ type: 'capture.take', tabId }));
  } catch (error) {
    show(ui.shotStatus, editor.hasImage ? null : 'No screenshot.');
    show(ui.notice, (error as Error).message);
  }
}

// ---- Element picker ---------------------------------------------------------

function describePicked(): void {
  const element = state.element;
  show(ui.picked, element ? `Element: ${element.selector}${element.text ? ` — “${element.text.slice(0, 80)}”` : ''}` : null);
}

chrome.runtime.onMessage.addListener((message: PickerMessage, sender) => {
  if (sender.tab?.id !== tabId) return;
  if (message.type === 'picker.picked') {
    state.element = message.element;
    describePicked();
    if (!state.stepsTouched) ui.steps.value = defaultSteps(state.page?.url ?? null, state.element);
    // Retake so the box and the screenshot show the same moment, then draw the box.
    void retake().then(() => {
      editor.model.setElementBox(message.element.box);
      editor.draw();
      refreshHistoryButtons();
      void saveDraft();
    });
    ui.pick.disabled = false;
  } else if (message.type === 'picker.cancelled') {
    ui.pick.disabled = false;
    show(ui.notice, null);
  }
});

async function startPicker(): Promise<void> {
  try {
    ui.pick.disabled = true;
    await ask({ type: 'picker.start', tabId });
    show(ui.notice, 'Click the element on the page. Esc cancels.');
  } catch (error) {
    ui.pick.disabled = false;
    show(ui.notice, (error as Error).message);
  }
}

// ---- Where the bug goes -----------------------------------------------------

async function preselectProject(url: string): Promise<void> {
  const origin = normalizeOrigin(url);
  if (!origin || !state.connection?.connected) return;
  try {
    const { projectForOrigin } = await gql('ProjectForOrigin', { origin });
    if (!projectForOrigin) return;
    ui.team.value = projectForOrigin.team.id;
    await loadProjects(projectForOrigin.identifier);
  } catch {
    /* the person chooses by hand */
  }
}

async function loadTeams(): Promise<void> {
  const { teams } = await gql('Teams');
  state.teams = teams.nodes;
  ui.team.replaceChildren(option('', 'Choose a team…'), ...teams.nodes.map((team) => option(team.id, `${team.name} (${team.key})`)));
  if (teams.nodes.length === 1) ui.team.value = teams.nodes[0]!.id;
}

async function loadProjects(selectIdentifier: string | null = null): Promise<void> {
  const team = state.teams.find((candidate) => candidate.id === ui.team.value);
  state.projects = [];
  if (team) state.projects = (await gql('TeamProjects', { teamKey: team.key })).issues.nodes;
  ui.project.replaceChildren(
    option('', state.projects.length ? 'Choose a project…' : 'No project'),
    ...state.projects.map((project) => option(project.identifier, project.repository ? `${project.title} — ${project.repository}` : project.title)),
  );
  if (selectIdentifier && state.projects.some((project) => project.identifier === selectIdentifier)) ui.project.value = selectIdentifier;
  await loadPlacements();
}

async function loadPlacements(): Promise<void> {
  const project = state.projects.find((candidate) => candidate.identifier === ui.project.value);
  state.placements = [];
  if (project?.repository) {
    const data = await gql('PlacementOptions', { repository: project.repository });
    const open = (node: PlacementNode) => node.state?.type !== 'COMPLETED' && node.state?.type !== 'CANCELED';
    state.placements = [...data.milestones.nodes.filter(open), ...data.epics.nodes.filter(open)];
  }
  const options = [option(TRIAGE, 'Not sure — send to triage')];
  if (project) {
    options.unshift(
      option(project.identifier, 'No milestone'),
      ...state.placements.map((node) => option(node.identifier, `${node.kind === 'EPIC' ? 'Epic · ' : ''}${node.title}`)),
    );
  } else {
    options.unshift(option('', 'Choose a project, or send to triage'));
  }
  ui.location.replaceChildren(...options);
  ui.location.value = project ? project.identifier : '';
}

// ---- Similar bugs while typing ----------------------------------------------

let similarTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSimilar(): void {
  clearTimeout(similarTimer);
  similarTimer = setTimeout(() => void loadSimilar(), 300);
}

async function loadSimilar(): Promise<void> {
  const title = ui.title.value.trim();
  if (!ui.team.value || title.length < 3) {
    ui.similar.hidden = true;
    return;
  }
  try {
    const { similarBugs } = await gql('SimilarBugs', { teamId: ui.team.value, title });
    const server = state.connection?.server ?? '';
    ui.similar.replaceChildren(
      ...similarBugs.map((bug) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `${server}/issue/${bug.identifier}`;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = `${bug.identifier} ${bug.title}`;
        item.append(link, document.createTextNode(bug.state ? ` · ${bug.state.name}` : ''));
        return item;
      }),
    );
    ui.similar.hidden = similarBugs.length === 0;
  } catch {
    ui.similar.hidden = true;
  }
}

// ---- Submit -----------------------------------------------------------------

function readForm(): BugForm {
  const location: Location = ui.location.value === TRIAGE
    ? { kind: 'triage' }
    : ui.location.value
      ? { kind: 'parent', parentId: ui.location.value }
      : { kind: 'none' };
  return {
    teamId: ui.team.value || null,
    title: ui.title.value,
    stepsToReproduce: ui.steps.value,
    description: ui.description.value,
    priority: ui.priority.value ? Number(ui.priority.value) : null,
    severity: (ui.severity.value || null) as Severity | null,
    location,
  };
}

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  show(ui.formError, null);
  show(ui.result, null);
  const form = readForm();
  const errors = validateForm(form);
  const first = Object.values(errors)[0];
  if (first) {
    show(ui.formError, first);
    return;
  }
  ui.submit.disabled = true;
  ui.submit.textContent = 'Reporting…';
  try {
    let screenshotAttachmentId: string | null = null;
    const png = editor.exportPng();
    if (png) {
      const upload = (await gql('UploadScreenshot', { input: { filename: 'screenshot.png', mimeType: 'image/png', content: png } })).fileUpload;
      if (!upload.success || !upload.attachment) throw new Error(upload.message ?? 'The screenshot could not be uploaded.');
      screenshotAttachmentId = upload.attachment.id;
    }
    const capture = assembleCapture({ page: state.page, recorder: state.recorder, element: state.element, screenshotAttachmentId });
    const report = (await gql('ReportBug', { input: buildBugReportInput(form, capture) })).bugReport;
    if (!report.success || !report.issue) throw new Error(report.message ?? 'The bug could not be reported.');
    const link = document.createElement('a');
    link.href = `${state.connection?.server ?? ''}/issue/${report.issue.identifier}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = report.issue.identifier;
    ui.result.replaceChildren(document.createTextNode('Reported '), link, document.createTextNode(`: ${report.issue.title}`));
    ui.result.hidden = false;
    ui.form.hidden = true;
    await chrome.storage.session.remove(draftKey).catch(() => undefined);
  } catch (error) {
    show(ui.formError, (error as Error).message);
  } finally {
    ui.submit.disabled = false;
    ui.submit.textContent = 'Report bug';
  }
}

// ---- Wiring -----------------------------------------------------------------

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
  button.addEventListener('click', () => {
    editor.tool = button.dataset.tool as typeof editor.tool;
    for (const other of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) other.setAttribute('aria-pressed', String(other === button));
    ui.textTool.hidden = editor.tool !== 'text';
    if (editor.tool === 'text') ui.annotationText.focus();
  });
}
ui.undo.addEventListener('click', () => editor.undo());
ui.redo.addEventListener('click', () => editor.redo());
document.addEventListener('keydown', (event) => {
  const field = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (field || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
  event.preventDefault();
  if (event.shiftKey) editor.redo();
  else editor.undo();
});
ui.pick.addEventListener('click', () => void startPicker());
ui.retake.addEventListener('click', () => void retake());
ui.larger.addEventListener('click', () => {
  void saveDraft().then(() => chrome.tabs.create({ url: chrome.runtime.getURL(`sidepanel.html?tab=${tabId}&wide=1`) }));
});
ui.steps.addEventListener('input', () => {
  state.stepsTouched = true;
});
ui.title.addEventListener('input', scheduleSimilar);
for (const field of [ui.title, ui.steps, ui.description]) field.addEventListener('change', () => void saveDraft());
ui.team.addEventListener('change', () => void loadProjects().then(scheduleSimilar));
ui.project.addEventListener('change', () => void loadPlacements());
ui.form.addEventListener('submit', (event) => void submit(event));

async function init(): Promise<void> {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    show(ui.notice, 'Open Involute Capture from the toolbar button on the page you want to report.');
    show(ui.shotStatus, null);
    return;
  }
  if (params.get('wide') === '1') {
    ui.larger.hidden = true;
    document.body.classList.add('wide');
  }
  state.connection = await ask<ConnectionStatus>({ type: 'connection.get' });
  if (state.connection.connected) {
    ui.connection.textContent = state.connection.person?.name ?? state.connection.person?.email ?? 'Connected';
    await loadTeams().catch((error: Error) => show(ui.notice, error.message));
    await loadProjects().catch(() => undefined);
  } else {
    const link = document.createElement('a');
    link.href = chrome.runtime.getURL('options.html');
    link.target = '_blank';
    link.textContent = 'Connect to Involute';
    ui.connection.replaceChildren(link);
    show(ui.notice, 'Connect the extension to Involute in Options before reporting.');
  }

  // A capture the toolbar button or shortcut just started wins over an old draft:
  // it is what the person asked for. Without one, a draft (reopened panel,
  // "Open larger") comes back as it was; else a screenshot is taken now.
  let started: CaptureResult | null = null;
  let captureError: string | null = null;
  try {
    started = await ask<CaptureResult | null>({ type: 'capture.get', tabId });
  } catch (error) {
    captureError = (error as Error).message;
  }
  const restored = started || captureError ? false : await loadDraft();
  if (!restored) await chrome.storage.session.remove(draftKey).catch(() => undefined);

  // The tab's address (readable under activeTab) routes the report even if the screenshot fails.
  const tabUrl = started?.page.url ?? state.page?.url ?? (await chrome.tabs.get(tabId).catch(() => null))?.url ?? null;
  if (tabUrl) {
    if (!state.stepsTouched && !ui.steps.value) ui.steps.value = defaultSteps(tabUrl, state.element);
    await preselectProject(tabUrl);
  }
  if (restored) return;
  try {
    if (started) await applyCapture(started);
    else if (captureError) throw new Error(captureError);
    else await retake();
  } catch (error) {
    show(ui.shotStatus, 'No screenshot.');
    show(ui.notice, (error as Error).message);
  }
}

void init();
