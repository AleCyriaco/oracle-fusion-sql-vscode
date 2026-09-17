import * as vscode from 'vscode';
import { AuthProvider, BasicAuth, signInInteractive } from './auth';
import { ConnectionEditor, EditorResult } from './connectionEditor';
import { FusionClient, QueryPage } from './client';
import {
    ConnectionConfig, deleteConnection, findConnection, importFromJson, listConnections,
    passwordKey, resolveAuth, saveConnection, tokenKey, writeToken,
} from './connections';
import { ResultsPanel } from './resultsPanel';

const ACTIVE_KEY = 'fusionSql.activeConnection';

/**
 * Everything the extension does, in one place. Without it a command that
 * returns early is indistinguishable from one that was never invoked, which
 * is exactly the failure that is impossible to report usefully.
 */
let log: vscode.LogOutputChannel;

let tree: ConnectionsProvider;
/** Resolves the OAuth redirect that VS Code hands back through its URI handler. */
let pendingSignIn: { state: string; resolve: (params: URLSearchParams) => void; reject: (e: Error) => void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
    log = vscode.window.createOutputChannel('Oracle Fusion SQL', { log: true });
    context.subscriptions.push(log);
    log.info(`Activated ${context.extension.id}`);

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
        command('fusionSql.editConnection', (item?: ConnectionItem) => editConnection(context, item)),
        command('fusionSql.duplicateConnection', (item?: ConnectionItem) => duplicateConnection(context, item)),
        command('fusionSql.removeConnection', (item?: ConnectionItem) => removeConnection(context, item)),
        command('fusionSql.setActiveConnection', (item?: ConnectionItem) => setActive(context, item)),
        command('fusionSql.signIn', (item?: ConnectionItem) => signIn(context, item)),
        command('fusionSql.signOut', (item?: ConnectionItem) => signOut(context, item)),
        command('fusionSql.testConnection', (item?: ConnectionItem) => testConnection(context, item)),
        command('fusionSql.runQuery', () => runQuery(context)),
        command('fusionSql.newQuery', () => newQuery()),
        command('fusionSql.showLog', () => log.show()),
    );
}

export function deactivate(): void { /* nothing to clean up */ }

