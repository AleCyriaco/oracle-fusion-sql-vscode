/**
 * What a generated statement is allowed to be.
 *
 * The transport will run whatever it is given, and the database it reaches is a
 * production ERP. `UTL_HTTP.request` on this pod does not come back "not
 * permitted" — it comes back ORA-29273, meaning the call was attempted and only
 * the network stopped it. So the boundary has to be enforced here, before the
 * statement is offered to anyone, rather than relied upon downstream.
 */
import { isBlankStatement, maskLiterals, splitStatements } from './protocol';

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Dictionary views the model may consult to check a name. Everything here is
 * metadata — object and column names — never business data.
 */
export const DICTIONARY_VIEWS = [
    'ALL_TAB_COLUMNS', 'ALL_TABLES', 'ALL_VIEWS', 'ALL_OBJECTS', 'ALL_SYNONYMS',
    'ALL_TAB_COMMENTS', 'ALL_COL_COMMENTS', 'ALL_CONSTRAINTS', 'ALL_CONS_COLUMNS',
    'ALL_INDEXES', 'ALL_IND_COLUMNS', 'ALL_ARGUMENTS', 'ALL_PROCEDURES',
    'USER_TAB_COLUMNS', 'USER_TABLES', 'USER_VIEWS', 'USER_OBJECTS', 'USER_SYNONYMS',
    'DUAL',
];

/** Statement kinds that change data or structure. */
const WRITE_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'CREATE', 'ALTER',
    'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'LOCK', 'RENAME', 'FLASHBACK',
];

/** Anything that reaches outside the query: network, files, mail, dynamic execution. */
const REACH_OUT = [
    /\bUTL_\w+/i,        // UTL_HTTP, UTL_SMTP, UTL_TCP, UTL_FILE, UTL_INADDR…
    /\bDBMS_\w+/i,       // scheduler, pipes, dynamic SQL, LOB access
    /\bAPEX_\w+/i,
    /\bOWA_\w+/i,
    /\b(HTTP|DB|XDB)URITYPE\b/i,
    /\bEXECUTE\s+IMMEDIATE\b/i,
    /\b\w+@\w+/,         // a database link is another server
];

/**
 * Is this statement acceptable to run and to show the user? Comments and string
 * literals are masked first, so a `--` note about deleting rows, or the word
 * UPDATE inside a literal, does not trip the check.
 */
export function inspectStatement(sql: string): Verdict {
    if (isBlankStatement(sql)) {
        return { ok: false, reason: 'the reply contained no statement' };
    }
    const statements = splitStatements(sql)
        .map((s) => sql.slice(s.start, s.end))
        .filter((part) => !isBlankStatement(part));
    if (statements.length > 1) {
        return { ok: false, reason: 'more than one statement was returned; exactly one is allowed' };
    }

    const masked = maskLiterals(sql);
    if (!/^\s*(SELECT|WITH)\b/i.test(masked.trim())) {
        const first = /\b([A-Za-z_]+)\b/.exec(masked.trim());
        return {
            ok: false,
            reason: `the statement starts with ${first ? first[1].toUpperCase() : 'something'} — `
                + 'only SELECT and WITH are allowed',
        };
    }
    for (const keyword of WRITE_KEYWORDS) {
        if (new RegExp(`\\b${keyword}\\b`, 'i').test(masked)) {
            return { ok: false, reason: `${keyword} changes data or structure and is not allowed` };
        }
    }
    for (const pattern of REACH_OUT) {
        const hit = pattern.exec(masked);
        if (hit) {
            return {
                ok: false,
                reason: `${hit[0].trim()} reaches outside the query; only tables and views may be read`,
            };
        }
    }
    return { ok: true };
}

/**
 * True when a statement reads nothing but the dictionary. Such a reply is the
 * model checking a name, not answering the question — so it is run and the rows
 * handed back rather than shown as the result.
 */
export function isDictionaryQuery(sql: string): boolean {
    const sources = sourceNames(sql);
    return sources.length > 0 && sources.every((name) => DICTIONARY_VIEWS.includes(name));
}

/** Object names appearing after FROM or JOIN, upper-cased and unqualified. */
export function sourceNames(sql: string): string[] {
    const masked = maskLiterals(sql);
    const names: string[] = [];
    // A subquery opens with '(' right after FROM/JOIN and contributes no name of
    // its own; its own FROM is matched on the next pass through the string.
    const pattern = /\b(?:FROM|JOIN)\s+(?!\()([A-Za-z_$#][\w$#]*(?:\.[A-Za-z_$#][\w$#]*)?)/gi;
    for (const match of masked.matchAll(pattern)) {
        const full = match[1].toUpperCase();
        names.push(full.includes('.') ? full.slice(full.indexOf('.') + 1) : full);
    }
    return names;
}
