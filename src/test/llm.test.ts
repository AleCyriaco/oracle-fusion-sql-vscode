import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
    buildPrompt, chatCompletionsUrl, cleanSql, DEFAULT_MODELS, firstOracleError, PROVIDER_BASE_URLS,
    PROVIDER_KEY_URLS, PROVIDER_LABELS,
} from '../llm';

test('cleanSql strips a fenced block the model added anyway', () => {
    assert.equal(cleanSql('```sql\nSELECT 1 FROM dual\n```'), 'SELECT 1 FROM dual');
    assert.equal(cleanSql('```\nSELECT 1 FROM dual\n```'), 'SELECT 1 FROM dual');
    assert.equal(cleanSql('  SELECT 1 FROM dual  '), 'SELECT 1 FROM dual');
});

test('cleanSql drops the trailing semicolon the transport rejects', () => {
    assert.equal(cleanSql('SELECT 1 FROM dual;'), 'SELECT 1 FROM dual');
    assert.equal(cleanSql('```sql\nSELECT 1 FROM dual;\n```'), 'SELECT 1 FROM dual');
});

test('cleanSql keeps a leading comment and inner structure', () => {
    const sql = '-- unpaid invoices\nSELECT a.invoice_num,\n       a.invoice_amount\n  FROM ap_invoices_all a';
    assert.equal(cleanSql('```sql\n' + sql + '\n```'), sql);
});

test('cleanSql leaves a semicolon inside a string literal alone', () => {
    assert.equal(cleanSql("SELECT ';' FROM dual"), "SELECT ';' FROM dual");
});

test('every provider is fully described, and only the compatible one is blank', () => {
    const ids = Object.keys(PROVIDER_LABELS) as (keyof typeof PROVIDER_LABELS)[];
    assert.deepEqual(ids.sort(), ['anthropic', 'compatible', 'deepseek', 'openai', 'xai']);
    for (const id of ids) {
        assert.ok(PROVIDER_LABELS[id].length > 0, `no label for ${id}`);
        assert.equal(typeof DEFAULT_MODELS[id], 'string', `no model entry for ${id}`);
        assert.equal(typeof PROVIDER_BASE_URLS[id], 'string', `no base url entry for ${id}`);
        assert.equal(typeof PROVIDER_KEY_URLS[id], 'string', `no key url entry for ${id}`);
        if (id === 'compatible') { continue; }
        // A named provider must be usable with nothing but a key.
        assert.ok(DEFAULT_MODELS[id], `${id} needs a default model`);
        assert.match(PROVIDER_BASE_URLS[id], /^https:\/\//, `${id} needs an https endpoint`);
        assert.match(PROVIDER_KEY_URLS[id], /^https:\/\//, `${id} should say where to get a key`);
    }
    assert.equal(DEFAULT_MODELS.compatible, '', 'a compatible endpoint cannot have a default model');
    assert.equal(PROVIDER_BASE_URLS.compatible, '', 'a compatible endpoint has no fixed address');
});

test('the OpenAI-shaped providers point where their own docs say', () => {
    // Endpoints taken from each provider's quickstart, not inferred from OpenAI's.
    assert.equal(PROVIDER_BASE_URLS.openai, 'https://api.openai.com/v1');
    assert.equal(PROVIDER_BASE_URLS.xai, 'https://api.x.ai/v1');
    assert.equal(PROVIDER_BASE_URLS.deepseek, 'https://api.deepseek.com',
        'DeepSeek serves chat completions at the root, not under /v1');
});

test('default models are the current flagships', () => {
    assert.equal(DEFAULT_MODELS.anthropic, 'claude-opus-5');
    assert.equal(DEFAULT_MODELS.openai, 'gpt-5.6-sol');
    assert.equal(DEFAULT_MODELS.xai, 'grok-4.6');
    assert.equal(DEFAULT_MODELS.deepseek, 'deepseek-v4-pro');
});

test('each provider posts to its own endpoint', () => {
    assert.equal(chatCompletionsUrl({ provider: 'openai' }),
        'https://api.openai.com/v1/chat/completions');
    assert.equal(chatCompletionsUrl({ provider: 'xai' }),
        'https://api.x.ai/v1/chat/completions');
    assert.equal(chatCompletionsUrl({ provider: 'deepseek' }),
        'https://api.deepseek.com/chat/completions');
});

test('a base URL left over from another provider is ignored', () => {
    // Switching provider without clearing the setting must not send the new
    // key to the old address.
    assert.equal(chatCompletionsUrl({ provider: 'xai', baseUrl: 'http://localhost:11434/v1' }),
        'https://api.x.ai/v1/chat/completions');
    assert.equal(chatCompletionsUrl({ provider: 'deepseek', baseUrl: 'https://evil.example/v1' }),
        'https://api.deepseek.com/chat/completions');
});

test('a compatible endpoint uses the configured URL, and insists on having one', () => {
    assert.equal(chatCompletionsUrl({ provider: 'compatible', baseUrl: 'http://localhost:11434/v1/' }),
        'http://localhost:11434/v1/chat/completions');
    assert.throws(() => chatCompletionsUrl({ provider: 'compatible' }), /baseUrl/);
});

test('firstOracleError digs the ORA- line out of BI Publisher wrapping', () => {
    const wrapped = 'runReport failed: PublicReportService::generateReport for reportAbsolutePath '
        + '[/~USER/FusionQuery/v1/csv.xdo] failed: due to oracle.xdo.server.ServerException: '
        + 'oracle.xdo.servlet.data.DataException: java.sql.SQLSyntaxErrorException: '
        + 'ORA-00942: table or view does not exist\nORA-06512: at line 5';
    assert.equal(firstOracleError(wrapped), 'ORA-00942: table or view does not exist');
});

test('firstOracleError falls back to the first line when nothing is Oracle', () => {
    assert.equal(firstOracleError('Timed out after 120s.\nstack frame'), 'Timed out after 120s.');
});

test('a fresh request is sent as the user wrote it', () => {
    assert.equal(buildPrompt({ request: 'ten suppliers' }), 'ten suppliers');
});

test('a follow-up carries the statement so it reads as an edit', () => {
    const prompt = buildPrompt({ request: 'group by supplier', current: 'SELECT 1 FROM dual' });
    assert.match(prompt, /Current statement:/);
    assert.match(prompt, /SELECT 1 FROM dual/);
    assert.match(prompt, /group by supplier/);
});

test('a rejected statement is sent back with the database error verbatim', () => {
    const prompt = buildPrompt({
        request: 'ten users',
        current: 'SELECT * FROM per_userz',
        databaseError: 'ORA-00942: table or view does not exist',
    });
    assert.match(prompt, /rejected by the database/);
    assert.match(prompt, /SELECT \* FROM per_userz/);
    assert.match(prompt, /ORA-00942/);
    // The instruction that keeps a repair narrow instead of a rewrite.
    assert.match(prompt, /correct that identifier/);
});
