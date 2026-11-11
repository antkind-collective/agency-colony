/* ── Your Agency modals: Promise-based replacements for native prompt/alert ──
   Classic script — loaded after js/utils.js (uses escapeHtml), before app.js.
   Built on <dialog> for focus-trapping + Esc handling, but resolution is
   driven by explicit button handlers and the `cancel` event rather than the
   `close` event — the `close` event proved unreliable for programmatic submits
   in some Chrome builds. The page's JS thread never blocks (unlike native
   prompt/alert, which freeze rendering and are invisible to automation).

   API (all return Promises):
     appAlert(message, { title })                        → void
     appConfirm(message, { title, confirmLabel,
                  cancelLabel, danger })                     → boolean
     appPrompt(message, { title, type, placeholder,
                             okLabel })                      → string | null
     appChoice(message, { title, choices: [{ label,
                  value, variant }], cancelLabel })          → value | null
   Cancel / Esc / backdrop-click resolve to null (false for confirm,
   undefined for alert). */

/* ── Outside clicks: one rule for every panel, dialog and popover ──
   A browser fires `click` on whatever is under the pointer at RELEASE. So
   selecting text inside a panel and letting go outside it looks like an
   outside click, and the panel closed mid-edit (deal panel, Oct 2026).
   Remember where each press began; a click only counts as outside when the
   press began outside too. Use these instead of a bare contains() check. */
let _pressTarget = null;
document.addEventListener('pointerdown', (e) => { _pressTarget = e.target; }, true);

// True when both the press and the release happened outside `el`, which is
// an element or a selector (outside every match).
function isOutsideClick(e, el) {
  const inside = (node) => node instanceof Element
    && (typeof el === 'string' ? !!node.closest(el) : !!el && el.contains(node));
  if (!el || inside(e.target)) return false;
  return !(_pressTarget && _pressTarget.isConnected && inside(_pressTarget));
}

// True when the press and the release both landed on `el` itself
// (a <dialog>'s backdrop, or a full-screen overlay).
function isBackdropClick(e, el) {
  return e.target === el && (!_pressTarget || _pressTarget === el);
}

function _appModalOpen({ title, message, buildBody, resolveCancel }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'app-modal';
    const messageHtml = message ? escapeHtml(message).replaceAll('\n', '<br>') : '';
    dialog.innerHTML = `
      <div class="app-modal-form">
        ${title ? `<h3 class="app-modal-title">${escapeHtml(title)}</h3>` : ''}
        ${message ? `<p class="app-modal-message">${messageHtml}</p>` : ''}
        <div class="app-modal-body"></div>
        <div class="app-modal-actions"></div>
      </div>`;
    document.body.appendChild(dialog);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };

    const body = dialog.querySelector('.app-modal-body');
    const actions = dialog.querySelector('.app-modal-actions');
    buildBody({ dialog, body, actions, finish });

    // Esc key fires the dialog `cancel` event (reliable cross-browser).
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(resolveCancel()); });
    // Backdrop click = cancel.
    dialog.addEventListener('click', (e) => { if (isBackdropClick(e, dialog)) finish(resolveCancel()); });

    dialog.showModal();
  });
}

function appAlert(message, { title = '' } = {}) {
  return _appModalOpen({
    title, message,
    resolveCancel: () => undefined,
    buildBody: ({ actions, finish }) => {
      actions.innerHTML = '<button type="button" class="primary">OK</button>';
      actions.querySelector('button').addEventListener('click', () => finish(undefined));
    }
  });
}

function appConfirm(message, { title = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return _appModalOpen({
    title, message,
    resolveCancel: () => false,
    buildBody: ({ actions, finish }) => {
      actions.innerHTML = `
        <button type="button" class="ghost" data-cancel></button>
        <button type="button" class="${danger ? 'danger' : 'primary'}" data-ok></button>`;
      const okBtn = actions.querySelector('[data-ok]');
      const cancelBtn = actions.querySelector('[data-cancel]');
      okBtn.textContent = confirmLabel;
      cancelBtn.textContent = cancelLabel;
      okBtn.addEventListener('click', () => finish(true));
      cancelBtn.addEventListener('click', () => finish(false));
    }
  });
}

function appPrompt(message, { title = '', type = 'text', placeholder = '', okLabel = 'OK' } = {}) {
  return _appModalOpen({
    title, message,
    resolveCancel: () => null,
    buildBody: ({ body, actions, finish }) => {
      body.innerHTML = `<input class="app-modal-input"
        type="${type === 'password' ? 'password' : 'text'}"
        placeholder="${escapeHtml(placeholder)}" autocomplete="off">`;
      actions.innerHTML = `
        <button type="button" class="ghost" data-cancel>Cancel</button>
        <button type="button" class="primary" data-ok>${escapeHtml(okLabel)}</button>`;
      const input = body.querySelector('input');
      const submit = () => finish(input.value);
      actions.querySelector('[data-ok]').addEventListener('click', submit);
      actions.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      setTimeout(() => input.focus(), 0);
    }
  });
}

function appChoice(message, { title = '', choices = [], cancelLabel = 'Cancel' } = {}) {
  return _appModalOpen({
    title, message,
    resolveCancel: () => null,
    buildBody: ({ body, actions, finish }) => {
      body.innerHTML = '<div class="app-modal-choices"></div>';
      const list = body.querySelector('.app-modal-choices');
      choices.forEach((c) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = (c.variant === 'primary' ? 'primary' : 'ghost') + ' app-modal-choice';
        btn.textContent = c.label;
        btn.addEventListener('click', () => finish(c.value)); // closure keeps the real value (any type)
        list.appendChild(btn);
      });
      actions.innerHTML = `<button type="button" class="ghost" data-cancel></button>`;
      const cancelBtn = actions.querySelector('[data-cancel]');
      cancelBtn.textContent = cancelLabel;
      cancelBtn.addEventListener('click', () => finish(null));
    }
  });
}

// ── Failures people can see (29 Oct 2026) ───────────────────────────────────
// A click that fails must say so on screen, never only in the console: Kira's
// reimbursement "just didn't upload" with nothing to tell anyone why.
// tests/no-silent-actions.test.mjs keeps new buttons on these helpers.
function _failHelp() {
  return /^circle\./.test(location.hostname) ? 'let your Your Agency team know' : 'tell Alex';
}
// Something the code didn't expect (a dropped connection, a bug).
function actionFailed(e) {
  console.error(e);
  const why = e?.message || (typeof e === 'string' ? e : '') || 'unknown error';
  appAlert(`That didn't work (${why}). Try again; if it keeps happening, ${_failHelp()}.`, { title: 'Something went wrong' }).catch(() => {});
}
// The database refused or skipped a save: say what didn't happen.
function notSaved(what, error) {
  console.error(what, error);
  const why = error?.message ? ` (${error.message})` : '';
  return appAlert(`${what}${why}. Try again; if it keeps happening, ${_failHelp()}.`, { title: 'Not saved' }).catch(() => {});
}
