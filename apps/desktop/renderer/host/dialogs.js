import { getLanguage } from '../i18n.js';

export async function installDialogs({ listen, invoke, document = window.document }) {
    const copy = await (await fetch(new URL('./dialog-copy.json', import.meta.url))).json();
    const queue = [];
    let active, disposed = false;
    function showNext() {
        if (active || disposed || !queue.length) return;
        const request = queue.shift();
        const config = copy[request.kind];
        if (!config) {
            void invoke('desktop_dialog_reply', { id: request.id, button: null, remember: false });
            showNext();
            return;
        }
        const english = getLanguage() === 'en';
        const [title, message, labels] = config[english ? 'en' : 'zh'];
        const previousFocus = document.activeElement;
        const dialog = document.createElement('dialog');
        dialog.className = 'modal desktop-dialog';
        dialog.dataset.kind = request.kind;
        dialog.setAttribute('aria-labelledby', 'desktop-dialog-title');
        dialog.setAttribute('aria-describedby', 'desktop-dialog-description');
        dialog.innerHTML = `<header class="desktop-dialog-header"><span class="desktop-dialog-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg></span><h2 id="desktop-dialog-title"></h2><button type="button" class="icon-btn desktop-dialog-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><p id="desktop-dialog-description" class="modal-desc"></p><label class="desktop-dialog-remember"><input type="checkbox"><span></span></label><footer class="modal-actions"></footer>`;
        dialog.querySelector('h2').textContent = title;
        const detail = String(request.version ?? '');
        dialog.querySelector('.modal-desc').textContent = message.replaceAll('{version}', detail).replaceAll('{detail}', detail);
        const close = dialog.querySelector('.desktop-dialog-close');
        close.setAttribute('aria-label', english ? 'Close dialog' : '关闭对话框');
        const remember = dialog.querySelector('input');
        dialog.querySelector('.desktop-dialog-remember').hidden = request.kind !== 'close';
        dialog.querySelector('.desktop-dialog-remember span').textContent = english ? 'Remember my choice' : '记住我的选择';
        let completed = false;
        function finish(button = null) {
            if (completed) return;
            completed = true;
            const checked = request.kind === 'close' && button !== null && button !== 0 && remember.checked;
            dialog.close();
            dialog.remove();
            active = null;
            if (previousFocus?.isConnected) previousFocus.focus();
            void invoke('desktop_dialog_reply', { id: request.id, button, remember: checked }).catch(console.error);
            showNext();
        }
        close.addEventListener('click', () => finish());
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
        // Existing page dialogs also handle Escape/Tab; keep their state intact underneath this dialog.
        dialog.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key !== 'Tab') return;
            const focusable = [...dialog.querySelectorAll('button, input')].filter(element => element.getClientRects().length);
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });
        dialog.addEventListener('click', event => {
            const rect = dialog.getBoundingClientRect();
            if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) finish();
        });
        const buttons = labels.map((label, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `btn${config.primary === index ? ' primary' : config.danger === index ? ' danger' : ''}`;
            button.textContent = label;
            button.addEventListener('click', () => finish(index));
            dialog.querySelector('footer').append(button);
            return button;
        });
        active = dialog;
        document.body.append(dialog);
        dialog.showModal();
        buttons[config.default].focus();
    }
    const unlisten = await listen('desktop:dialog', ({ payload }) => { queue.push(payload); showNext(); });
    return () => {
        disposed = true;
        unlisten();
        queue.length = 0;
        active?.remove();
    };
}
