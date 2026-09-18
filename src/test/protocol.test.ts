import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
    detectDelimiter, encodeSql, isBlankStatement, maskLiterals, normalizeBaseUrl, paginate, parseCsv,
    reportRunBody, runUrl, splitStatements, toCsv, defaultReportPath,
} from '../protocol';
import { elementText, escapeXml } from '../soap';
import { pickIdentityDomain } from '../discovery';

test('encodeSql round-trips through gzip+base64', () => {
    const sql = "SELECT 'acentuação ñ' FROM dual";
    assert.equal(gunzipSync(Buffer.from(encodeSql(sql), 'base64')).toString('utf8'), sql);
});

test('normalizeBaseUrl accepts whatever the user pasted', () => {
    const expected = 'https://pod.fa.us2.oraclecloud.com';
    for (const input of [
        'pod.fa.us2.oraclecloud.com',
        'https://pod.fa.us2.oraclecloud.com',
        'HTTP://pod.fa.us2.oraclecloud.com',
        'https://pod.fa.us2.oraclecloud.com/xmlpserver',
        '  pod.fa.us2.oraclecloud.com/  ',
    ]) {
        assert.equal(normalizeBaseUrl(input), expected, `failed for ${input}`);
    }
});

test('paginate adds OFFSET/FETCH and leaves other statements alone', () => {
    assert.equal(
        paginate('SELECT * FROM po_headers_all;', 0, 200),
        'SELECT * FROM po_headers_all OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY',
    );
    assert.equal(paginate('WITH x AS (SELECT 1 FROM dual) SELECT * FROM x', 400, 200),
        'WITH x AS (SELECT 1 FROM dual) SELECT * FROM x OFFSET 400 ROWS FETCH NEXT 200 ROWS ONLY');
    // already paginated: untouched
    const manual = 'SELECT * FROM t OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY';
    assert.equal(paginate(manual, 0, 200), manual);
    // not a query: untouched, so the database can reject it in its own words
    assert.equal(paginate('UPDATE t SET a = 1', 0, 200), 'UPDATE t SET a = 1');
});

test('runUrl escapes catalog paths with spaces and tildes', () => {
    assert.equal(
        runUrl('https://pod.example.com', '/~FUSION_USER/Fusion Query/v1/csv.xdo'),
        'https://pod.example.com/xmlpserver/services/rest/v1/reports/~FUSION_USER/Fusion%20Query/v1/csv.xdo/run',
    );
});

test('reportRunBody carries the SQL as P_B64_CONTENT in csv format', () => {
    const body = reportRunBody('ENCODED') as any;
    assert.equal(body.attributeFormat, 'csv');
    assert.equal(body.byPassCache, true);
    const item = body.parameterNameValues.listOfParamNameValues.item[0];
    assert.equal(item.name, 'P_B64_CONTENT');
    assert.deepEqual(item.values.item, ['ENCODED']);
});

test('defaultReportPath targets the user My Folders copy', () => {
    assert.equal(defaultReportPath('FUSION_USER'), '/~FUSION_USER/FusionQuery/v1/csv.xdo');
});

test('parseCsv handles quotes, embedded commas and newlines', () => {
    const csv = 'ID,NAME,NOTE\r\n1,"Silva, João","line1\nline2"\r\n2,"He said ""hi""",\r\n';
    const table = parseCsv(csv);
    assert.deepEqual(table.columns, ['ID', 'NAME', 'NOTE']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0].NAME, 'Silva, João');
    assert.equal(table.rows[0].NOTE, 'line1\nline2');
    assert.equal(table.rows[1].NAME, 'He said "hi"');
    assert.equal(table.rows[1].NOTE, '');
});

test('parseCsv keeps big IDs as text so precision survives', () => {
    const table = parseCsv('PO_HEADER_ID\r\n300000171282182\r\n');
    assert.equal(table.rows[0].PO_HEADER_ID, '300000171282182');
});

test('parseCsv disambiguates duplicate column names', () => {
    const table = parseCsv('ID,ID,ID\r\na,b,c\r\n');
    assert.deepEqual(table.columns, ['ID', 'ID_1', 'ID_2']);
    assert.equal(table.rows[0].ID_2, 'c');
});

test('toCsv round-trips through parseCsv', () => {
    const columns = ['A', 'B'];
    const rows = [{ A: 'plain', B: 'with, comma' }, { A: 'quote"inside', B: 'new\nline' }];
    assert.deepEqual(parseCsv(toCsv(columns, rows)).rows, rows);
});

test('escapeXml neutralises characters that would break the envelope', () => {
    assert.equal(escapeXml(`pa&ss<w>"o'rd`), 'pa&amp;ss&lt;w&gt;&quot;o&apos;rd');
});

test('elementText reads a value regardless of namespace prefix', () => {
    const xml = '<s:Envelope><s:Body><objectExistResponse xmlns="urn:x">' +
        '<objectExistReturn>true</objectExistReturn></objectExistResponse></s:Body></s:Envelope>';
    assert.equal(elementText(xml, 'objectExistReturn'), 'true');
    assert.equal(elementText('<v2:faultstring>nope</v2:faultstring>', 'faultstring'), 'nope');
    assert.equal(elementText('<other>x</other>', 'faultstring'), undefined);
});

