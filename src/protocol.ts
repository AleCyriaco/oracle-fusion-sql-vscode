/**
 * The Fusion BI Publisher wire protocol — pure functions, no VS Code and no I/O,
 * so it can be unit-tested with plain node.
 *
 * A query travels as a parameter of a BI Publisher report:
 *   SQL -> utf8 -> gzip -> base64 -> P_B64_CONTENT
 * The proxy data model reverses that inside the database and opens a cursor.
 */
import { gzipSync } from 'node:zlib';

export const PROXY_REPORT_SUFFIX = '/FusionQuery/v1/csv.xdo';

/** SQL text as the proxy report's P_B64_CONTENT parameter expects it. */
export function encodeSql(sql: string): string {
    return gzipSync(Buffer.from(sql, 'utf8')).toString('base64');
}

/**
 * Add OFFSET/FETCH (SQL:2008, which Fusion's database supports) so results
 * arrive one page at a time. A statement that already paginates is left alone,
 * as are non-SELECT statements — the proxy is read-only and will reject them
 * with the database's own message rather than a mangled one.
 */
export function paginate(sql: string, offset: number, limit: number): string {
    const trimmed = sql.trim().replace(/;+\s*$/, '');
    if (/\boffset\s+\d+\s+rows?\b/i.test(trimmed) || /\bfetch\s+(first|next)\b/i.test(trimmed)) {
        return trimmed;
    }
    if (!/^\s*(select|with)\b/i.test(trimmed)) {
        return trimmed;
    }
    return `${trimmed} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

/** JSON body for POST /xmlpserver/services/rest/v1/reports/{path}/run */
export function reportRunBody(encodedSql: string): unknown {
    return {
        byPassCache: true,
        flattenXML: false,
        attributeFormat: 'csv',
        parameterNameValues: {
            listOfParamNameValues: {
                item: [{ name: 'P_B64_CONTENT', values: { item: [encodedSql] } }],
            },
        },
    };
}

/** The REST endpoint for a report, with the catalog path escaped segment by segment. */
export function runUrl(baseUrl: string, reportPath: string): string {
    const path = reportPath.replace(/^\/+/, '');
    const escaped = path.split('/').map(encodeURIComponent).join('/');
    return `${normalizeBaseUrl(baseUrl)}/xmlpserver/services/rest/v1/reports/${escaped}/run`;
}

/**
 * Accept whatever the user pasted — a bare host, a full URL, a URL with a
 * trailing path — and return a clean https origin.
 */
export function normalizeBaseUrl(input: string): string {
    let value = input.trim().replace(/\/+$/, '');
    value = value.replace(/^(https?):\/\//i, '');
    const slash = value.indexOf('/');
    if (slash >= 0) { value = value.slice(0, slash); }
    return `https://${value}`;
}

/** Personal My Folders path for a user, where the proxy is deployed by default. */
export function defaultReportPath(username: string): string {
    return `/~${username}${PROXY_REPORT_SUFFIX}`;
}

export type CsvTable = { columns: string[]; rows: Record<string, string>[] };

/**
 * Which character separates fields. The proxy report emits pipes, because SQL
 * results are full of commas and quoting every field would double the payload —
 * but a hand-made report may well be comma-separated, so look at the header
 * rather than assuming. Quotes are honoured either way, so a pipe inside a
 * quoted value does not fool the count.
 */
export function detectDelimiter(text: string): string {
    const header = text.split(/\r?\n/, 1)[0] ?? '';
    let pipes = 0;
    let commas = 0;
    let quoted = false;
    for (let i = 0; i < header.length; i++) {
        const ch = header[i];
        if (ch === '"') { quoted = !quoted; continue; }
        if (quoted) { continue; }
        if (ch === '|') { pipes++; }
        else if (ch === ',') { commas++; }
    }
    return pipes >= commas && pipes > 0 ? '|' : ',';
}

/**
 * RFC 4180 rules over whichever delimiter the report used: quoted fields may
 * hold the delimiter, newlines and doubled quotes. Values stay strings — BI
 * Publisher has already formatted them, and guessing types here would corrupt
 * IDs that merely look numeric.
 */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): CsvTable {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else { quoted = false; }
            } else { field += ch; }
            continue;
        }
        if (ch === '"') { quoted = true; }
        else if (ch === delimiter) { row.push(field); field = ''; }
        else if (ch === '\r') { /* handled by \n */ }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else { field += ch; }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

    const header = rows.shift();
    if (!header) { return { columns: [], rows: [] }; }

    // Duplicated column names (common in SELECT * joins) would collide as object
    // keys, so suffix repeats the way SQL clients do.
    const seen = new Map<string, number>();
    const columns = header.map((name) => {
        const base = name.trim();
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return count === 0 ? base : `${base}_${count}`;
    });

    return {
        columns,
        rows: rows
            .filter((r) => r.length > 1 || (r[0] ?? '').length > 0)
            .map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))),
    };
}

/** Values back to delimited text, for the export command. */
export function toCsv(columns: string[], rows: Record<string, string>[], delimiter = ','): string {
    const needsQuote = new RegExp(`["\r\n${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`);
    const escape = (v: string) => (needsQuote.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [columns.map(escape).join(delimiter)];
    for (const r of rows) { lines.push(columns.map((c) => escape(r[c] ?? '')).join(delimiter)); }
    return lines.join('\r\n');
}
