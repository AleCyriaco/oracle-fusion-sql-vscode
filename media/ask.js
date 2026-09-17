// The generate-query panel. Collects the request, shows the statement, and
// hands it back to the extension — it never talks to a provider itself.
(function () {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const request = $('request');
    const sql = $('sql');
    const status = $('status');
    const generate = $('generate');
    const insert = $('insert');
    const run = $('run');

    function setBusy(busy) {
        generate.disabled = busy;
        generate.textContent = busy ? 'Generating…' : 'Generate';
    }

    function showSql(text) {
        sql.value = text;
        sql.hidden = false;
        $('sqlLabel').hidden = false;
        $('followUp').hidden = false;
        insert.disabled = run.disabled = !text.trim();
        // Grow to the statement, within reason, so short queries don't sit in a
        // tall empty box and long ones don't need scrolling to read.
        sql.rows = Math.min(30, Math.max(8, text.split('\n').length + 1));
    }

    function show(kind, text) {
        status.hidden = false;
        status.className = kind;
        status.textContent = text;
    }

    generate.addEventListener('click', () => {
        if (!request.value.trim()) { request.focus(); return; }
        vscode.postMessage({ type: 'generate', request: request.value, current: sql.value });
    });
    insert.addEventListener('click', () => vscode.postMessage({ type: 'insert', current: sql.value }));
    run.addEventListener('click', () => vscode.postMessage({ type: 'run', current: sql.value }));

    // Enter sends from the request box; the SQL box keeps Enter for editing.
    request.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            generate.click();
        }
    });

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'provider') { $('provider').textContent = message.text; return; }
        if (message.type === 'seed') { showSql(message.sql); return; }
        if (message.type === 'busy') { setBusy(true); show('busy', 'Asking the model…'); return; }
        if (message.type === 'sql') {
            setBusy(false);
            status.hidden = true;
            showSql(message.sql);
            request.select();
            return;
        }
        if (message.type === 'error') {
            setBusy(false);
            show('error', message.text);
        }
    });

    request.focus();
}());
