/**
 * The connection form.
 *
 * Replaces a chain of input boxes with one panel where everything is visible at
 * once, can be corrected in any order, and can be tested before it is saved —
 * which matters because a wrong host or password is only discovered by trying.
 */
import * as vscode from 'vscode';
import { ConnectionConfig, findConnection, passwordKey } from './connections';
import { idcsEndpoints } from './auth';

/** What the form sends back. The password is absent when it was left untouched. */
export type EditorResult = {
    connection: ConnectionConfig;
    password?: string;
    previousName?: string;
};

export type EditorHost = {
    /** Run a connection test against unsaved values; returns a message to show. */
    test(connection: ConnectionConfig, password?: string): Promise<string>;
    save(result: EditorResult): Promise<void>;
};

export class ConnectionEditor {
    private static readonly panels = new Map<string, ConnectionEditor>();
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    /** @param existing the connection being edited, or undefined to create one. */
    static show(
        extensionUri: vscode.Uri,
        host: EditorHost,
        secrets: vscode.SecretStorage,
        existing?: ConnectionConfig,
    ): void {
        const key = existing?.name ?? '\0new';
        const open = ConnectionEditor.panels.get(key);
        if (open) { open.panel.reveal(); return; }
        ConnectionEditor.panels.set(key, new ConnectionEditor(extensionUri, host, secrets, existing, key));
    }

    private constructor(
        extensionUri: vscode.Uri,
        private readonly host: EditorHost,
        private readonly secrets: vscode.SecretStorage,
        private readonly existing: ConnectionConfig | undefined,
        private readonly key: string,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'fusionSql.connectionEditor',
            existing ? `Fusion: ${existing.name}` : 'Fusion: New Connection',
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
        void this.sendInitialValues();
    }

    private async sendInitialValues(): Promise<void> {
        // The stored password is never sent to the webview; the form only needs
        // to know whether one exists so it can show "leave blank to keep".
        const hasPassword = this.existing
            ? (await this.secrets.get(passwordKey(this.existing.name))) !== undefined
            : false;
        void this.panel.webview.postMessage({
            type: 'init',
            connection: this.existing ?? { name: '', url: '', authMode: 'basic' },
            isNew: !this.existing,
            hasPassword,
        });
    }

    private async onMessage(message: FormMessage): Promise<void> {
        if (message.type === 'cancel') { this.panel.dispose(); return; }

        const built = this.build(message);
        if (typeof built === 'string') {
            void this.panel.webview.postMessage({ type: 'result', ok: false, text: built });
            return;
        }

        if (message.type === 'test') {
            void this.panel.webview.postMessage({ type: 'busy', text: 'Testing…' });
            try {
                const text = await this.host.test(built, message.password || undefined);
                void this.panel.webview.postMessage({ type: 'result', ok: true, text });
            } catch (error) {
                void this.panel.webview.postMessage({
                    type: 'result', ok: false,
                    text: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (message.type === 'save') {
            try {
                await this.host.save({
                    connection: built,
                    password: message.password || undefined,
                    previousName: this.existing?.name,
                });
                this.panel.dispose();
            } catch (error) {
                void this.panel.webview.postMessage({
                    type: 'result', ok: false,
                    text: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    /** Validate the form and turn it into a connection, or return the problem. */
    private build(message: FormMessage): ConnectionConfig | string {
        const name = (message.name ?? '').trim();
        const url = (message.url ?? '').trim();
        if (!name) { return 'Give the connection a name.'; }
        if (!url) { return 'Enter the Fusion host.'; }

        const clashes = findConnection(name);
        if (clashes && name !== this.existing?.name) {
            return `A connection named "${name}" already exists.`;
        }

        const connection: ConnectionConfig = { name, url, authMode: message.authMode };
        const reportPath = (message.reportPath ?? '').trim();
        if (reportPath) { connection.reportPath = reportPath; }

        if (message.authMode === 'basic') {
            const user = (message.user ?? '').trim();
            if (!user) { return 'Enter the Fusion username.'; }
            connection.user = user;
            return connection;
        }

        const clientId = (message.clientId ?? '').trim();
        const idcsHost = (message.idcsHost ?? '').trim();
        if (!idcsHost) { return 'Enter the identity domain host.'; }
        if (!clientId) { return 'Enter the OAuth client ID.'; }
        if (!connection.reportPath) {
            return 'Single sign-on cannot deploy the proxy report, so a report path is required.';
        }
        connection.oauth = {
            ...idcsEndpoints(idcsHost),
            clientId,
            scope: (message.scope ?? '').trim() || 'openid offline_access',
        };
        return connection;
    }

    private dispose(): void {
        ConnectionEditor.panels.delete(this.key);
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}

type FormMessage = {
    type: 'save' | 'test' | 'cancel';
    name?: string;
    url?: string;
    authMode?: 'basic' | 'sso';
    user?: string;
    password?: string;
    reportPath?: string;
    idcsHost?: string;
    clientId?: string;
    scope?: string;
};

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'editor.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'editor.css'));
    const nonce = Buffer.from(String(Math.random())).toString('base64').slice(0, 16);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Fusion Connection</title>
</head>
<body>
<form id="form" autocomplete="off">
  <h1 id="title">New Connection</h1>

  <label for="name">Connection name</label>
  <input id="name" type="text" placeholder="e.g. FUSION-DEV" spellcheck="false">

  <label for="url">Fusion host</label>
  <input id="url" type="text" placeholder="e.g. pod.fa.us2.oraclecloud.com" spellcheck="false">
  <p class="hint">A full URL is fine too — the scheme and any path are stripped.</p>

  <label for="authMode">Authentication</label>
  <select id="authMode">
    <option value="basic">Username and password</option>
    <option value="sso">Single sign-on (OAuth 2.0)</option>
  </select>

  <div id="basicFields">
    <label for="user">Username</label>
    <input id="user" type="text" spellcheck="false">

    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="new-password">
    <p class="hint" id="passwordHint">Stored in the OS keychain, never in settings.</p>
  </div>

  <div id="ssoFields" hidden>
    <label for="idcsHost">Identity domain host</label>
    <input id="idcsHost" type="text" placeholder="e.g. idcs-xxxx.identity.oraclecloud.com" spellcheck="false">
    <p class="hint">The authorize and token endpoints are derived from it.</p>

    <label for="clientId">OAuth client ID</label>
    <input id="clientId" type="text" spellcheck="false">

    <label for="scope">Scope</label>
    <input id="scope" type="text" placeholder="openid offline_access" spellcheck="false">

    <p class="warning">
      Single sign-on cannot deploy the proxy report, and cannot query at all on pods
      that only answer over SOAP: those services authenticate from credentials inside
      the request, which a bearer token cannot satisfy. Point <b>Report path</b> at a
      report that already exists.
    </p>
  </div>

  <label for="reportPath">Report path <span class="optional" id="reportOptional">(optional)</span></label>
  <input id="reportPath" type="text" placeholder="e.g. /Custom/FusionQuery/v1/csv.xdo" spellcheck="false">
  <p class="hint" id="reportHint">Leave blank to use — and deploy, if missing — a copy in your own My Folders.</p>

  <div id="status" hidden></div>

  <div id="actions">
    <button type="button" id="test" class="secondary">Test Connection</button>
    <span class="spacer"></span>
    <button type="button" id="cancel" class="secondary">Cancel</button>
    <button type="button" id="save" class="primary">Save</button>
  </div>
</form>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
