/**
 * The "ask for a query" panel: a prompt field, the generated SQL, and what to
 * do with it. A panel rather than an input box because getting a useful query
 * usually takes two or three passes, and each pass should see the last answer.
 */
import * as vscode from 'vscode';

/** What the panel reports while it works, so the wait is legible. */
export type AskProgress =
    | { kind: 'thinking' }
    | { kind: 'validating'; connection: string; attempt: number; attempts: number }
    | { kind: 'repairing'; error: string; attempt: number; attempts: number };

export type AskResult = {
    sql: string;
    /** Undefined when validation was skipped or no connection was available. */
    validated?: boolean;
    /** What to tell the user about the check: columns found, or why it failed. */
    note?: string;
};

export type AskHost = {
    generate(request: string, current: string | undefined,
             report: (progress: AskProgress) => void): Promise<AskResult>;
    insert(sql: string): Promise<void>;
    run(sql: string): Promise<void>;
    copy(sql: string): Promise<void>;
    save(sql: string): Promise<void>;
    describeProvider(): string;
};

export class AskPanel {
    private static current: AskPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private lastSql = '';

    static show(extensionUri: vscode.Uri, host: AskHost, seed?: string): void {
        if (AskPanel.current) {
            AskPanel.current.panel.reveal();
            AskPanel.current.setProvider();
            if (seed) { void AskPanel.current.panel.webview.postMessage({ type: 'seed', sql: seed }); }
            return;
        }
        AskPanel.current = new AskPanel(extensionUri, host, seed);
    }

    private constructor(extensionUri: vscode.Uri, private readonly host: AskHost, seed?: string) {
        this.panel = vscode.window.createWebviewPanel(
            'fusionSql.ask',
            'Fusion: Generate Query',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
            },
        );
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
        this.panel.webview.html = html(this.panel.webview, extensionUri);
        this.setProvider();
        if (seed) { void this.panel.webview.postMessage({ type: 'seed', sql: seed }); }
    }

    private setProvider(): void {
        void this.panel.webview.postMessage({ type: 'provider', text: this.host.describeProvider() });
    }

    private async onMessage(message: { type: string; request?: string; current?: string }): Promise<void> {
        if (message.type === 'generate') {
            const request = (message.request ?? '').trim();
            if (!request) { return; }
            void this.panel.webview.postMessage({ type: 'busy' });
            try {
                // The current statement is sent back so a follow-up reads as an
                // edit ("now group by supplier") rather than a fresh request.
                const result = await this.host.generate(
                    request,
                    message.current || this.lastSql || undefined,
                    (progress) => void this.panel.webview.postMessage({ type: 'progress', progress }),
                );
                this.lastSql = result.sql;
                void this.panel.webview.postMessage({ type: 'sql', ...result });
            } catch (error) {
                void this.panel.webview.postMessage({
                    type: 'error',
                    text: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }
        if (!message.current) { return; }
        if (message.type === 'insert') { await this.host.insert(message.current); }
        else if (message.type === 'run') { await this.host.run(message.current); }
        else if (message.type === 'copy') { await this.host.copy(message.current); }
        else if (message.type === 'save') { await this.host.save(message.current); }
    }

    private dispose(): void {
        AskPanel.current = undefined;
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'ask.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'ask.css'));
    const nonce = Buffer.from(String(Math.random())).toString('base64').slice(0, 16);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Generate Query</title>
</head>
<body>
<h1>Describe the query</h1>
<p class="hint" id="provider"></p>

<textarea id="request" rows="4" spellcheck="false"
  placeholder="e.g. unpaid supplier invoices over 10.000 due in the next 30 days, with supplier name"></textarea>

<div id="actions">
  <button type="button" id="generate" class="primary" title="Ask the model for a statement, then check it against the database"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1l1.6 3.9L13.5 6.5 9.6 8.1 8 12 6.4 8.1 2.5 6.5l3.9-1.6L8 1zm4.5 7.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z"/></svg><span>Generate</span></button>
  <span class="spacer"></span>
  <button type="button" id="copy" class="secondary" title="Copy the statement to the clipboard" disabled><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1h8v10h-1.6V2.6H5V1zM3 4h7.4v11H3V4zm1.6 1.6v7.8h4.2V5.6H4.6z"/></svg><span>Copy</span></button>
  <button type="button" id="save" class="secondary" title="Save the statement to a .sql file" disabled><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h9.2L14 4.8V14H2V2zm2 1.6V7h6V3.6H4zm4 5.2a2.2 2.2 0 100 4.4 2.2 2.2 0 000-4.4z"/></svg><span>Save…</span></button>
  <button type="button" id="insert" class="secondary" title="Put this statement into the active SQL editor" disabled><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v8.6l3-3 1 1.1-4.8 4.8L2.4 7.7l1-1.1 3 3V1h1.6zM2 13.4h12V15H2v-1.6z"/></svg><span>Insert</span></button>
  <button type="button" id="run" class="primary" title="Open the statement in a new editor and run it" disabled><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.2l9.5 5.8L4 13.8V2.2z"/></svg><span>Run</span></button>
</div>

<div id="status" hidden></div>
<div id="verdict" hidden></div>

<label for="sql" id="sqlLabel" hidden>Generated SQL — edit freely before running</label>
<textarea id="sql" rows="14" spellcheck="false" hidden></textarea>
<p class="hint" id="followUp" hidden>Ask for a change and it will be applied to the statement above.</p>

<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
