/**
 * The results grid: a webview that renders one page at a time and asks the
 * extension for the next one, so a wide result set never blocks the UI thread.
 */
import * as vscode from 'vscode';
import { QueryPage } from './client';
import { toCsv } from './protocol';

export class ResultsPanel {
    /**
     * One panel per connection, not one in total.
     *
     * A single panel made every query replace the last, which is wrong exactly
     * when it matters: running the same statement against DEV and PROD to
     * compare them left one result and no way to see the other. Keyed by
     * connection, the two sit side by side as ordinary tabs, and each keeps its
     * own page and its own paging state.
     */
    private static readonly open = new Map<string, ResultsPanel>();
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private page?: QueryPage;
    private fetchPage?: (offset: number) => Promise<QueryPage>;

    static show(extensionUri: vscode.Uri, connection: string): ResultsPanel {
        const existing = ResultsPanel.open.get(connection);
        if (existing) {
            // preserveFocus: the editor keeps the cursor; results are to be read,
            // not typed into.
            existing.panel.reveal(existing.panel.viewColumn, true);
            return existing;
        }
        const panel = new ResultsPanel(extensionUri, connection);
        ResultsPanel.open.set(connection, panel);
        return panel;
    }

    private constructor(private readonly extensionUri: vscode.Uri, private readonly connection: string) {
        this.panel = vscode.window.createWebviewPanel(
            'fusionSql.results',
            `Results · ${connection}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
            },
        );
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message), null, this.disposables);
        this.panel.webview.html = this.html();
    }

    setStatus(text: string): void {
        void this.panel.webview.postMessage({ type: 'status', text });
    }

    setError(text: string): void {
        void this.panel.webview.postMessage({ type: 'error', text });
    }

    render(page: QueryPage, fetchPage: (offset: number) => Promise<QueryPage>): void {
        this.page = page;
        this.fetchPage = fetchPage;
        void this.panel.webview.postMessage({ type: 'rows', page });
    }

    private async onMessage(message: { type: string; offset?: number }): Promise<void> {
        if (message.type === 'page' && this.fetchPage && typeof message.offset === 'number') {
            try {
                this.setStatus('Fetching…');
                const page = await this.fetchPage(message.offset);
                this.page = page;
                void this.panel.webview.postMessage({ type: 'rows', page });
            } catch (error) {
                this.setError(error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (message.type === 'export' && this.page) {
            const target = await vscode.window.showSaveDialog({
                filters: { 'CSV': ['csv'] },
                saveLabel: 'Export',
                defaultUri: vscode.Uri.file(`${this.connection}.csv`),
            });
            if (!target) { return; }
            const csv = toCsv(this.page.columns, this.page.rows);
            await vscode.workspace.fs.writeFile(target, Buffer.from(csv, 'utf8'));
            void vscode.window.showInformationMessage(`Exported ${this.page.rows.length} rows.`);
        }
    }

    private html(): string {
        const webview = this.panel.webview;
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'grid.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'grid.css'));
        const nonce = Buffer.from(String(Math.random())).toString('base64').slice(0, 16);
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Fusion Results</title>
</head>
<body>
<div id="toolbar">
  <button id="prev" disabled>Previous</button>
  <button id="next" disabled>Next</button>
  <button id="export" disabled>Export CSV</button>
  <span id="status">Ready.</span>
</div>
<div id="grid"><table><thead></thead><tbody></tbody></table></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }

    private dispose(): void {
        ResultsPanel.open.delete(this.connection);
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}
