/**
 * Just enough ZIP to read the bundled proxy template and repack one entry of it.
 *
 * BI Publisher catalog objects are zips inside a zip, and deploying the proxy
 * means rewriting one XML file in the middle. Node ships deflate but no archive
 * format, and a dependency for two functions would not earn its keep.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export type ZipEntry = { name: string; data: Buffer };

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

export function readZip(buffer: Buffer): ZipEntry[] {
    const end = findEndOfCentralDirectory(buffer);
    const count = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);

    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
            throw new Error('Damaged archive: central directory entry not found.');
        }
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

        // The local header's own name/extra lengths are authoritative for where
        // the bytes start — they can differ from the central directory's.
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(start, start + compressedSize);

        entries.push({ name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

export function writeZip(entries: ZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const deflated = deflateRawSync(entry.data);
        // A directory entry (or anything deflate makes bigger) is stored as-is.
        const stored = entry.data.length === 0 || deflated.length >= entry.data.length;
        const payload = stored ? entry.data : deflated;
        const method = stored ? 0 : 8;
        const crc = crc32(entry.data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL_SIGNATURE, 0);
        local.writeUInt16LE(20, 4);              // version needed
        local.writeUInt16LE(0, 6);               // flags
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, payload);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
        central.writeUInt16LE(20, 4);            // version made by
        central.writeUInt16LE(20, 6);            // version needed
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);

        offset += local.length + name.length + payload.length;
    }

    const centralBuffer = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIGNATURE, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, centralBuffer, end]);
}

/** Scan backwards: the end record is last, but a trailing comment may follow it. */
function findEndOfCentralDirectory(buffer: Buffer): number {
    for (let i = buffer.length - 22; i >= 0; i--) {
        if (buffer.readUInt32LE(i) === END_SIGNATURE) { return i; }
    }
    throw new Error('Not a ZIP archive: end-of-central-directory record missing.');
}

let crcTable: Uint32Array | undefined;

function crc32(data: Buffer): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
            crcTable[i] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (const byte of data) { crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); }
    return (crc ^ 0xffffffff) >>> 0;
}
