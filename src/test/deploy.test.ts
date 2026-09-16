import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildProxyObjects, repointReport } from '../deploy';
import { readZip, writeZip } from '../zip';

const template = () => fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'FusionQueryProxy.xdrz'));

test('writeZip round-trips through readZip', () => {
    const entries = [
        { name: 'a.txt', data: Buffer.from('hello hello hello hello hello', 'utf8') },
        { name: 'nested/b.bin', data: Buffer.from([0, 1, 2, 250, 255]) },
        { name: 'empty/', data: Buffer.alloc(0) },
    ];
    assert.deepEqual(readZip(writeZip(entries)), entries);
});

test('archives written here are readable by the system unzip', () => {
    const zip = writeZip([{ name: 'x.txt', data: Buffer.from('round trip', 'utf8') }]);
    const file = path.join(require('node:os').tmpdir(), `fusion-zip-${process.pid}.zip`);
    fs.writeFileSync(file, zip);
    try {
        const listing = require('node:child_process').execSync(`unzip -l ${file}`).toString();
        assert.match(listing, /x\.txt/);
        const content = require('node:child_process').execSync(`unzip -p ${file} x.txt`).toString();
        assert.equal(content, 'round trip');
    } finally {
        fs.unlinkSync(file);
    }
});

test('the bundled template carries both catalog objects', () => {
    const names = readZip(template()).map((e) => e.name);
    assert.ok(names.some((n) => n.endsWith('dm.xdmz')), `no data model in ${names.join(', ')}`);
    assert.ok(names.some((n) => n.endsWith('csv.xdoz')), `no report in ${names.join(', ')}`);
});

test('buildProxyObjects names objects the way BI Publisher expects', () => {
    const objects = buildProxyObjects(template(), '/~FUSION_USER/FusionQuery/v1');
    assert.equal(objects.dataModelPath, '/~FUSION_USER/FusionQuery/v1/dm.xdm');
    assert.equal(objects.reportPath, '/~FUSION_USER/FusionQuery/v1/csv.xdo');
    assert.ok(objects.dataModel.length > 0);
    assert.ok(objects.report.length > 0);
});

test('the deployed report points at the data model it was deployed beside', () => {
    const folder = '/~FUSION_USER/FusionQuery/v1';
    const objects = buildProxyObjects(template(), folder);
    const xml = readZip(objects.report).find((e) => e.name === '_report.xdo')!.data.toString('utf8');
    assert.match(xml, new RegExp(`<dataModel\\s+url="${folder}/dm\\.xdm"`));
    // and the original location is gone, not merely duplicated
    assert.equal((xml.match(/<dataModel\s+url="/g) ?? []).length, 1);
});

test('repointReport refuses a template whose data model reference is missing', () => {
    const broken = writeZip([{ name: '_report.xdo', data: Buffer.from('<report/>', 'utf8') }]);
    assert.throws(() => repointReport(broken, '/x/dm.xdm'), /data model reference/);
});