test('detectDelimiter picks the pipe the proxy report actually emits', () => {
    assert.equal(detectDelimiter('SEGMENT1|CREATION_DATE\r\nPA-1|2021-05-25\r\n'), '|');
    assert.equal(detectDelimiter('ID,NAME\r\n1,x\r\n'), ',');
    // a single column has no delimiter at all: either reading works
    assert.equal(detectDelimiter('ONLY_ONE\r\nvalue\r\n'), ',');
    // commas inside quoted headers must not outvote the real delimiter
    assert.equal(detectDelimiter('"LAST, FIRST"|CITY\r\n"Silva, Joao"|SP\r\n'), '|');
});

test('parseCsv reads the pipe-delimited output of a real query', () => {
    const table = parseCsv('SEGMENT1|CREATION_DATE\r\nPO-1001|2021-05-25T14:56:57.000+00:00\r\n');
    assert.deepEqual(table.columns, ['SEGMENT1', 'CREATION_DATE']);
    assert.deepEqual(table.rows, [{
        SEGMENT1: 'PO-1001',
        CREATION_DATE: '2021-05-25T14:56:57.000+00:00',
    }]);
});

test('a comma inside a pipe-delimited value stays part of the value', () => {
    const table = parseCsv('NAME|CITY\r\nSilva, Joao|Sao Paulo\r\n');
    assert.equal(table.rows[0].NAME, 'Silva, Joao');
    assert.equal(table.rows[0].CITY, 'Sao Paulo');
});

test('toCsv quotes whatever the chosen delimiter is', () => {
    assert.equal(toCsv(['A'], [{ A: 'x|y' }], '|'), 'A\r\n"x|y"');
    assert.equal(toCsv(['A'], [{ A: 'x|y' }], ','), 'A\r\nx|y');
});

test('paginate is not fooled by the comment the generator writes above a query', () => {
    // The system prompt asks the model for a leading comment, so this is the
    // shape almost every generated statement arrives in.
    assert.equal(
        paginate('-- unpaid invoices\nSELECT * FROM ap_invoices_all', 0, 200),
        '-- unpaid invoices\nSELECT * FROM ap_invoices_all OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY',
    );
    assert.equal(
        paginate('/* block */ WITH x AS (SELECT 1 FROM dual) SELECT * FROM x', 0, 50),
        '/* block */ WITH x AS (SELECT 1 FROM dual) SELECT * FROM x OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY',
    );
});

test('paginate ignores OFFSET or FETCH that only appears inside a literal', () => {
    const sql = "SELECT 'fetch next 5 rows only' AS note FROM dual";
    assert.equal(paginate(sql, 0, 10), `${sql} OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY`);
});

test('maskLiterals blanks comments and strings but keeps offsets', () => {
    const sql = "SELECT 'a;b' /* x; */ FROM t -- y;\nWHERE 1=1";
    const masked = maskLiterals(sql);
    assert.equal(masked.length, sql.length, 'offsets must line up');
    assert.equal(masked.indexOf(';'), -1, 'no semicolon should survive masking');
    assert.match(masked, /SELECT/);
    assert.match(masked, /WHERE 1=1/);
});

test('splitStatements only breaks on semicolons that end a statement', () => {
    const sql = "-- first; not a break\nSELECT 1 FROM dual;\nSELECT ';' FROM dual";
    const parts = splitStatements(sql).map((p) => sql.slice(p.start, p.end).trim());
    assert.equal(parts.length, 2, `expected 2 statements, got ${JSON.stringify(parts)}`);
    assert.match(parts[0], /^-- first; not a break\nSELECT 1 FROM dual$/);
    assert.match(parts[1], /^SELECT ';' FROM dual$/);
});

test('isBlankStatement recognises text that carries no statement', () => {
    assert.equal(isBlankStatement('-- just a comment'), true);
    assert.equal(isBlankStatement('/* only\n   a block */\n\n'), true);
    assert.equal(isBlankStatement('   \n\t '), true);
    assert.equal(isBlankStatement('-- comment\nSELECT 1 FROM dual'), false);
});

test('pickIdentityDomain recognises the Oracle identity host', () => {
    assert.equal(pickIdentityDomain([
        'https://pod.fa.em4.oraclecloud.com/fscmUI/faces/FuseWelcome',
        'https://pod.fa.em4.oraclecloud.com/fscmUI/adfAuthentication?level=FORM',
        'https://idcs-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.identity.oraclecloud.com/oauth2/v1/authorize?response_mode=form_post',
    ]), 'idcs-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.identity.oraclecloud.com');
});

test('pickIdentityDomain also accepts any host answering on the authorize path', () => {
    assert.equal(pickIdentityDomain(['https://login.example.com/oauth2/v1/authorize?x=1']),
        'login.example.com');
});

test('pickIdentityDomain does not mistake the pod for the identity domain', () => {
    assert.equal(pickIdentityDomain([
        'https://pod.fa.em4.oraclecloud.com/fscmUI/faces/FuseWelcome',
        'https://pod.fa.em4.oraclecloud.com/fscmUI/adfAuthentication?level=FORM',
    ]), undefined);
});

test('pickIdentityDomain skips entries that are not URLs', () => {
    assert.equal(pickIdentityDomain(['', 'not a url', '/relative/path']), undefined);
});
