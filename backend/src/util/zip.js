// Minimal ZIP writer — enough to package the Forge Growth plugin for download.
//
// WHY HAND-ROLLED: the plugin is ~40 KB of markdown. Pulling in archiver (and its
// dependency tree) to compress text that compresses to nothing would add real
// install weight for no benefit. Entries are written with method 0 (STORED, no
// compression), which every unzip implementation on every OS opens natively.
//
// Deliberately NOT a general-purpose zip library: no directories entries, no
// zip64, no encryption, no streaming. It packages a handful of small text files
// and nothing else. If this ever needs to carry something big or binary-heavy,
// reach for a real library rather than growing this one.

const zlib = require('node:zlib');

// CRC-32 (the polynomial ZIP uses). Table built once at require time.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ZIP stores timestamps as MS-DOS date/time. A fixed timestamp keeps the archive
// byte-identical between downloads, which makes "did this change?" answerable by
// comparing bytes rather than by unpacking.
const DOS_TIME = 0;      // 00:00:00
const DOS_DATE = 0x2821; // 2000-01-01

/**
 * Build a ZIP archive in memory.
 * @param {{name: string, data: string|Buffer}[]} files - paths use forward slashes.
 * @returns {Buffer}
 */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: bit 11 = UTF-8 names
    local.writeUInt16LE(0, 8);            // method 0 = stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size == size (stored)
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length

    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central directory signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comment
    cd.writeUInt16LE(0, 34);              // disk number
    cd.writeUInt16LE(0, 36);              // internal attrs
    // External attrs: regular file, rw-r--r--. The `>>> 0` is load-bearing —
    // JS `<<` yields a SIGNED 32-bit int, and 0o100644 << 16 overflows past
    // 2^31 into a negative number that writeUInt32LE rejects outright.
    cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
    cd.writeUInt32LE(offset, 42);         // offset of local header
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);                // disk
  end.writeUInt16LE(0, 6);                // disk with CD
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}

module.exports = { makeZip, crc32, gzip: zlib.gzipSync };
