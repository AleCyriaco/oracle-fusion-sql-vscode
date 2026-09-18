import * as vscode from 'vscode';
import { AuthProvider, BasicAuth, signInInteractive } from './auth';
import { ConnectionEditor, EditorResult } from './connectionEditor';
import { FusionClient, QueryPage } from './client';
import {
    ConnectionConfig, deleteConnection, findConnection, importFromJson, listConnections,
    passwordKey, resolveAuth, saveConnection, tokenKey, writeToken,
} from './connections';
import { ResultsPanel } from './resultsPanel';
import { isBlankStatement, splitStatements } from './protocol';
import { History, HistoryItem, HistoryProvider } from './history';
import { AskPanel, AskProgress, AskResult } from './askPanel';
import {
    DEFAULT_MODELS, LlmConfig, PROVIDER_KEY_URLS, PROVIDER_LABELS, ProviderId, firstOracleError,
    generateSql,
} from './llm';

const ACTIVE_KEY = 'fusionSql.activeConnection';

/**
 * Everything the extension does, in one place. Without it a command that
 * returns early is indistinguishable from one that was never invoked, which
 * is exactly the failure that is impossible to report usefully.
 */
let log: vscode.LogOutputChannel;
let history: History;

const AI_KEY = (provider: ProviderId) => `fusionSql.aiKey.${provider}`;

let tree: ConnectionsProvider;
/** Resolves the OAuth redirect that VS Code hands back through its URI handler. */
let pendingSignIn: { state: string; resolve: (params: URLSearchParams) => void; reject: (e: Error) => void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
    log = vscode.window.createOutputChannel('Oracle Fusion SQL', { log: true });
    context.subscriptions.push(log);
    log.info(`Activated ${context.extension.id}`);
    void refreshAiContext(context);

    tree = new ConnectionsProvider(context);
    history = new History(context);
    const historyTree = new HistoryProvider(history);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('fusionSql.connections', tree),
        vscode.window.registerTreeDataProvider('fusionSql.history', historyTree),
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
        command('fusionSql.generateQuery', () => generateQuery(context)),
        command('fusionSql.setAiKey', () => setAiKey(context)),
        command('fusionSql.selectAiProvider', () => selectAiProvider(context)),
        command('fusionSql.clearAiKey', () => clearAiKey(context)),
        command('fusionSql.openHistoryEntry', (item?: HistoryItem) => openHistoryEntry(item)),
        command('fusionSql.runHistoryEntry', (item?: HistoryItem) => runHistoryEntry(context, item)),
        command('fusionSql.copyHistoryEntry', (item?: HistoryItem) =>
            item ? vscode.env.clipboard.writeText(item.entry.sql) : undefined),
        command('fusionSql.deleteHistoryEntry', (item?: HistoryItem) =>
            item ? history.remove(item.entry.id) : undefined),
        command('fusionSql.clearHistory', () => clearHistory()),
    );

    context.subscriptions.push(runStatusBarItem());
}

export function deactivate(): void { /* nothing to clean up */ }

// O botão da title bar do editor é travado em 16px pelo VS Code; a barra de status
// não é, então o caminho para deixar "Run" evidente de verdade é duplicá-lo aqui.
function runStatusBarItem(): vscode.Disposable {
    const item = vscode.window.createStatusBarItem('fusionSql.run', vscode.StatusBarAlignment.Left, 100);
    item.name = 'Fusion SQL';
    item.text = '$(play) Run Query';
    item.tooltip = 'Run the statement at the cursor on the active Fusion connection';
    item.command = 'fusionSql.runQuery';
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    const sync = () => {
        if (vscode.window.activeTextEditor?.document.languageId === 'sql') { item.show(); } else { item.hide(); }
    };
    sync();
    return vscode.Disposable.from(
        item,
        vscode.window.onDidChangeActiveTextEditor(sync),
        // Trocar a linguagem do buffer reabre o documento, então isto cobre o
        // caso "abri um untitled e só depois marquei como SQL".
        vscode.workspace.onDidOpenTextDocument(sync),
    );
}


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
    ConnectionEditor.show(context.extensionUri, editorHost(context), context.secrets, connection,
        context.extension.id);
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
    ConnectionEditor.show(context.extensionUri, editorHost(context), context.secrets,
        { ...source, name }, context.extension.id);
}

