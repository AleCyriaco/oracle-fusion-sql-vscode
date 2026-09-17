/**
 * Query history.
 *
 * Kept in globalState rather than a file: it follows the user across windows,
 * needs no path handling, and VS Code already persists it. Entries are capped
 * so a long session cannot grow the state unboundedly.
 */
import * as vscode from 'vscode';

const KEY = 'fusionSql.history';
const LIMIT = 200;

export type HistoryEntry = {
    id: string;
    sql: string;
    connection: string;
    /** Epoch milliseconds. */
    at: number;
    rows?: number;
    elapsedMs?: number;
    error?: string;
};

export class History {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.emitter.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    list(): HistoryEntry[] {
        return this.context.globalState.get<HistoryEntry[]>(KEY) ?? [];
    }

    /**
     * Record a run. Re-running the same statement on the same connection moves
     * the existing entry to the top instead of stacking duplicates, which is
     * what makes the list still readable after an afternoon of iterating.
     */
    async add(entry: Omit<HistoryEntry, 'id' | 'at'>): Promise<void> {
        const normalized = entry.sql.trim();
        if (!normalized) { return; }
        const rest = this.list().filter(
            (e) => !(e.sql.trim() === normalized && e.connection === entry.connection),
        );
        const next: HistoryEntry[] = [
            { ...entry, sql: normalized, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() },
            ...rest,
        ].slice(0, LIMIT);
        await this.context.globalState.update(KEY, next);
        this.emitter.fire();
    }

    async remove(id: string): Promise<void> {
        await this.context.globalState.update(KEY, this.list().filter((e) => e.id !== id));
        this.emitter.fire();
    }

    async clear(): Promise<void> {
        await this.context.globalState.update(KEY, []);
        this.emitter.fire();
    }
}

export class HistoryItem extends vscode.TreeItem {
    constructor(readonly entry: HistoryEntry) {
        super(firstLine(entry.sql), vscode.TreeItemCollapsibleState.None);
        this.description = `${entry.connection} · ${relative(entry.at)}${outcome(entry)}`;
        this.tooltip = new vscode.MarkdownString(
            `\`\`\`sql\n${entry.sql}\n\`\`\`\n\n${new Date(entry.at).toLocaleString()} · ${entry.connection}` +
            (entry.error ? `\n\n**Failed:** ${entry.error}` : ''),
        );
        this.contextValue = 'history';
        this.iconPath = new vscode.ThemeIcon(entry.error ? 'error' : 'history');
        this.command = {
            command: 'fusionSql.openHistoryEntry',
            title: 'Open in Editor',
            arguments: [this],
        };
    }
}

export class HistoryProvider implements vscode.TreeDataProvider<HistoryItem> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly history: History) {
        history.onDidChange(() => this.emitter.fire());
    }

    refresh(): void { this.emitter.fire(); }

    getTreeItem(element: HistoryItem): vscode.TreeItem { return element; }

    getChildren(): HistoryItem[] {
        return this.history.list().map((entry) => new HistoryItem(entry));
    }
}

/** The label is one line: a wrapped SQL block in a tree is unreadable. */
function firstLine(sql: string): string {
    const flat = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

function outcome(entry: HistoryEntry): string {
    if (entry.error) { return ' · failed'; }
    if (entry.rows === undefined) { return ''; }
    return ` · ${entry.rows} row${entry.rows === 1 ? '' : 's'}`;
}

/** Coarse on purpose: the exact timestamp is in the tooltip. */
export function relative(at: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) { return 'just now'; }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.round(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    const days = Math.round(hours / 24);
    return days < 7 ? `${days}d ago` : new Date(at).toLocaleDateString();
}