function command(id: string, handler: (...args: any[]) => unknown): vscode.Disposable {
    return vscode.commands.registerCommand(id, async (...args) => {
        log.info(`> ${id}`);
        try {
            await handler(...args);
            log.info(`< ${id}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error(`! ${id}: ${message}`);
            if (error instanceof Error && error.stack) { log.error(error.stack); }
            // Offer the log rather than making the user go looking for it.
            void vscode.window.showErrorMessage(message, 'Show Log').then((choice) => {
                if (choice === 'Show Log') { log.show(); }
            });
        }
    });
}

// --- connection management -------------------------------------------------

function addConnection(context: vscode.ExtensionContext): void {
    ConnectionEditor.show(context.extensionUri, editorHost(context), context.secrets);
}

async function editConnection(context: vscode.ExtensionContext, item?: ConnectionItem): Promise<void> {
    const connection = await pick(item);
    if (!connection) { return; }
    ConnectionEditor.show(context.extensionUri, editorHost(context), context.secrets, connection);
}

/**
 * Open the form pre-filled from an existing connection but under a free name,
 * which is how most environments get added: one pod differs from the next by a
 * word in the host.
 */
async function duplicateConnection(context: vscode.ExtensionContext, item?: ConnectionItem): Promise<void> {
    const source = await pick(item);
    if (!source) { return; }
    let name = `${source.name} copy`;
    for (let i = 2; findConnection(name); i++) { name = `${source.name} copy ${i}`; }
    ConnectionEditor.show(context.extensionUri, editorHost(context), context.secrets, { ...source, name });
}

function editorHost(context: vscode.ExtensionContext) {
    return {
        /** Test what is on screen, not what is saved — including an unsaved password. */
        async test(connection: ConnectionConfig, password?: string): Promise<string> {
            const auth = password && (connection.authMode ?? 'basic') === 'basic'
                ? new BasicAuth(connection.user ?? '', password)
                : await resolveAuth(connection, context.secrets);
            if (!auth) {
                throw new Error((connection.authMode ?? 'basic') === 'sso'
                    ? 'Save the connection and run "Sign In (SSO)" before testing it.'
                    : 'Enter a password to test the connection.');
            }
            const client = buildClientWith(context, connection, auth);
            const result = await client.testConnection();
            return result.message;
        },

        async save(result: EditorResult): Promise<void> {
            const { connection, previousName } = result;
            // A rename is a new settings entry, so carry the secrets across and
            // drop the old one rather than stranding both.
            if (previousName && previousName !== connection.name) {
                const oldPassword = await context.secrets.get(passwordKey(previousName));
                const oldToken = await context.secrets.get(tokenKey(previousName));
                if (oldPassword) { await context.secrets.store(passwordKey(connection.name), oldPassword); }
                if (oldToken) { await context.secrets.store(tokenKey(connection.name), oldToken); }
                await deleteConnection(previousName, context.secrets);
                if (context.globalState.get<string>(ACTIVE_KEY) === previousName) {
                    await context.globalState.update(ACTIVE_KEY, connection.name);
                }
            }
            if (result.password) {
                await context.secrets.store(passwordKey(connection.name), result.password);
            }
            await saveConnection(connection);
            tree.refresh();
            void vscode.window.showInformationMessage(`Saved connection "${connection.name}".`);
        },
    };
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
    await context.globalState.update(ACTIVE_KEY, connection.name);
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
        () => signInInteractive(connection.oauth!, context.extension.id, waitForCallback),
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
    return buildClientWith(context, connection, auth);
}

function buildClientWith(
    context: vscode.ExtensionContext, connection: ConnectionConfig, auth: AuthProvider,
): FusionClient {
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

/**
 * A scratch editor already set to SQL. An untitled file is created as plain
 * text, and with that language the Run button and the keybinding do not appear
 * at all — which looks like the extension is broken rather than like a setting
 * that needs changing.
 */
async function newQuery(): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
    await vscode.window.showTextDocument(document);
}

async function runQuery(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new Error('No editor is focused. Open a .sql file and put the cursor in it.');
    }
    log.info(`Editor: ${editor.document.uri.toString()} (language ${editor.document.languageId})`);
    if (editor.document.languageId !== 'sql') {
        // Offer the fix once rather than leaving the toolbar mysteriously empty.
        void vscode.window.showWarningMessage(
            `This editor is "${editor.document.languageId}", not SQL — the Run button and `
            + 'Ctrl/Cmd+Enter only appear on SQL files.',
            'Set Language to SQL',
        ).then(async (choice) => {
            if (choice === 'Set Language to SQL') {
                await vscode.languages.setTextDocumentLanguage(editor.document, 'sql');
            }
        });
    }

    const sql = statementAtCursor(editor);
    if (!sql.trim()) { throw new Error('No statement under the cursor.'); }
    log.info(`Statement: ${sql.trim().replace(/\s+/g, ' ').slice(0, 120)}`);

    const connection = await activeConnection(context);
    if (!connection) {
        log.warn('No connection chosen — nothing to run against.');
        return;
    }
    log.info(`Connection: ${connection.name} (${connection.url}, ${connection.authMode ?? 'basic'})`);

    const client = await buildClient(context, connection);
    if (!client) {
        void vscode.window.showWarningMessage(
            `No credentials for "${connection.name}" — the query was not run.`,
        );
        log.warn('buildClient returned no client (credentials missing or prompt cancelled).');
        return;
    }

    const pageSize = vscode.workspace.getConfiguration('fusionSql').get<number>('pageSize') ?? 200;
    const panel = ResultsPanel.show(context.extensionUri);
    panel.setStatus(`Running on ${connection.name}…`);

    const fetchPage = (offset: number): Promise<QueryPage> => client.query(sql, offset, pageSize);
    try {
        const page = await fetchPage(0);
        log.info(`${page.rows.length} row(s), ${page.columns.length} column(s), ${page.elapsedMs} ms`);
        panel.render(page, fetchPage);
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
    const name = context.globalState.get<string>(ACTIVE_KEY);
    const existing = name ? findConnection(name) : undefined;
    if (existing) { return existing; }

    const all = listConnections();
    if (all.length === 0) {
        const choice = await vscode.window.showInformationMessage(
            'No Fusion connections yet.', 'Add Connection', 'Import connections.json',
        );
        if (choice === 'Add Connection') { addConnection(context); }
        if (choice === 'Import connections.json') { await importConnections(); }
        return undefined;
    }
    // With a single environment there is nothing to choose, and prompting from
    // the command palette races with the palette closing: the quick pick can be
    // dismissed before it is seen, which reads as the command doing nothing.
    if (all.length === 1) {
        await context.globalState.update(ACTIVE_KEY, all[0].name);
        tree.refresh();
        log.info(`Using the only configured connection: ${all[0].name}`);
        return all[0];
    }
    const picked = await vscode.window.showQuickPick(
        all.map((c) => ({ label: c.name, description: c.url, connection: c })),
        { title: 'Run on which connection?', ignoreFocusOut: true },
    );
    if (!picked) {
        log.warn('Connection picker dismissed.');
        return undefined;
    }
    await context.globalState.update(ACTIVE_KEY, picked.connection.name);
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
    if (all.length === 1) { return all[0]; }
    const picked = await vscode.window.showQuickPick(
        all.map((c) => ({ label: c.name, description: c.url, connection: c })),
        { title: 'Select a connection', ignoreFocusOut: true },
    );
    return picked?.connection;
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
        const active = this.context.globalState.get<string>(ACTIVE_KEY);
        const items: ConnectionItem[] = [];
        for (const connection of listConnections()) {
            const signedIn = (connection.authMode ?? 'basic') !== 'sso'
                || (await this.context.secrets.get(tokenKey(connection.name))) !== undefined;
            items.push(new ConnectionItem(connection, connection.name === active, signedIn));
        }
        return items;
    }
}