function editorHost(context: vscode.ExtensionContext) {
    return {
        /** Test what is on screen, not what is saved — including an unsaved password. */
        async test(connection: ConnectionConfig, password?: string): Promise<string> {
            let auth = password && (connection.authMode ?? 'basic') === 'basic'
                ? new BasicAuth(connection.user ?? '', password)
                : await resolveAuth(connection, context.secrets);

            // Single sign-on cannot be tested without a session, and asking the
            // user to save, close the form and run a separate command first is
            // a detour. Sign in from here, with the values on screen.
            if (!auth && (connection.authMode ?? 'basic') === 'sso' && connection.oauth) {
                const token = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Signing in to ${connection.name}…` },
                    () => signInInteractive(connection.oauth!, context.extension.id, waitForCallback),
                );
                await writeToken(context.secrets, connection.name, token);
                tree.refresh();
                auth = await resolveAuth(connection, context.secrets);
            }
            if (!auth) {
                throw new Error((connection.authMode ?? 'basic') === 'sso'
                    ? 'Sign-in did not complete.'
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
    if (isBlankStatement(sql)) {
        // Sending comment-only text reaches the database and comes back as
        // ORA-00900, which tells the user nothing about what to do.
        throw new Error('That statement is only a comment — put the cursor on the query itself.');
    }
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
        await history.add({
            sql, connection: connection.name, rows: page.rows.length, elapsedMs: page.elapsedMs,
        });
        panel.render(page, fetchPage);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Failures are worth keeping too — a query that errored is the one you
        // come back to fix.
        await history.add({ sql, connection: connection.name, error: message });
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
    const statements = splitStatements(text);
    // Prefer a statement with something in it: the cursor often sits on the
    // comment above a query, or in the blank line after a semicolon.
    const hit = statements.find((s) => cursor >= s.start && cursor <= s.end
            && !isBlankStatement(text.slice(s.start, s.end)))
        ?? statements.find((s) => cursor >= s.start && cursor <= s.end)
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

// --- history -------------------------------------------------------------

async function openHistoryEntry(item?: HistoryItem): Promise<void> {
    if (!item) { return; }
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: item.entry.sql });
    await vscode.window.showTextDocument(document);
}

async function runHistoryEntry(context: vscode.ExtensionContext, item?: HistoryItem): Promise<void> {
    if (!item) { return; }
    await openHistoryEntry(item);
    await runQuery(context);
}

async function clearHistory(): Promise<void> {
    const count = history.list().length;
    if (count === 0) { return; }
    const confirm = await vscode.window.showWarningMessage(
        `Clear ${count} history entr${count === 1 ? 'y' : 'ies'}?`, { modal: true }, 'Clear',
    );
    if (confirm === 'Clear') { await history.clear(); }
}

// --- query generation ----------------------------------------------------

function aiProvider(): ProviderId {
    return vscode.workspace.getConfiguration('fusionSql')
        .get<ProviderId>('ai.provider') ?? 'anthropic';
}

async function aiConfig(context: vscode.ExtensionContext): Promise<LlmConfig> {
    const settings = vscode.workspace.getConfiguration('fusionSql');
    const provider = aiProvider();
    return {
        provider,
        apiKey: (await context.secrets.get(AI_KEY(provider))) ?? '',
        model: settings.get<string>('ai.model') ?? '',
        baseUrl: settings.get<string>('ai.baseUrl') ?? '',
        timeoutMs: (settings.get<number>('ai.timeoutSeconds') ?? 90) * 1000,
    };
}

/**
 * Drives the `fusionSql.hasAiKey` context key, which decides whether the views
 * offer to set an AI helper up or to use it. Without this the only way in is a
 * command nobody knows to look for.
 */
async function refreshAiContext(context: vscode.ExtensionContext): Promise<void> {
    let configured = false;
    for (const id of Object.keys(PROVIDER_LABELS) as ProviderId[]) {
        if (await context.secrets.get(AI_KEY(id))) { configured = true; break; }
    }
    await vscode.commands.executeCommand('setContext', 'fusionSql.hasAiKey', configured);
}

async function setAiKey(context: vscode.ExtensionContext): Promise<void> {
    const picked = await pickProvider('Add an AI helper — which provider?');
    if (!picked) { return; }

    if (picked === 'compatible') {
        const url = await vscode.window.showInputBox({
            title: 'Endpoint URL',
            value: vscode.workspace.getConfiguration('fusionSql').get<string>('ai.baseUrl') || '',
            ignoreFocusOut: true,
            placeHolder: 'https://host/v1',
            prompt: 'Base URL of an OpenAI-compatible API, e.g. http://localhost:11434/v1 for Ollama.',
        });
        if (!url) { return; }
        const model = await vscode.window.showInputBox({
            title: 'Model id',
            value: vscode.workspace.getConfiguration('fusionSql').get<string>('ai.model') || '',
            ignoreFocusOut: true,
            prompt: 'A compatible endpoint has no default — name the model it serves.',
        });
        if (!model) { return; }
        const settings = vscode.workspace.getConfiguration('fusionSql');
        await settings.update('ai.baseUrl', url.trim(), vscode.ConfigurationTarget.Global);
        await settings.update('ai.model', model.trim(), vscode.ConfigurationTarget.Global);
    }

    const where = PROVIDER_KEY_URLS[picked];
    const key = await vscode.window.showInputBox({
        title: `API key for ${PROVIDER_LABELS[picked]}`,
        password: true,
        ignoreFocusOut: true,
        prompt: `Stored in the OS keychain, never in settings.${where ? ` Get one at ${where}` : ''}`,
    });
    if (!key) { return; }

    await context.secrets.store(AI_KEY(picked), key.trim());
    // Adding a key for a provider means wanting to use it. Asking afterwards
    // only created a state where the key is stored and the provider is not,
    // which then fails with a message about a provider the user never chose.
    await vscode.workspace.getConfiguration('fusionSql')
        .update('ai.provider', picked, vscode.ConfigurationTarget.Global);
    await refreshAiContext(context);
    void vscode.window.showInformationMessage(`${PROVIDER_LABELS[picked]} is now the AI helper.`);
}

/** The provider list, in one place, so every entry point offers the same set. */
async function pickProvider(title: string): Promise<ProviderId | undefined> {
    const active = aiProvider();
    const picked = await vscode.window.showQuickPick(
        (Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => ({
            label: PROVIDER_LABELS[id],
            description: id === active ? '$(check) current' : DEFAULT_MODELS[id] || undefined,
            detail: id === 'compatible'
                ? 'Azure OpenAI, OpenRouter, Ollama, vLLM — you supply the URL and model'
                : undefined,
            id,
        })),
        { title, ignoreFocusOut: true },
    );
    return picked?.id;
}

async function selectAiProvider(context: vscode.ExtensionContext): Promise<void> {
    const picked = await pickProvider('Generate queries with which provider?');
    if (!picked) { return; }
    await vscode.workspace.getConfiguration('fusionSql')
        .update('ai.provider', picked, vscode.ConfigurationTarget.Global);
    if (!(await context.secrets.get(AI_KEY(picked)))) {
        const choice = await vscode.window.showWarningMessage(
            `No API key stored for ${PROVIDER_LABELS[picked]}.`, 'Add API Key',
        );
        if (choice === 'Add API Key') { await setAiKey(context); return; }
    }
    void vscode.window.showInformationMessage(`AI helper: ${PROVIDER_LABELS[picked]}.`);
}

async function clearAiKey(context: vscode.ExtensionContext): Promise<void> {
    for (const id of Object.keys(PROVIDER_LABELS) as ProviderId[]) {
        await context.secrets.delete(AI_KEY(id));
    }
    await refreshAiContext(context);
    void vscode.window.showInformationMessage('Stored AI API keys removed.');
}

async function generateQuery(context: vscode.ExtensionContext): Promise<void> {
    const config = await aiConfig(context);
    if (!config.apiKey) {
        const choice = await vscode.window.showWarningMessage(
            `No API key stored for ${PROVIDER_LABELS[config.provider]}.`,
            'Add API Key', 'Change Provider',
        );
        if (choice === 'Add API Key') { await setAiKey(context); }
        if (choice === 'Change Provider') { await selectAiProvider(context); }
        return;
    }
    if (config.provider === 'compatible' && !(config.baseUrl && config.model)) {
        const choice = await vscode.window.showWarningMessage(
            'The provider is set to "OpenAI-compatible endpoint", which needs a URL and a model '
            + 'of its own. Anthropic, OpenAI, xAI and DeepSeek are built in and need neither.',
            'Change Provider', 'Open Settings',
        );
        if (choice === 'Change Provider') { await selectAiProvider(context); }
        if (choice === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'fusionSql.ai');
        }
        return;
    }

    const editor = vscode.window.activeTextEditor;
    const seed = editor?.document.languageId === 'sql' ? statementAtCursor(editor).trim() : '';
    // Resolved up front so the panel can say which environment it checks against.
    const connection = listConnections().find(
        (c) => c.name === context.globalState.get<string>(ACTIVE_KEY)) ?? listConnections()[0];

    AskPanel.show(context.extensionUri, {
        describeProvider: () => {
            const model = config.model || DEFAULT_MODELS[config.provider];
            return `${PROVIDER_LABELS[config.provider]}${model ? ` · ${model}` : ''}`;
        },
        generate: async (request, current, report) => generateAndValidate(
            context, connection, request, current, report),

        insert: async (sql) => {
            const target = vscode.window.activeTextEditor;
            if (target && target.document.languageId === 'sql') {
                await target.edit((edit) => {
                    edit.replace(target.selection.isEmpty
                        ? new vscode.Range(target.document.positionAt(0),
                            target.document.positionAt(target.document.getText().length))
                        : target.selection, sql);
                });
                await vscode.window.showTextDocument(target.document, target.viewColumn);
                return;
            }
            const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
            await vscode.window.showTextDocument(document);
        },
        run: async (sql) => {
            const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
            await vscode.window.showTextDocument(document);
            await runQuery(context);
        },
        copy: async (sql) => {
            await vscode.env.clipboard.writeText(sql);
            void vscode.window.showInformationMessage('Statement copied.');
        },
        save: async (sql) => {
            const target = await vscode.window.showSaveDialog({
                filters: { 'SQL': ['sql'] },
                saveLabel: 'Save',
                defaultUri: vscode.Uri.file('query.sql'),
            });
            if (!target) { return; }
            await vscode.workspace.fs.writeFile(target, Buffer.from(`${sql}\n`, 'utf8'));
            void vscode.window.showInformationMessage(`Saved ${target.path.split('/').pop()}.`);
        },
    }, seed || undefined);
}

/** How many times a rejected statement is sent back to be fixed. */
const REPAIR_ATTEMPTS = 3;

/**
 * Generate a statement and prove it runs before handing it over.
 *
 * A model writing SQL for a schema it cannot see will occasionally invent a
 * table or a column, and the result looks perfectly plausible until it is run.
 * Executing a single-row page settles it: Oracle resolves every identifier, and
 * when it objects it names the offending one — which is exactly what the model
 * needs to fix it. Cheaper than making the user discover the mistake.
 */
async function generateAndValidate(
    context: vscode.ExtensionContext,
    connection: ConnectionConfig | undefined,
    request: string,
    current: string | undefined,
    report: (progress: AskProgress) => void,
): Promise<AskResult> {
    const validate = vscode.workspace.getConfiguration('fusionSql').get<boolean>('ai.validate') ?? true;

    report({ kind: 'thinking' });
    const config = await aiConfig(context);
    log.info(`> generate (${config.provider}): ${request.slice(0, 120)}`);
    let sql = await generateSql(config, { request, current });

    if (!validate) { return { sql }; }
    if (!connection) {
        return { sql, note: 'Not checked — no connection is configured.' };
    }
    const client = await buildClient(context, connection);
    if (!client) {
        return { sql, note: `Not checked — no credentials for ${connection.name}.` };
    }

    let lastError = '';
    for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
        report({ kind: 'validating', connection: connection.name, attempt, attempts: REPAIR_ATTEMPTS });
        try {
            const page = await client.query(sql, 0, 1);
            log.info(`< generate: validated on ${connection.name}, ${page.columns.length} column(s)`);
            return {
                sql,
                validated: true,
                note: `Runs on ${connection.name} · ${page.columns.length} column(s)`
                    + (page.rows.length === 0 ? ' · no rows matched' : ''),
            };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            log.warn(`validation failed (attempt ${attempt}): ${lastError.split('\n')[0]}`);
            if (attempt === REPAIR_ATTEMPTS) { break; }
            report({ kind: 'repairing', error: firstOracleError(lastError), attempt: attempt + 1, attempts: REPAIR_ATTEMPTS });
            sql = await generateSql(config, { request, current: sql, databaseError: lastError });
        }
    }

    // Hand it over anyway: a statement that failed to validate is still a
    // starting point, and the user may know something the model does not.
    return { sql, validated: false, note: `Did not run on ${connection.name}: ${firstOracleError(lastError)}` };
}
