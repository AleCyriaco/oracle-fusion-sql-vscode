// The connection form. Holds no state of its own beyond the fields: the
// extension owns validation and persistence, this only collects and displays.
(function () {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const fields = ['name', 'url', 'authMode', 'user', 'password', 'reportPath', 'idcsHost', 'clientId', 'scope'];
    const status = $('status');
    const buttons = [$('test'), $('save'), $('cancel'), $('detect')];

    function values() {
        const out = { };
        for (const id of fields) { out[id] = $(id).value; }
        return out;
    }

    function applyMode() {
        const sso = $('authMode').value === 'sso';
        $('basicFields').hidden = sso;
        $('ssoFields').hidden = !sso;
        // With SSO the report path is not optional — the extension cannot deploy one.
        $('reportOptional').textContent = sso ? '(required)' : '(optional)';
        $('reportHint').textContent = sso
            ? 'Single sign-on cannot deploy a report, so this must already exist.'
            : 'Leave blank to use — and deploy, if missing — a copy in your own My Folders.';
    }

    function show(kind, text) {
        status.hidden = false;
        status.className = kind;
        status.textContent = text;
    }

    function setBusy(busy) {
        for (const button of buttons) { button.disabled = busy; }
    }

    $('detect').addEventListener('click', () => {
        setBusy(true);
        vscode.postMessage({ type: 'detect', url: $('url').value });
    });

    $('authMode').addEventListener('change', () => {
        applyMode();
        // Switching to single sign-on with a host already typed: fill the
        // domain in rather than making the user go and look it up.
        if ($('authMode').value === 'sso' && $('url').value.trim() && !$('idcsHost').value.trim()) {
            $('detect').click();
        }
    });
    $('test').addEventListener('click', () => { setBusy(true); vscode.postMessage({ type: 'test', ...values() }); });
    $('save').addEventListener('click', () => { setBusy(true); vscode.postMessage({ type: 'save', ...values() }); });
    $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

    // Enter saves, except in a field where the user may still be typing a list.
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            $('save').click();
        }
        if (event.key === 'Escape') { vscode.postMessage({ type: 'cancel' }); }
    });

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'init') {
            const c = message.connection;
            $('title').textContent = message.isNew ? 'New Connection' : 'Edit Connection';
            $('name').value = c.name || '';
            $('url').value = c.url || '';
            $('authMode').value = c.authMode || 'basic';
            $('user').value = c.user || '';
            $('reportPath').value = c.reportPath || '';
            $('idcsHost').value = (c.oauth && c.oauth.authorizeUrl)
                ? c.oauth.authorizeUrl.replace(/^https?:\/\//, '').split('/')[0] : '';
            $('clientId').value = (c.oauth && c.oauth.clientId) || '';
            $('scope').value = (c.oauth && c.oauth.scope) || '';
            if (message.redirectUri) { $('redirect').textContent = message.redirectUri; }
            if (message.hasPassword) {
                $('password').placeholder = '••••••••  (leave blank to keep)';
                $('passwordHint').textContent = 'A password is already stored. Leave blank to keep it.';
            }
            applyMode();
            $('name').focus();
            return;
        }
        if (message.type === 'busy') { show('busy', message.text); return; }
        if (message.type === 'detected') {
            setBusy(false);
            $('idcsHost').value = message.idcsHost;
            show('ok', `Identity domain: ${message.idcsHost}`);
            $('clientId').focus();
            return;
        }
        if (message.type === 'result') {
            setBusy(false);
            show(message.ok ? 'ok' : 'error', message.text);
        }
    });
}());
