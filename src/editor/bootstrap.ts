import { mountEditor } from './editor.ts';

let dispose: (() => void) | undefined;
try { dispose = mountEditor(); }
catch (error) {
  const message = document.querySelector<HTMLElement>('#error')!;
  message.hidden = false;
  message.textContent = error instanceof Error ? error.message : 'The editor could not start.';
  document.querySelector('#status')!.textContent = 'Could not start';
}
if (import.meta.hot) import.meta.hot.dispose(() => dispose?.());
window.addEventListener('pagehide', () => dispose?.(), { once: true });
