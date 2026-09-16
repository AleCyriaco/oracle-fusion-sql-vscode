/**
 * Authentication for Fusion.
 *
 * Two modes, and the difference between them is not cosmetic:
 *
 *   basic — username + password. Works for everything, including deploying the
 *           proxy report, because BI Publisher's SOAP catalog service takes the
 *           credentials inside the SOAP envelope (<v2:userID>/<v2:password>).
 *
 *   sso   — OAuth 2.0 Authorization Code with PKCE against IDCS / OCI IAM. The
 *           bearer token authenticates the REST call that RUNS a report, but it
 *           cannot be put in a SOAP envelope, so an SSO connection cannot deploy
 *           the proxy: it needs a reportPath that already exists. See README.
 */
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { normalizeBaseUrl } from './protocol';

export type OAuthConfig = {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scope?: string;
};

export interface AuthProvider {
    /** Headers to authenticate an HTTP request, refreshing the token if needed. */
    headers(): Promise<Record<string, string>>;
    /** Credentials for a SOAP envelope, or undefined when this mode has none. */
    soapCredentials(): { username: string; password: string } | undefined;
    describe(): string;
}

export class BasicAuth implements AuthProvider {
    constructor(private readonly username: string, private readonly password: string) {}

    async headers(): Promise<Record<string, string>> {
        const raw = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');
        return { Authorization: `Basic ${raw}` };
    }

    soapCredentials() {
        return { username: this.username, password: this.password };
    }

    describe(): string {
        return `basic (${this.username})`;
    }
}

export type StoredToken = {
    accessToken: string;
    refreshToken?: string;
    /** Epoch milliseconds. */
    expiresAt?: number;
};

export class OAuthAuth implements AuthProvider {
    constructor(
        private token: StoredToken,
        private readonly config: OAuthConfig,
        private readonly persist: (token: StoredToken) => Promise<void>,
    ) {}

    async headers(): Promise<Record<string, string>> {
        await this.refreshIfExpiring();
        return { Authorization: `Bearer ${this.token.accessToken}` };
    }

    soapCredentials() {
        return undefined;
    }

    describe(): string {
        return 'sso (OAuth 2.0)';
    }

    /** Refresh a minute ahead of expiry so a long query doesn't die mid-flight. */
    private async refreshIfExpiring(): Promise<void> {
        const expiresAt = this.token.expiresAt;
        if (!expiresAt || Date.now() < expiresAt - 60_000) { return; }
        if (!this.token.refreshToken) {
            throw new Error('The SSO session has expired. Run "Fusion: Sign In (SSO)" again.');
        }
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: this.token.refreshToken,
            client_id: this.config.clientId,
        });
        const response = await fetch(this.config.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        if (!response.ok) {
            throw new Error(
                `Could not refresh the SSO token (HTTP ${response.status}). Run "Fusion: Sign In (SSO)" again.`,
            );
        }
        this.token = tokenFromResponse(await response.json() as TokenResponse, this.token.refreshToken);
        await this.persist(this.token);
    }
}

type TokenResponse = {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
};

export function tokenFromResponse(data: TokenResponse, previousRefresh?: string): StoredToken {
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? previousRefresh,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
}

/**
 * Interactive sign-in: open the identity provider in the real browser (so the
 * user's existing SSO session, MFA and device trust all apply) and catch the
 * redirect through VS Code's URI handler. PKCE means no client secret has to
 * ship with the extension.
 */
export async function signInInteractive(
    config: OAuthConfig,
    extensionId: string,
    waitForCallback: (state: string) => Promise<URLSearchParams>,
): Promise<StoredToken> {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const redirectUri = `${vscode.env.uriScheme}://${extensionId}/auth`;

    const authorize = new URL(config.authorizeUrl);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', config.clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', config.scope ?? 'openid offline_access');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');

    const opened = await vscode.env.openExternal(vscode.Uri.parse(authorize.toString()));
    if (!opened) { throw new Error('Could not open the browser for sign-in.'); }

    const params = await waitForCallback(state);
    const error = params.get('error');
    if (error) {
        throw new Error(`Sign-in failed: ${params.get('error_description') ?? error}`);
    }
    const code = params.get('code');
    if (!code) { throw new Error('Sign-in did not return an authorization code.'); }

    const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            code_verifier: verifier,
        }).toString(),
    });
    if (!response.ok) {
        throw new Error(`Token exchange failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    return tokenFromResponse(await response.json() as TokenResponse);
}

/**
 * IDCS endpoints follow a fixed shape, so a user who only knows their identity
 * domain host doesn't have to hand-write both URLs.
 */
export function idcsEndpoints(idcsHost: string): Pick<OAuthConfig, 'authorizeUrl' | 'tokenUrl'> {
    const base = normalizeBaseUrl(idcsHost);
    return { authorizeUrl: `${base}/oauth2/v1/authorize`, tokenUrl: `${base}/oauth2/v1/token` };
}
