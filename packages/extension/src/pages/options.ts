import { DEFAULT_SERVER, normalizeOrigin, originPattern } from '../lib/connect';
import { ask } from '../lib/messages';
import { loadSettings, saveSettings, type ConnectionStatus } from '../lib/settings';

/**
 * Options (INV-1147): the Involute server, connecting and disconnecting, and
 * the managed origins where the context recorder runs. Host permissions are
 * asked for here, at the moment a person adds the server or an origin.
 */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  server: $<HTMLInputElement>('server'),
  connect: $<HTMLButtonElement>('connect'),
  disconnect: $<HTMLButtonElement>('disconnect'),
  status: $<HTMLParagraphElement>('status'),
  serverError: $<HTMLParagraphElement>('server-error'),
  origins: $<HTMLUListElement>('origins'),
  addOrigin: $<HTMLFormElement>('add-origin'),
  origin: $<HTMLInputElement>('origin'),
  originError: $<HTMLParagraphElement>('origin-error'),
};

function show(element: HTMLElement, text: string | null): void {
  element.hidden = !text;
  element.textContent = text ?? '';
}

async function render(): Promise<void> {
  const status = await ask<ConnectionStatus>({ type: 'connection.get' });
  if (document.activeElement !== ui.server) ui.server.value = status.server;
  if (status.connected && status.person) {
    const who = status.person.name ? `${status.person.name}${status.person.email ? ` (${status.person.email})` : ''}` : status.person.email ?? status.person.id;
    ui.status.textContent = `Connected to ${status.server} as ${who}. The connection expires ${new Date(status.expiresAt!).toLocaleDateString()}.`;
    ui.disconnect.hidden = false;
    ui.connect.textContent = 'Reconnect';
  } else {
    ui.status.textContent = `Not connected to ${status.server}.`;
    ui.disconnect.hidden = true;
    ui.connect.textContent = 'Connect';
  }
  ui.origins.replaceChildren(
    ...status.managedOrigins.map((origin) => {
      const item = document.createElement('li');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${origin}`);
      remove.addEventListener('click', () => void removeOrigin(origin));
      item.append(document.createTextNode(`${origin} `), remove);
      return item;
    }),
  );
}

async function connect(): Promise<void> {
  show(ui.serverError, null);
  const server = normalizeOrigin(ui.server.value || DEFAULT_SERVER);
  if (!server) {
    show(ui.serverError, 'Enter the address of your Involute, like https://involute.lumenopen.com.');
    return;
  }
  // Asked inside the click: Chrome only prompts during a user gesture.
  const granted = await chrome.permissions.request({ origins: [originPattern(server)] });
  if (!granted) {
    show(ui.serverError, `Involute Capture needs access to ${server} to file bugs there.`);
    return;
  }
  const settings = await loadSettings();
  // A token belongs to one server: changing the server drops the connection.
  await saveSettings({ server, ...(settings.server !== server ? { connection: null } : {}) });
  await chrome.tabs.create({ url: `${server}/extension/connect?extension=${chrome.runtime.id}` });
  await render();
}

async function disconnect(): Promise<void> {
  await ask({ type: 'connection.clear' });
  await render();
  ui.status.textContent += ' The token is no longer stored here. To revoke it, open Involute → Settings → Extensions (the token cannot revoke itself).';
}

async function addOrigin(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  show(ui.originError, null);
  const origin = normalizeOrigin(ui.origin.value);
  if (!origin) {
    show(ui.originError, 'Enter an http(s) origin, like https://app.example.com.');
    return;
  }
  const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
  if (!granted) {
    show(ui.originError, `Without access to ${origin} the recorder cannot run there.`);
    return;
  }
  const settings = await loadSettings();
  await saveSettings({ managedOrigins: [...new Set([...settings.managedOrigins, origin])] });
  await ask({ type: 'recorder.sync' });
  ui.origin.value = '';
  await render();
}

async function removeOrigin(origin: string): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({ managedOrigins: settings.managedOrigins.filter((entry) => entry !== origin) });
  // Keep access to the Involute server itself; give back everything else.
  if (origin !== settings.server) await chrome.permissions.remove({ origins: [originPattern(origin)] }).catch(() => false);
  await ask({ type: 'recorder.sync' });
  await render();
}

ui.connect.addEventListener('click', () => void connect());
ui.disconnect.addEventListener('click', () => void disconnect());
ui.addOrigin.addEventListener('submit', (event) => void addOrigin(event));
chrome.storage.onChanged.addListener(() => void render());
void render();
