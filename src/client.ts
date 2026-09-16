/**
 * Talking to Fusion: run a query, and deploy the proxy report when it is absent.
 */
import { AuthProvider } from './auth';
import {
    CsvTable, defaultReportPath, encodeSql, normalizeBaseUrl, paginate, parseCsv,
    reportRunBody, runUrl,
} from './protocol';
import { objectExists, createFolder, uploadObject, runReport, SoapError } from './soap';
import { buildProxyObjects } from './deploy';

export type QueryPage = CsvTable & {
    offset: number;
    pageSize: number;
    hasMore: boolean;
    elapsedMs: number;
};

export type ClientOptions = {
    baseUrl: string;
    auth: AuthProvider;
    /** Explicit proxy report; defaults to the signed-in user's My Folders copy. */
    reportPath?: string;
    timeoutMs: number;
    /** Supplies the bundled .xdrz when the report has to be deployed. */
    template?: () => Promise<Buffer>;
};

export class FusionClient {
    private readonly baseUrl: string;
    private deployChecked = false;
    /** Set once REST has proved unusable on this pod, so we stop paying for it. */
    private useSoap = false;

    constructor(private readonly options: ClientOptions) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl);
    }

    /**
     * The report this connection runs. With SSO there is no username to build a
     * personal path from, so an explicit reportPath is mandatory — which matches
     * the fact that an SSO connection cannot deploy one either.
     */
    reportPath(): string {
        if (this.options.reportPath) { return this.options.reportPath; }
        const credentials = this.options.auth.soapCredentials();
        if (!credentials) {
            throw new Error(
                'This connection signs in with SSO, so it has no My Folders path of its own. ' +
                'Set "reportPath" to a proxy report that already exists — deploy it once with a ' +
                'username/password connection, or point at a shared one.',
            );
        }
        return defaultReportPath(credentials.username);
    }

    async query(sql: string, offset: number, pageSize: number): Promise<QueryPage> {
        await this.ensureProxyDeployed();
        const started = Date.now();
        const encoded = encodeSql(paginate(sql, offset, pageSize));
        const csv = this.useSoap ? await this.runSoap(encoded) : await this.runRest(encoded);
        const table = parseCsv(csv);
        return {
            ...table,
            offset,
            pageSize,
            // A full page means there is probably another one; the next fetch settles it.
            hasMore: table.rows.length >= pageSize,
            elapsedMs: Date.now() - started,
        };
    }

    /**
     * The REST endpoint is tried first because it is cheaper and clearer, but
     * several pods answer it with HTTP 500 while SOAP works perfectly. So a
     * server-side failure switches this connection over for good rather than
     * surfacing an error the user can do nothing about.
     */
    private async runRest(encoded: string): Promise<string> {
        const response = await this.fetch(runUrl(this.baseUrl, this.reportPath()), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reportRunBody(encoded)),
        });

        if (!response.ok) {
            const body = (await response.text()).slice(0, 500);
            const credentials = this.options.auth.soapCredentials();
            if (response.status >= 500 && credentials) {
                this.useSoap = true;
                return this.runSoap(encoded);
            }
            throw new Error(`BI Publisher returned HTTP ${response.status}. ${describeHttp(response.status, body)}`);
        }

        const payload = await response.json() as { reportBytes?: string };
        if (!payload.reportBytes) {
            throw new Error('BI Publisher returned no report content.');
        }
        return Buffer.from(payload.reportBytes, 'base64').toString('utf8');
    }

    private async runSoap(encoded: string): Promise<string> {
        const credentials = this.options.auth.soapCredentials();
        if (!credentials) {
            throw new Error(
                'This pod needs BI Publisher\'s SOAP endpoint, which authenticates from credentials ' +
                'inside the request and cannot accept an SSO token. Use a username/password connection ' +
                'for this environment.',
            );
        }
        const bytes = await runReport(
            { baseUrl: this.baseUrl, ...credentials, timeoutMs: this.options.timeoutMs },
            this.reportPath(), encoded,
        );
        return bytes.toString('utf8');
    }

    /** Connectivity + deployment + a round trip through the database. */
    async testConnection(): Promise<{ deployed: boolean; message: string }> {
        const deployed = await this.ensureProxyDeployed();
        const page = await this.query('SELECT 1 AS OK FROM DUAL', 0, 1);
        if (page.rows.length === 0) {
            throw new Error('The proxy report ran but returned no rows.');
        }
        return {
            deployed,
            message: deployed
                ? `Connected. Proxy report deployed at ${this.reportPath()}.`
                : `Connected. Using proxy report ${this.reportPath()}.`,
        };
    }

    /**
     * Deploy the proxy on first use. Returns true when something was created.
     * Only possible with username/password: the SOAP catalog service carries the
     * credentials in the envelope, which a bearer token cannot satisfy.
     */
    private async ensureProxyDeployed(): Promise<boolean> {
        if (this.deployChecked) { return false; }
        const path = this.reportPath();
        const credentials = this.options.auth.soapCredentials();

        if (!credentials) {
            this.deployChecked = true;
            return false; // SSO: trust the configured reportPath, fail loudly at query time.
        }

        const soap = { baseUrl: this.baseUrl, ...credentials, timeoutMs: this.options.timeoutMs };
        try {
            if (await objectExists(soap, path)) {
                this.deployChecked = true;
                return false;
            }
        } catch (error) {
            // A catalog that cannot even be queried is an auth or network problem,
            // and the query below will report it far more precisely.
            if (error instanceof SoapError && error.isAuthFailure) { throw error; }
            this.deployChecked = true;
            return false;
        }

        if (!this.options.template) {
            throw new Error(`Proxy report ${path} does not exist and no template is bundled to deploy it.`);
        }
        const folder = path.slice(0, path.lastIndexOf('/'));
        const parent = folder.slice(0, folder.lastIndexOf('/'));
        const objects = buildProxyObjects(await this.options.template(), folder);

        await createFolder(soap, parent);
        await createFolder(soap, folder);
        await uploadObject(soap, objects.dataModelPath, objects.dataModel, 'xdmz');
        await uploadObject(soap, objects.reportPath, objects.report, 'xdoz');

        if (!(await objectExists(soap, path))) {
            throw new Error(
                `BI Publisher did not confirm ${path} after upload. The user must be allowed to ` +
                'create folders, data models and reports in My Folders.',
            );
        }
        this.deployChecked = true;
        return true;
    }

    private async fetch(url: string, init: RequestInit): Promise<Response> {
        const headers = { ...(init.headers as Record<string, string>), ...(await this.options.auth.headers()) };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        try {
            return await fetch(url, { ...init, headers, signal: controller.signal, redirect: 'manual' });
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error(`Timed out after ${Math.round(this.options.timeoutMs / 1000)}s waiting for ${this.baseUrl}.`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

/** Turn the HTTP status into the thing the user actually has to fix. */
function describeHttp(status: number, body: string): string {
    if (status === 401 || status === 403) {
        return 'The credentials were rejected, or the user lacks BI Publisher access.';
    }
    if (status === 404) {
        return 'The proxy report was not found at that path — check "reportPath".';
    }
    if (status >= 300 && status < 400) {
        return 'The server answered with a redirect, which usually means an SSO sign-in page: ' +
            'the token or password was not accepted.';
    }
    if (status === 504 || status === 502) {
        return 'The pod did not answer in time — check the hostname and that the environment is up.';
    }
    return body ? `Response: ${body}` : '';
}
