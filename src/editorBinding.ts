/**
 * Which connection a given editor runs against.
 *
 * One active connection for the whole window is wrong as soon as there are two
 * environments open: comparing a query between DEV and PROD means switching a
 * global setting back and forth and remembering which way it is pointing. A
 * binding per editor removes the remembering, and the status bar makes the
 * answer visible without asking for it.
 */
import * as vscode from 'vscode';
import { ConnectionConfig, findConnection, listConnections } from './connections';

const KEY = 'fusionSql.editorConnections';
/** Falls back to this when an editor has no binding of its own. */
const DEFAULT_KEY = 'fusionSql.activeConnection';

export class EditorBindings {
    private readonly status: vscode.StatusBarItem;

    constructor(private readonly context: vscode.ExtensionContext) {
        // Left of the language indicator, which is where a document-scoped
        // selector belongs; priority keeps it from jumping around.
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        this.status.command = 'fusionSql.setEditorConnection';
        context.subscriptions.push(this.status);
    }

    /** Explicit binding for a document, if it has one. */
    private bindings(): Record<string, string> {
        return this.context.globalState.get<Record<string, string>>(KEY) ?? {};
    }

    defaultName(): string | undefined {
        return this.context.globalState.get<string>(DEFAULT_KEY);
    }

    async setDefault(name: string): Promise<void> {
        await this.context.globalState.update(DEFAULT_KEY, name);
        this.refresh();
    }

    /**
     * The connection an editor should use: its own binding, else the window
     * default, else the only one configured.
     */
    resolve(document?: vscode.TextDocument): ConnectionConfig | undefined {
        const bound = document ? this.bindings()[document.uri.toString()] : undefined;
        const byBinding = bound ? findConnection(bound) : undefined;
        if (byBinding) { return byBinding; }

        const fallback = this.defaultName();
        const byDefault = fallback ? findConnection(fallback) : undefined;
        if (byDefault) { return byDefault; }

        const all = listConnections();
        return all.length === 1 ? all[0] : undefined;
    }

    /** True when this editor was pointed somewhere on purpose. */
    isBound(document: vscode.TextDocument): boolean {
        const bound = this.bindings()[document.uri.toString()];
        return bound !== undefined && findConnection(bound) !== undefined;
    }

    async bind(document: vscode.TextDocument, name: string | undefined): Promise<void> {
        const all = { ...this.bindings() };
        const key = document.uri.toString();
        if (name) { all[key] = name; } else { delete all[key]; }
        await this.context.globalState.update(KEY, all);
        this.refresh();
    }

    /** Drop bindings for documents that are gone, so the map cannot grow forever. */
    async prune(): Promise<void> {
        const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
        const all = this.bindings();
        const kept = Object.fromEntries(Object.entries(all).filter(
            // A saved file keeps its binding; an untitled one cannot come back.
            ([uri]) => open.has(uri) || !uri.startsWith('untitled:'),
        ));
        if (Object.keys(kept).length !== Object.keys(all).length) {
            await this.context.globalState.update(KEY, kept);
        }
    }

    /** Show the binding for the focused editor, and hide it everywhere else. */
    refresh(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'sql') {
            this.status.hide();
            return;
        }
        const connection = this.resolve(editor.document);
        const bound = this.isBound(editor.document);

        if (!connection) {
            this.status.text = '$(database) Fusion: none';
            this.status.tooltip = 'No Fusion connection chosen for this editor. Click to choose one.';
            this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            // A pinned editor is marked, so a window-wide change cannot silently
            // move a query you deliberately pointed at one environment.
            this.status.text = `$(database) ${connection.name}${bound ? ' $(pin)' : ''}`;
            this.status.tooltip = new vscode.MarkdownString(
                `Queries in this editor run on **${connection.name}**\n\n`
                + `${connection.url}\n\n`
                + (bound ? 'Pinned to this editor.' : 'Follows the window default.')
                + '\n\nClick to change.',
            );
            this.status.backgroundColor = undefined;
        }
        this.status.show();
    }
}
