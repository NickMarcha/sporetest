/** Preview tuning travels with the URL; creature data stays in recipes. */
export function bindPreviewURL(signal: AbortSignal, mode: () => 'walk' | 'stand' | 'shape', tempo: number) {
  const ids = ['stand-strength', 'stand-shift', 'walk-around', 'gait-duty', 'gait-period', 'gait-lift', 'walk-body', 'walk-tail', 'walk-lean', 'walk-sway',
    'walk-transfer', 'walk-transfer-limit', 'walk-speed', 'walk-turn', 'walk-rate',
    'walk-targets', 'show-balance', 'show-performance', 'show-spine', 'wireframe'];
  const controls = ids.map(id => {
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) throw new Error(`Missing preview control ${id}`);
    const checkbox = input instanceof HTMLInputElement && input.type === 'checkbox';
    return { id, input, checkbox, defaultValue: checkbox ? (input.defaultChecked ? '1' : '0') : input.value };
  });
  const initial = new URL(location.href);
  let cycle = Number(controls.find(control => control.id === 'gait-period')!.defaultValue);
  let restoring = false, ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const around = () => (document.getElementById('walk-around') as HTMLInputElement).checked;

  function write() {
    if (!ready || restoring) return;
    const url = new URL(location.href);
    if (mode() === 'shape') url.searchParams.delete('mode');
    else url.searchParams.set('mode', mode());
    for (const control of controls) {
      let value = control.checkbox ? ((control.input as HTMLInputElement).checked ? '1' : '0') : control.input.value;
      // Store the inspection cycle duration so switching tempo keeps the same tuning.
      if (control.id === 'gait-period') value = String(cycle);
      if (value === control.defaultValue) url.searchParams.delete(control.id);
      else url.searchParams.set(control.id, value);
    }
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  }
  function schedule(event: Event) {
    if (restoring || !ready || !(event.target instanceof HTMLElement)) return;
    const target = event.target.closest('input, select, button');
    if (!target || (!ids.includes(target.id) && !['tool-walk', 'tool-stand', 'tool-shape', 'tool-ik', 'tool-leg', 'tool-arm', 'tool-tail', 'ik-preview', 'preview-pose', 'undo', 'redo', 'gait-reset', 'walk-straight'].includes(target.id))) return;
    if (target.id === 'gait-period' && target instanceof HTMLInputElement) cycle = Number((Number(target.value) * (around() ? tempo : 1)).toFixed(6));
    if (target.id === 'gait-reset') cycle = Number(controls.find(control => control.id === 'gait-period')!.defaultValue);
    clearTimeout(timer); timer = setTimeout(write, 200);
  }
  for (const event of ['input', 'change', 'click']) document.addEventListener(event, schedule, { signal });
  window.addEventListener('pagehide', write, { signal });
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  // Restore once the rig is ready, through the same handlers used by the controls.
  return function restore() {
    if (ready) return;
    restoring = true;
    const requested = initial.searchParams.get('mode');
    const button = document.getElementById(requested === 'walk' ? 'tool-walk' : requested === 'stand' ? 'tool-stand' : 'tool-shape');
    if (button instanceof HTMLButtonElement && !button.disabled && mode() !== requested && requested !== null) button.click();
    for (const { id, input, checkbox } of controls) {
      const value = initial.searchParams.get(id);
      if (value === null || value.trim() === '') continue;
      if (id === 'walk-around' && mode() !== 'walk') continue;
      if (checkbox && input instanceof HTMLInputElement) {
        if (value !== '0' && value !== '1') continue;
        input.checked = value === '1';
      } else if (input instanceof HTMLSelectElement) {
        if (!Array.from(input.options).some(option => option.value === value)) continue;
        input.value = value;
      } else {
        let number = Number(value);
        if (!Number.isFinite(number)) continue;
        if (id === 'gait-period') number /= around() ? tempo : 1;
        if (number < Number(input.min) || number > Number(input.max)) continue;
        input.value = String(number);
        if (id === 'gait-period') cycle = Number((Number(input.value) * (around() ? tempo : 1)).toFixed(6));
      }
      input.dispatchEvent(new Event(checkbox || input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    }
    restoring = false; ready = true;
    // Let the first gait report refresh displayed cycle and speed before writing.
    timer = setTimeout(write, 200);
  };
}
