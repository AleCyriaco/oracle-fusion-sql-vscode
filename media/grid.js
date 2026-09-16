// Runs inside the results webview. Receives pages from the extension and draws
// them; never touches the network itself.
(function () {
    const vscode = acquireVsCodeApi();
    const thead = document.querySelector('thead');
    const tbody = document.querySelector('tbody');
    const status = document.getElementById('status');
    const prev = document.getElementById('prev');
    const next = document.getElementById('next');
    const exportBtn = document.getElementById('export');

    let current = null;

    prev.addEventListener('click', () => {
        if (!current) { return; }
        vscode.postMessage({ type: 'page', offset: Math.max(0, current.offset - current.pageSize) });
    });
    next.addEventListener('click', () => {
        if (!current) { return; }
        vscode.postMessage({ type: 'page', offset: current.offset + current.pageSize });
    });
    exportBtn.addEventListener('click', () => vscode.postMessage({ type: 'export' }));

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'status') {
            status.textContent = message.text;
            status.classList.remove('error');
            return;
        }
        if (message.type === 'error') {
            status.textContent = message.text;
            status.classList.add('error');
            return;
        }
        if (message.type === 'rows') {
            current = message.page;
            draw(message.page);
        }
    });

    function draw(page) {
        status.classList.remove('error');
        thead.textContent = '';
        tbody.textContent = '';

        const headRow = document.createElement('tr');
        headRow.appendChild(cell('th', '#', 'rownum'));
        for (const column of page.columns) { headRow.appendChild(cell('th', column)); }
        thead.appendChild(headRow);

        // Build off-document: one insert beats a few hundred reflows.
        const fragment = document.createDocumentFragment();
        page.rows.forEach((row, index) => {
            const tr = document.createElement('tr');
            tr.appendChild(cell('td', String(page.offset + index + 1), 'rownum'));
            for (const column of page.columns) {
                const value = row[column];
                tr.appendChild(value === '' ? cell('td', '(null)', 'null') : cell('td', value));
            }
            fragment.appendChild(tr);
        });
        tbody.appendChild(fragment);

        const first = page.rows.length ? page.offset + 1 : 0;
        const last = page.offset + page.rows.length;
        status.textContent = `${first}–${last} · ${page.columns.length} columns · ${page.elapsedMs} ms`;
        prev.disabled = page.offset === 0;
        next.disabled = !page.hasMore;
        exportBtn.disabled = page.rows.length === 0;
    }

    function cell(tag, text, className) {
        const element = document.createElement(tag);
        element.textContent = text;          // never innerHTML: result data is not markup
        if (className) { element.className = className; }
        return element;
    }
}());
