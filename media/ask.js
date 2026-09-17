// The generate-query panel. Collects the request, shows the statement, and
// hands it back to the extension — it never talks to a provider itself.
(function () {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const request = $('request');
    const sql = $('sql');
    const status = $('status');
    const generate = $('generate');
    const verdict = $('verdict');
    const actions = ['copy', 'save', 'insert', 'run'].map($);

    function setBusy(busy) {
        generate.disabled = busy;
        generate.textContent = busy ? 'Generating…' : 'Generate';
    }

    function showSql(text) {
        sql.value = text;
        sql.hidden = false;
        $('sqlLabel').hidden = false;
        $('followUp').hidden = false;
        for (const button of actions) { button.disabled = !text.trim(); }
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
    for (const type of ['copy', 'save', 'insert', 'run']) {
        $(type).addEventListener('click', () => vscode.postMessage({ type, current: sql.value }));
    }

    function showVerdict(message) {
        if (message.validated === undefined && !message.note) { verdict.hidden = true; return; }
        verdict.hidden = false;
        verdict.className = message.validated === true ? 'ok'
            : message.validated === false ? 'failed' : 'skipped';
        verdict.textContent = message.validated === true ? `\u2713 ${message.note}`
            : message.validated === false ? `\u26a0 ${message.note} \u2014 run it anyway, or ask for a fix.`
            : message.note;
    }

    function describe(progress) {
        if (progress.kind === 'thinking') { return 'Asking the model\u2026'; }
        if (progress.kind === 'validating') {
            return progress.attempt === 1
                ? `Checking the statement against ${progress.connection}\u2026`
                : `Checking the corrected statement against ${progress.connection}\u2026`;
        }
        return `${progress.error}\n\nAsking the model to fix it (attempt ${progress.attempt} of ${progress.attempts})\u2026`;
    }

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
        if (message.type === 'busy') {
            setBusy(true);
            verdict.hidden = true;
            show('busy', 'Asking the model\u2026');
            return;
        }
        if (message.type === 'progress') { show('busy', describe(message.progress)); return; }
        if (message.type === 'sql') {
            setBusy(false);
            status.hidden = true;
            showSql(message.sql);
            showVerdict(message);
            request.select();
            return;
        }
        if (message.type === 'error') {
            setBusy(false);
            verdict.hidden = true;
            show('error', message.text);
        }
    });

    request.focus();
}());
