import * as vscode from 'vscode';
import { AuthProvider, idcsEndpoints, signInInteractive } from './auth';
import { FusionClient, QueryPage } from './client';
import {
    ConnectionConfig, deleteConnection, findConnection, importFromJson, listConnections,
    passwordKey, resolveAuth, saveConnection, tokenKey, writeToken,
} from './connections';
import { ResultsPanel } from './resultsPanel';

const EXTENSION_ID = 'alecyriaco.fusion-sql';
const ACTIVE_KEY = 'fusionSql.activeConnection';

let tree: ConnectionsProvider;
/** Resolves the OAuth redirect that VS Code hands back through its URI handler. */
let pendingSignIn: { state: string; resolve: (params: URLSearchParams) => void; reject: (e: Error) => void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
    tree = new ConnectionsProvider(context);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('fusionSql.connections', tree),
        vscode.window.registerUriHandler({ handleUri: onUri }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('fusionSql.connections')) { tree.refresh(); }
        }),
        command('fusionSql.refresh', () => tree.refresh()),
        command('fusionSql.addConnection', () => addConnection(context)),
        command('fusionSql.importConnections', () => importConnections()),
        command('fusionSql.editConnection', (item?: ConnectionItem) => editConnection(item)),
        command('fusionSql.removeConnection', (item?: ConnectionItem) => removeConnection(context, item)),
        command('fusionSql.setActiveConnection', (item?: ConnectionItem) => setActive(context, item)),
        command('fusionSql.signIn', (item?: ConnectionItem) => signIn(context, item)),
        command('fusionSql.signOut', (item?: ConnectionItem) => signOut(context, item)),
        command('fusionSql.testConnection', (item?: ConnectionItem) => testConnection(context, item)),
        command('fusionSql.runQuery', () => runQuery(context)),
    );
}

export function deactivate(): void { /* nothing to clean up */ }

function command(id: string, handler: (...args: any[]) => unknown): vscode.Disposable {
    return vscode.commands.registerCommand(id, async (...args) => {
        try {
            await handler(...args);
        } catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    });
}

// --- connection management -------------------------------------------------

async function addConnection(context: vscode.ExtensionContext): Promise<void> {
    const name = await ask('Connection name', 'e.g. FUSION-DEV');
    if (!name) { return; }
    if (findConnection(name)) { throw new Error(`A connection named "${name}" already exists.`); }

    const url = await ask('Fusion URL or hostname', 'e.g. pod.fa.us2.oraclecloud.com');
    if (!url) { return; }

    const mode = await vscode.window.showQuickPick(
        [
            { label: 'Username and password', detail: 'Can deploy the proxy report automatically.', value: 'basic' as const },
            { label: 'Single sign-on (OAuth 2.0)', detail: 'Browser sign-in. Needs a proxy report that already exists.', value: 'sso' as const },
        ],
        { title: 'How should this connection sign in?', ignoreFocusOut: true },
    );
    if (!mode) { return; }

    const connection: ConnectionConfig = { name, url, authMode: mode.value };

    if (mode.value === 'basic') {
        connection.user = await ask('Fusion username', 'e.g. FUSION_USER');
        if (!connection.user) { return; }
        const password = await vscode.window.showInputBox({
            title: 'Password', password: true, ignoreFocusOut: true,
            prompt: 'Stored in the OS keychain, never in settings.',
        });
        if (password) { await context.secrets.store(passwordKey(name), password); }
    } else {
        const idcsHost = await ask('Identity domain host (IDCS / OCI IAM)', 'e.g. idcs-xxxx.identity.oraclecloud.com');
        if (!idcsHost) { return; }
        const clientId = await ask('OAuth client ID', 'From the application registered in your identity domain');
        if (!clientId) { return; }
        connection.oauth = { ...idcsEndpoints(idcsHost), clientId, scope: 'openid offline_access' };
        connection.reportPath = await ask(
            'Proxy report path',
            'e.g. /Custom/FusionQuery/v1/csv.xdo — required for SSO',
        );
        if (!connection.reportPath) { return; }
    }

    await saveConnection(connection);
    tree.refresh();
    void vscode.window.showInformationMessage(
        `Connection "${name}" created.` +
        (mode.value === 'sso' ? ' Run "Sign In (SSO)" to authenticate.' : ''),
    );
}

async function importConnections(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
        title: 'Select connections.json',
        filters: { 'JSON': ['json'] },
        canSelectMany: false,
    });
    if (!picked?.length) { return; }
    const count = await importFromJson(picked[0]);
    tree.refresh();
    void vscode.window.showInformationMessage(
        count === 0 ? 'No connections found in that file.'
            : `Imported ${count} connection${count === 1 ? '' : 's'}. Passwords are asked on first use.`,
    );
}

