/**
 * Connection definitions live in VS Code settings; secrets never do.
 *
 * Passwords and OAuth tokens go to SecretStorage, which is backed by the OS
 * keychain — so settings files stay safe to sync, commit or screen-share.
 */
import * as vscode from 'vscode';
import { AuthProvider, BasicAuth, OAuthAuth, OAuthConfig, StoredToken } from './auth';

export type AuthMode = 'basic' | 'sso';

export type ConnectionConfig = {
    name: string;
    url: string;
    authMode?: AuthMode;
    user?: string;
    reportPath?: string;
    oauth?: OAuthConfig;
};

const SECTION = 'fusionSql';

export function listConnections(): ConnectionConfig[] {
    return vscode.workspace.getConfiguration(SECTION).get<ConnectionConfig[]>('connections') ?? [];
}

export function findConnection(name: string): ConnectionConfig | undefined {
    return listConnections().find((c) => c.name === name);
}

export async function saveConnection(connection: ConnectionConfig): Promise<void> {
    const all = listConnections();
    const index = all.findIndex((c) => c.name === connection.name);
    if (index >= 0) { all[index] = connection; } else { all.push(connection); }
    await writeConnections(all);
}

export async function deleteConnection(name: string, secrets: vscode.SecretStorage): Promise<void> {
    await writeConnections(listConnections().filter((c) => c.name !== name));
    await secrets.delete(passwordKey(name));
    await secrets.delete(tokenKey(name));
}

function writeConnections(all: ConnectionConfig[]): Thenable<void> {
    // Global so environments follow the user between workspaces.
    return vscode.workspace.getConfiguration(SECTION)
        .update('connections', all, vscode.ConfigurationTarget.Global);
}

export const passwordKey = (name: string) => `${SECTION}.password.${name}`;
export const tokenKey = (name: string) => `${SECTION}.token.${name}`;

export async function readToken(secrets: vscode.SecretStorage, name: string): Promise<StoredToken | undefined> {
    const raw = await secrets.get(tokenKey(name));
    if (!raw) { return undefined; }
    try { return JSON.parse(raw) as StoredToken; } catch { return undefined; }
}

export async function writeToken(secrets: vscode.SecretStorage, name: string, token: StoredToken): Promise<void> {
    await secrets.store(tokenKey(name), JSON.stringify(token));
}

/**
 * Build the auth provider for a connection, prompting for a password only when
 * one was never stored. Returns undefined when the user cancels the prompt or
 * an SSO connection has no session yet.
 */
export async function resolveAuth(
    connection: ConnectionConfig,
    secrets: vscode.SecretStorage,
): Promise<AuthProvider | undefined> {
    if ((connection.authMode ?? 'basic') === 'sso') {
        if (!connection.oauth) {
            throw new Error(`Connection "${connection.name}" is set to SSO but has no "oauth" settings.`);
        }
        const token = await readToken(secrets, connection.name);
        if (!token) { return undefined; }
        return new OAuthAuth(token, connection.oauth, (t) => writeToken(secrets, connection.name, t));
    }

    if (!connection.user) {
        throw new Error(`Connection "${connection.name}" has no username.`);
    }
    let password = await secrets.get(passwordKey(connection.name));
    if (!password) {
        password = await vscode.window.showInputBox({
            title: `Password for ${connection.user}@${connection.name}`,
            password: true,
            ignoreFocusOut: true,
            prompt: 'Stored in the OS keychain, never in settings.',
        });
        if (!password) { return undefined; }
        await secrets.store(passwordKey(connection.name), password);
    }
    return new BasicAuth(connection.user, password);
}

type ImportedEntry = {
    name?: string;
    url?: string;
    user?: string;
    username?: string;
    report_path?: string;
    reportPath?: string;
};

/**
 * Import from the connections.json used by the fusion-query MCP server, so an
 * existing setup doesn't have to be retyped. Both shapes that file has taken
 * are accepted: a {"NAME": {...}} map and a {"connections": [...]} list.
 * Passwords in it are ignored — the user is asked on first use and the answer
 * goes to the keychain instead.
 */
export function parseImportedConnections(raw: string): ConnectionConfig[] {
    const parsed = JSON.parse(raw) as unknown;
    const entries: ImportedEntry[] = [];

    if (Array.isArray(parsed)) {
        entries.push(...(parsed as ImportedEntry[]));
    } else if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record.connections)) {
            entries.push(...(record.connections as ImportedEntry[]));
        } else {
            for (const [name, value] of Object.entries(record)) {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    entries.push({ name, ...(value as ImportedEntry) });
                }
            }
        }
    }

    const out: ConnectionConfig[] = [];
    for (const entry of entries) {
        if (!entry.name || !entry.url) { continue; }
        out.push({
            name: entry.name,
            url: entry.url,
            authMode: 'basic',
            user: entry.user ?? entry.username,
            reportPath: entry.reportPath ?? entry.report_path,
        });
    }
    return out;
}

export async function importFromJson(uri: vscode.Uri): Promise<number> {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const incoming = parseImportedConnections(raw);
    for (const connection of incoming) { await saveConnection(connection); }
    return incoming.length;
}
