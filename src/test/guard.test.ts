import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { inspectStatement, isDictionaryQuery, sourceNames } from '../guard';

const ok = (sql: string) => {
    const v = inspectStatement(sql);
    assert.equal(v.ok, true, `expected allowed, got: ${v.ok ? '' : v.reason}`);
};
const rejected = (sql: string, pattern: RegExp) => {
    const v = inspectStatement(sql);
    assert.equal(v.ok, false, `expected rejected: ${sql}`);
    if (!v.ok) { assert.match(v.reason, pattern); }
};

test('a plain query is allowed, with or without a leading comment', () => {
    ok('SELECT invoice_num FROM ap_invoices_all');
    ok('-- unpaid invoices\nSELECT invoice_num FROM ap_invoices_all');
    ok('WITH x AS (SELECT 1 FROM dual) SELECT * FROM x');
});

test('statements that change anything are refused', () => {
    rejected('DELETE FROM ap_invoices_all', /only SELECT and WITH/);
    rejected('SELECT 1 FROM dual; DROP TABLE t', /more than one statement/);
    rejected('WITH x AS (SELECT 1 FROM dual) UPDATE t SET a=1', /UPDATE changes data/);
    rejected('BEGIN NULL; END;', /more than one statement|only SELECT/);
});

test('calls that reach outside the query are refused', () => {
    // Not hypothetical: on a live pod UTL_HTTP returns ORA-29273, meaning the
    // request was actually attempted.
    rejected("SELECT UTL_HTTP.request('http://x') FROM dual", /UTL_HTTP reaches outside/);
    rejected('SELECT DBMS_RANDOM.value FROM dual', /DBMS_RANDOM reaches outside/);
    rejected("SELECT HTTPURITYPE('http://x').getclob() FROM dual", /HTTPURITYPE reaches outside/);
    rejected('SELECT * FROM remote_table@prodlink', /reaches outside/);
    rejected("SELECT 1 FROM dual WHERE 1=1 AND EXECUTE IMMEDIATE 'x'", /EXECUTE IMMEDIATE/);
});

test('forbidden words inside comments and literals are not the statement', () => {
    ok("SELECT 'we do not DELETE here' AS note FROM dual");
    ok('-- never DROP anything\nSELECT 1 FROM dual');
    ok("SELECT 'contact utl_http@example.com' FROM dual");
});

test('an empty or comment-only reply is refused', () => {
    rejected('', /no statement/);
    rejected('-- just thinking out loud', /no statement/);
});

test('sourceNames finds what a statement reads, unqualified', () => {
    assert.deepEqual(
        sourceNames('SELECT * FROM fusion.po_headers_all p JOIN po_lines_all l ON l.x = p.x'),
        ['PO_HEADERS_ALL', 'PO_LINES_ALL'],
    );
    // A subquery contributes no name of its own.
    assert.deepEqual(sourceNames('SELECT * FROM (SELECT 1 FROM dual)'), ['DUAL']);
});

test('a dictionary lookup is recognised, and a real query is not', () => {
    assert.equal(isDictionaryQuery(
        "SELECT column_name FROM all_tab_columns WHERE table_name='AP_INVOICES_ALL'"), true);
    assert.equal(isDictionaryQuery(
        "SELECT object_name FROM all_objects WHERE object_name LIKE 'PO%'"), true);
    assert.equal(isDictionaryQuery('SELECT invoice_num FROM ap_invoices_all'), false);
    // Mixing the dictionary with business data is an answer, not a lookup.
    assert.equal(isDictionaryQuery(
        'SELECT c.column_name FROM all_tab_columns c JOIN ap_invoices_all i ON 1=1'), false);
});