async function editConnection(item?: ConnectionItem): Promise<void> {
    const connection = await pick(item);
    if (!connection) { return; }
    await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'fusionSql.connections' } });
}

async function removeConnection(context: vscode.ExtensionContext, item?: ConnectionItem): Promise<void> {
    const connection = await pick(item);
    if (!connection) { return; }
    const confirm = await vscode.window.showWarningMessage(
        `Remove connection "${connection.name}"?`, { modal: true }, 'Remove',
    );
    if (confirm !== 'Remove') { return; }
    await deleteConnection(connection.name, context.secrets);
    tree.refresh();
}

async function setActive(context: vscode.ExtensionContext, item?: ConnectionItem): Promise<void> {
    const connection = await pick(item);
    if (!connection) { return; }
    await context.workspaceState.update(ACTIVE_KEY, connection.name);
    tree.refresh();
    void vscode.window.showInformationMessage(`Active connection: ${connection.name}`);
}

// --- SSO -------------------------------------------------------------------

function onUri(uri: vscode.Uri): void {
    const params = new URLSearchParams(uri.query);
    const waiting = pendingSignIn;
    if (!waiting) { return; }
    // A callback whose state doesn't match ours isn't ours: ignore rather than fail.
    if (params.get('state') !== waiting.state) { return; }
    pendingSignIn = undefined;
    waiting.resolve(params);
}

async function signIn(context: vscode.ExtensionContext, item?: ConnectionItem): Promise<void> {
    const connection = await pick(item);
    if (!connection) { return; }
    if (!connection.oauth) {
        throw new Error(`Connection "${connection.name}" is not configured for SSO.`);
    }
    const token = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Signing in to ${connection.name}…` },
        () => signInInteractive(connection.oauth!, EXTENSION_ID, waitForCallback),
    );
    await writeToken(context.secrets, connection.name, token);
    tree.refresh();
    void vscode.window.showInformationMessage(`Signed in to ${connection.name}.`);
}

function waitForCallback(state: string): Promise<URLSearchParams> {
    return new Promise<URLSearchParams>((resolve, reject) => {
        pendingSignIn = { state, resolve, reject };
        setTimeout(() => {
            if (pendingSignIn?.state === state) {
                pendingSignIn = undefined;
                reject(new Error('Sign-in timed out after 5 minutes.'));
            }
        }, 5 * 60_000);
    });
}

async function signOut(context: vscode.ExtensionContext, item?: ConnectionItem): Promise<void> {
    const connection = await pick(item);
    if (!connection) { return; }
    await context.secrets.delete(tokenKey(connection.name));
    tree.refresh();
    void vscode.window.showInformationMessage(`Signed out of ${connection.name}.`);
}

// --- running SQL -----------------------------------------------------------

async function buildClient(
    context: vscode.ExtensionContext, connection: ConnectionConfig,
): Promise<FusionClient | undefined> {
    const auth: AuthProvider | undefined = await resolveAuth(connection, context.secrets);
    if (!auth) {
        if ((connection.authMode ?? 'basic') === 'sso') {
            const choice = await vscode.window.showWarningMessage(
                `No SSO session for "${connection.name}".`, 'Sign In',
            );
            if (choice === 'Sign In') { await signIn(context, undefined); }
        }
        return undefined;
    }
    const settings = vscode.workspace.getConfiguration('fusionSql');
    return new FusionClient({
        baseUrl: connection.url,
        auth,
        reportPath: connection.reportPath,
        timeoutMs: (settings.get<number>('timeoutSeconds') ?? 120) * 1000,
        template: () => loadTemplate(context),
    });
}

/** The bundled proxy template, read from the extension folder on demand. */
async function loadTemplate(context: vscode.ExtensionContext): Promise<Buffer> {
    const uri = vscode.Uri.joinPath(context.extensionUri, 'media', 'FusionQueryProxy.xdrz');
    try {
        return Buffer.from(await vscode.workspace.fs.readFile(uri));
    } catch {
        throw new Error(
            'The proxy report template is not bundled with this build, so it cannot be deployed ' +
            'automatically. Point "reportPath" at a report that already exists.',
        );
    }
}

async function runQuery(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { throw new Error('Open a .sql file first.'); }

    const sql = statementAtCursor(editor);
    if (!sql.trim()) { throw new Error('No statement under the cursor.'); }

    const connection = await activeConnection(context);
    if (!connection) { return; }
    const client = await buildClient(context, connection);
    if (!client) { return; }

    const pageSize = vscode.workspace.getConfiguration('fusionSql').get<number>('pageSize') ?? 200;
    const panel = ResultsPanel.show(context.extensionUri);
    panel.setStatus(`Running on ${connection.name}…`);

    const fetchPage = (offset: number): Promise<QueryPage> => client.query(sql, offset, pageSize);
    try {
        panel.render(await fetchPage(0), fetchPage);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        panel.setError(message);
        throw error;
    }
}

/**
 * The statement under the cursor: text between blank-line or semicolon
 * boundaries, or the selection when there is one.
 */
export function statementAtCursor(editor: vscode.TextEditor): string {
    if (!editor.selection.isEmpty) { return editor.document.getText(editor.selection); }
    const text = editor.document.getText();
    const cursor = editor.document.offsetAt(editor.selection.active);
    const statements: { start: number; end: number }[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === ';') { statements.push({ start, end: i }); start = i + 1; }
    }
    statements.push({ start, end: text.length });
    const hit = statements.find((s) => cursor >= s.start && cursor <= s.end)
        ?? statements[statements.length - 1];
    return text.slice(hit.start, hit.end);
}

async function activeConnection(context: vscode.ExtensionContext): Promise<ConnectionConfig | undefined> {
    const name = context.workspaceState.get<string>(ACTIVE_KEY);
    const existing = name ? findConnection(name) : undefined;
    if (existing) { return existing; }

    const all = listConnections();
    if (all.length === 0) {
        const choice = await vscode.window.showInformationMessage(
            'No Fusion connections yet.', 'Add Connection', 'Import connections.json',
        );
        if (choice === 'Add Connection') { await addConnection(context); }
        if (choice === 'Import connections.json') { await importConnections(); }
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        all.map((c) => ({ label: c.name, description: c.url, connection: c })),
        { title: 'Run on which connection?' },
    );
    if (!picked) { return undefined; }
    await context.workspaceState.update(ACTIVE_KEY, picked.connection.name);
    tree.refresh();
    return picked.connection;
}

async function testConnection(context: vscode.ExtensionContext, item?: ConnectionItem): Promise<void> {
    const connection = await pick(item);
    if (!connection) { return; }
    const client = await buildClient(context, connection);
    if (!client) { return; }
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Testing ${connection.name}…` },
        () => client.testConnection(),
    );
    void vscode.window.showInformationMessage(result.message);
}

