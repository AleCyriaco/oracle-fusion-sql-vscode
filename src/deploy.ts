/**
 * Building the two catalog objects that make up the proxy report.
 *
 * The bundled template was authored at a fixed catalog location, and the report
 * points at its data model by absolute path — so both objects have to be
 * rewritten for wherever this connection is deploying them, or the report
 * uploads cleanly and then fails at run time with a missing data model.
 */
import { readZip, writeZip } from './zip';

export type ProxyObjects = {
    dataModelPath: string;
    dataModel: Buffer;
    reportPath: string;
    report: Buffer;
};

/**
 * @param archive  the bundled .xdrz
 * @param folder   target folder, e.g. /~FUSION_USER/FusionQuery/v1
 */
export function buildProxyObjects(archive: Buffer, folder: string): ProxyObjects {
    const entries = readZip(archive);
    const dataModel = entries.find((e) => e.name.endsWith('dm.xdmz'));
    const report = entries.find((e) => e.name.endsWith('csv.xdoz'));
    if (!dataModel || !report) {
        throw new Error('The bundled proxy template is missing dm.xdmz or csv.xdoz.');
    }

    const dataModelPath = `${folder}/dm.xdm`;
    return {
        dataModelPath,
        dataModel: dataModel.data,
        reportPath: `${folder}/csv.xdo`,
        report: repointReport(report.data, dataModelPath),
    };
}

/** Rewrite <dataModel url="..."> inside the report archive's _report.xdo. */
export function repointReport(reportArchive: Buffer, dataModelPath: string): Buffer {
    const entries = readZip(reportArchive);
    let patched = false;
    const rewritten = entries.map((entry) => {
        if (entry.name !== '_report.xdo') { return entry; }
        const xml = entry.data.toString('utf8');
        const next = xml.replace(/(<dataModel\s+url=")[^"]*(")/, `$1${dataModelPath}$2`);
        patched = next !== xml;
        return { name: entry.name, data: Buffer.from(next, 'utf8') };
    });
    if (!patched) {
        throw new Error('Could not find the data model reference inside the proxy report template.');
    }
    return writeZip(rewritten);
}
