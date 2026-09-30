/**
 * Minimal zip archives for character downloads. Writes uncompressed ("stored") entries; reads
 * stored and deflated entries, so zips re-made by Windows Explorer or macOS still upload.
 */
class PhonebotZip {
    /** @type {Uint32Array|null} */
    static _crcTable = null;

    /** @param {Uint8Array} bytes @returns {number} */
    static _crc32(bytes) {
        let table = PhonebotZip._crcTable;
        if (!table) {
            table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                table[n] = c >>> 0;
            }
            PhonebotZip._crcTable = table;
        }
        let crc = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    /** @param {Blob|ArrayBuffer|Uint8Array|string} data @returns {Promise<Uint8Array>} */
    static async _toBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (typeof data === "string") return new TextEncoder().encode(data);
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        return new Uint8Array(await data.arrayBuffer());
    }

    /**
     * @param {{ path: string, data: Blob|ArrayBuffer|Uint8Array|string }[]} entries
     *   Paths use "/" separators; folders are implied by the paths.
     * @returns {Promise<Blob>}
     */
    static async create(entries) {
        const encoder = new TextEncoder();
        const now = new Date();
        const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        const UTF8_NAMES = 0x0800;
        const parts = [];
        const central = [];
        let offset = 0;
        for (const entry of entries) {
            const name = encoder.encode(String(entry.path).replace(/\\/g, "/").replace(/^\/+/, ""));
            const data = await PhonebotZip._toBytes(entry.data);
            const crc = PhonebotZip._crc32(data);

            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true);
            local.setUint16(4, 20, true);
            local.setUint16(6, UTF8_NAMES, true);
            local.setUint16(10, time, true);
            local.setUint16(12, date, true);
            local.setUint32(14, crc, true);
            local.setUint32(18, data.length, true);
            local.setUint32(22, data.length, true);
            local.setUint16(26, name.length, true);
            parts.push(local, name, data);

            const header = new DataView(new ArrayBuffer(46));
            header.setUint32(0, 0x02014b50, true);
            header.setUint16(4, 20, true);
            header.setUint16(6, 20, true);
            header.setUint16(8, UTF8_NAMES, true);
            header.setUint16(12, time, true);
            header.setUint16(14, date, true);
            header.setUint32(16, crc, true);
            header.setUint32(20, data.length, true);
            header.setUint32(24, data.length, true);
            header.setUint16(28, name.length, true);
            header.setUint32(42, offset, true);
            central.push(header, name);
            offset += 30 + name.length + data.length;
        }
        const centralSize = central.reduce((n, part) => n + part.byteLength, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true);
        end.setUint32(12, centralSize, true);
        end.setUint32(16, offset, true);
        return new Blob([...parts, ...central, end], { type: "application/zip" });
    }

    /**
     * @param {Blob|ArrayBuffer} source
     * @returns {Promise<Map<string, Blob>>} File contents by path; folder entries are skipped.
     */
    static async read(source) {
        const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);
        let end = -1;
        const stop = Math.max(0, buffer.byteLength - 22 - 0xffff);
        for (let i = buffer.byteLength - 22; i >= stop; i--) {
            if (view.getUint32(i, true) === 0x06054b50) {
                end = i;
                break;
            }
        }
        if (end < 0) throw new Error("Not a zip file.");
        const count = view.getUint16(end + 10, true);
        let ptr = view.getUint32(end + 16, true);
        if (count === 0xffff || ptr === 0xffffffff) throw new Error("Zip64 archives are not supported.");
        const decoder = new TextDecoder();
        /** @type {Map<string, Blob>} */
        const files = new Map();
        for (let i = 0; i < count; i++) {
            if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error("Corrupt zip directory.");
            const method = view.getUint16(ptr + 10, true);
            const size = view.getUint32(ptr + 20, true);
            const nameLength = view.getUint16(ptr + 28, true);
            const extraLength = view.getUint16(ptr + 30, true);
            const commentLength = view.getUint16(ptr + 32, true);
            const localOffset = view.getUint32(ptr + 42, true);
            const name = decoder
                .decode(bytes.subarray(ptr + 46, ptr + 46 + nameLength))
                .replace(/\\/g, "/");
            ptr += 46 + nameLength + extraLength + commentLength;
            if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
            // Sizes come from the central directory: local headers may defer them to a data descriptor.
            const start =
                localOffset +
                30 +
                view.getUint16(localOffset + 26, true) +
                view.getUint16(localOffset + 28, true);
            const raw = bytes.subarray(start, start + size);
            if (method === 0) files.set(name, new Blob([raw]));
            else if (method === 8) files.set(name, await PhonebotZip._inflate(raw));
            else throw new Error(`Unsupported compression for ${name}.`);
        }
        return files;
    }

    /** @param {Uint8Array} raw @returns {Promise<Blob>} */
    static async _inflate(raw) {
        if (typeof DecompressionStream !== "function") {
            throw new Error("This browser cannot open compressed zip files.");
        }
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Response(stream).blob();
    }

    /** @param {Blob} blob @param {string} filename */
    static download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
}

window.PhonebotZip = PhonebotZip;