// --- tree view -------------------------------------------------------------

async function pick(item?: ConnectionItem): Promise<ConnectionConfig | undefined> {
    if (item?.connection) { return item.connection; }
    const all = listConnections();
    if (all.length === 0) { throw new Error('No connections configured.'); }
    const picked = await vscode.window.showQuickPick(
        all.map((c) => ({ label: c.name, description: c.url, connection: c })),
        { title: 'Select a connection' },
    );
    return picked?.connection;
}

async function ask(title: string, prompt: string): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({ title, prompt, ignoreFocusOut: true });
    return value?.trim() || undefined;
}

class ConnectionItem extends vscode.TreeItem {
    constructor(readonly connection: ConnectionConfig, active: boolean, signedIn: boolean) {
        super(connection.name, vscode.TreeItemCollapsibleState.None);
        const sso = (connection.authMode ?? 'basic') === 'sso';
        this.description = sso
            ? `${hostOf(connection.url)} · SSO${signedIn ? '' : ' (signed out)'}`
            : `${hostOf(connection.url)} · ${connection.user ?? 'no user'}`;
        this.tooltip = new vscode.MarkdownString(
            `**${connection.name}**\n\n${connection.url}\n\n` +
            `Auth: ${sso ? 'single sign-on' : 'username/password'}\n\n` +
            `Report: ${connection.reportPath ?? '(personal My Folders)'}`,
        );
        this.contextValue = sso ? 'connection.sso' : 'connection.basic';
        this.iconPath = new vscode.ThemeIcon(
            active ? 'circle-filled' : sso && !signedIn ? 'circle-slash' : 'circle-outline',
        );
        this.command = {
            command: 'fusionSql.setActiveConnection',
            title: 'Set as Active Connection',
            arguments: [this],
        };
    }
}

function hostOf(url: string): string {
    return url.replace(/^https?:\/\//i, '').split('/')[0];
}

class ConnectionsProvider implements vscode.TreeDataProvider<ConnectionItem> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    refresh(): void { this.emitter.fire(); }

    getTreeItem(element: ConnectionItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<ConnectionItem[]> {
        const active = this.context.workspaceState.get<string>(ACTIVE_KEY);
        const items: ConnectionItem[] = [];
        for (const connection of listConnections()) {
            const signedIn = (connection.authMode ?? 'basic') !== 'sso'
                || (await this.context.secrets.get(tokenKey(connection.name))) !== undefined;
            items.push(new ConnectionItem(connection, connection.name === active, signedIn));
        }
        return items;
    }
}
