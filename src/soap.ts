/**
 * BI Publisher's SOAP v2 catalog service — used only to deploy the proxy report.
 *
 * This service authenticates from <v2:userID>/<v2:password> inside the envelope,
 * not from the HTTP Authorization header. That single fact is why SSO cannot
 * deploy a proxy: a bearer token has no password to put here.
 *
 * XML is built and read by hand on purpose. The payloads are three fixed shapes,
 * and pulling in a parser would add a dependency for no gain.
 */
export const CATALOG_PATH = '/xmlpserver/services/v2/CatalogService';
export const REPORT_PATH = '/xmlpserver/services/v2/ReportService';

export type SoapOptions = {
    baseUrl: string;
    username: string;
    password: string;
    timeoutMs: number;
};

export class SoapError extends Error {
    constructor(message: string, readonly isAuthFailure = false) {
        super(message);
        this.name = 'SoapError';
    }
}

export function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * First text content of an element, ignoring namespace prefixes. Enough for the
 * handful of scalar replies this module reads, and immune to the prefix
 * changing between BI Publisher versions.
 */
export function elementText(xml: string, localName: string): string | undefined {
    const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>`).exec(xml);
    return match ? match[1].trim() : undefined;
}

function credentials(options: SoapOptions): string {
    return `<v2:userID>${escapeXml(options.username)}</v2:userID>` +
        `<v2:password>${escapeXml(options.password)}</v2:password>`;
}

async function call(
    options: SoapOptions, operation: string, args: string, service = CATALOG_PATH,
): Promise<string> {
    const envelope =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
        ' xmlns:v2="http://xmlns.oracle.com/oxp/service/v2"><s:Body>' +
        `<v2:${operation}>${args}${credentials(options)}</v2:${operation}>` +
        '</s:Body></s:Envelope>';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
        response = await fetch(`${options.baseUrl}${service}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                SOAPAction: '',
                Authorization: 'Basic ' + Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64'),
            },
            body: envelope,
            signal: controller.signal,
            redirect: 'manual',
        });
    } catch (error) {
        if (controller.signal.aborted) {
            throw new SoapError(`${operation} timed out against ${options.baseUrl}.`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }

    const text = await response.text();

    // A sign-in page instead of XML is how Fusion rejects credentials on this
    // endpoint; saying "invalid XML" here would send the user hunting the wrong bug.
    const looksHtml = /^\s*<(?:!doctype|html)\b/i.test(text) ||
        (response.headers.get('content-type') ?? '').includes('html');
    if (looksHtml) {
        throw new SoapError(
            `${operation} received an HTML page (HTTP ${response.status}) instead of SOAP — ` +
            'usually the SSO sign-in page, meaning the username or password was rejected.',
            true,
        );
    }

    const fault = elementText(text, 'faultstring');
    if (fault) {
        throw new SoapError(`${operation} failed: ${fault}`, /invalid username or password/i.test(fault));
    }
    if (!response.ok) {
        throw new SoapError(`${operation} returned HTTP ${response.status}.`, response.status === 401);
    }
    return text;
}

export async function objectExists(options: SoapOptions, path: string): Promise<boolean> {
    const xml = await call(options, 'objectExist',
        `<v2:reportObjectAbsolutePath>${escapeXml(path)}</v2:reportObjectAbsolutePath>`);
    const value = elementText(xml, 'objectExistReturn');
    if (value === undefined) {
        throw new SoapError(`objectExist gave no answer for ${path}.`);
    }
    return value === 'true' || value === '1';
}

/** Idempotent: an existing folder is not an error worth surfacing. */
export async function createFolder(options: SoapOptions, path: string): Promise<void> {
    if (!path || path === '/') { return; }
    try {
        await call(options, 'createFolder', `<v2:folderAbsolutePath>${escapeXml(path)}</v2:folderAbsolutePath>`);
    } catch (error) {
        if (error instanceof SoapError && !error.isAuthFailure && await objectExists(options, path)) { return; }
        throw error;
    }
}

export async function uploadObject(
    options: SoapOptions, path: string, zipped: Buffer, objectType: 'xdmz' | 'xdoz',
): Promise<void> {
    await call(options, 'uploadObject',
        `<v2:reportObjectAbsolutePathURL>${escapeXml(path)}</v2:reportObjectAbsolutePathURL>` +
        `<v2:objectType>${objectType}</v2:objectType>` +
        `<v2:objectZippedData>${zipped.toString('base64')}</v2:objectZippedData>`);
}

/**
 * Run the proxy report over SOAP.
 *
 * The REST endpoint answers HTTP 500 on some pods (OCS-hosted ones in
 * particular), so this is not a legacy path — it is the one that works there.
 * Returns the report output, which the proxy emits as CSV.
 */
export async function runReport(
    options: SoapOptions, reportPath: string, encodedSql: string,
): Promise<Buffer> {
    const args =
        '<v2:reportRequest>' +
        '<v2:attributeFormat>csv</v2:attributeFormat>' +
        '<v2:byPassCache>true</v2:byPassCache>' +
        '<v2:flattenXML>false</v2:flattenXML>' +
        '<v2:parameterNameValues><v2:listOfParamNameValues><v2:item>' +
        '<v2:multiValuesAllowed>false</v2:multiValuesAllowed>' +
        '<v2:name>P_B64_CONTENT</v2:name>' +
        '<v2:refreshParamOnChange>false</v2:refreshParamOnChange>' +
        '<v2:selectAll>false</v2:selectAll>' +
        '<v2:templateParam>false</v2:templateParam>' +
        '<v2:useNullForAll>false</v2:useNullForAll>' +
        `<v2:values><v2:item>${encodedSql}</v2:item></v2:values>` +
        '</v2:item></v2:listOfParamNameValues></v2:parameterNameValues>' +
        `<v2:reportAbsolutePath>${escapeXml(reportPath)}</v2:reportAbsolutePath>` +
        '<v2:sizeOfDataChunkDownload>-1</v2:sizeOfDataChunkDownload>' +
        '</v2:reportRequest>';

    const xml = await call(options, 'runReport', args, REPORT_PATH);
    const bytes = elementText(xml, 'reportBytes');
    if (!bytes) {
        throw new SoapError('BI Publisher returned no report content.');
    }
    return Buffer.from(bytes, 'base64');
}
