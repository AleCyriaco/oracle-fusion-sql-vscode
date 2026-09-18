/**
 * The results grid: a webview that renders one page at a time and asks the
 * extension for the next one, so a wide result set never blocks the UI thread.
 */
import * as vscode from 'vscode';
import { QueryPage } from './client';
import { toCsv } from './protocol';

export class ResultsPanel {
    private static current: ResultsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private page?: QueryPage;
    private fetchPage?: (offset: number) => Promise<QueryPage>;

    static show(extensionUri: vscode.Uri): ResultsPanel {
        if (ResultsPanel.current) {
            ResultsPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
            return ResultsPanel.current;
        }
        ResultsPanel.current = new ResultsPanel(extensionUri);
        return ResultsPanel.current;
    }

    private constructor(private readonly extensionUri: vscode.Uri) {
        this.panel = vscode.window.createWebviewPanel(
            'fusionSql.results',
            'Fusion Results',
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

    /**
     * Name the environment in the tab. With a connection per editor, two
     * queries land in the same panel one after the other, and the rows alone do
     * not say which pod they came from.
     */
    setConnection(name: string): void {
        this.panel.title = `Results · ${name}`;
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
        ResultsPanel.current = undefined;
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}
