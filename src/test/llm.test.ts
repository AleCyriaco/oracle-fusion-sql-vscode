import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cleanSql, DEFAULT_MODELS, PROVIDER_LABELS } from '../llm';

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

test('every provider has a label, and only the compatible one lacks a default model', () => {
    for (const id of Object.keys(PROVIDER_LABELS) as (keyof typeof PROVIDER_LABELS)[]) {
        assert.ok(PROVIDER_LABELS[id].length > 0, `no label for ${id}`);
        assert.equal(typeof DEFAULT_MODELS[id], 'string');
    }
    assert.equal(DEFAULT_MODELS.anthropic, 'claude-opus-5');
    assert.equal(DEFAULT_MODELS.compatible, '', 'a compatible endpoint cannot have a default model');
});
