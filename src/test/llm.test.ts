import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
    chatCompletionsUrl, cleanSql, DEFAULT_MODELS, PROVIDER_BASE_URLS, PROVIDER_KEY_URLS,
    PROVIDER_LABELS,
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

test('the OpenAI-shaped providers point at their own endpoints', () => {
    assert.equal(PROVIDER_BASE_URLS.xai, 'https://api.x.ai/v1');
    assert.equal(PROVIDER_BASE_URLS.deepseek, 'https://api.deepseek.com/v1');
    assert.equal(DEFAULT_MODELS.xai, 'grok-4');
    assert.equal(DEFAULT_MODELS.deepseek, 'deepseek-chat');
});

test('each provider posts to its own endpoint', () => {
    assert.equal(chatCompletionsUrl({ provider: 'openai' }),
        'https://api.openai.com/v1/chat/completions');
    assert.equal(chatCompletionsUrl({ provider: 'xai' }),
        'https://api.x.ai/v1/chat/completions');
    assert.equal(chatCompletionsUrl({ provider: 'deepseek' }),
        'https://api.deepseek.com/v1/chat/completions');
});

test('a base URL left over from another provider is ignored', () => {
    // Switching provider without clearing the setting must not send the new
    // key to the old address.
    assert.equal(chatCompletionsUrl({ provider: 'xai', baseUrl: 'http://localhost:11434/v1' }),
        'https://api.x.ai/v1/chat/completions');
    assert.equal(chatCompletionsUrl({ provider: 'deepseek', baseUrl: 'https://evil.example/v1' }),
        'https://api.deepseek.com/v1/chat/completions');
});

test('a compatible endpoint uses the configured URL, and insists on having one', () => {
    assert.equal(chatCompletionsUrl({ provider: 'compatible', baseUrl: 'http://localhost:11434/v1/' }),
        'http://localhost:11434/v1/chat/completions');
    assert.throws(() => chatCompletionsUrl({ provider: 'compatible' }), /baseUrl/);
});
