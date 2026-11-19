// Zero-dependency client-side ZIP generator using Store (Method 0) compression.
// Optimal for pre-compressed media like JPEG and PNG images.

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2)) &
    0xffff;
  const dosDate =
    (((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate()) &
    0xffff;
  return { dosTime, dosDate };
}

/**
 * Creates a standard PKZip archive blob from a list of files.
 * @param {Array<{ name: string, data: Uint8Array | Blob }>} files
 * @returns {Promise<Blob>}
 */
export async function createZipArchive(files) {
  const now = new Date();
  const { dosTime, dosDate } = getDosDateTime(now);
  const textEncoder = new TextEncoder();

  // Normalize all file data to Uint8Array and compute metadata
  const entries = [];
  for (const file of files) {
    let u8;
    if (file.data instanceof Uint8Array) {
      u8 = file.data;
    } else if (file.data instanceof Blob) {
      u8 = new Uint8Array(await file.data.arrayBuffer());
    } else if (file.data instanceof ArrayBuffer) {
      u8 = new Uint8Array(file.data);
    } else {
      throw new Error(`Unsupported file data type for ${file.name}`);
    }

    const nameBytes = textEncoder.encode(file.name);
    const checksum = crc32(u8);
    entries.push({
      nameBytes,
      data: u8,
      crc: checksum,
      size: u8.length,
    });
  }

  // Calculate total buffer size
  let localHeadersTotal = 0;
  let centralDirTotal = 0;
  for (const entry of entries) {
    localHeadersTotal += 30 + entry.nameBytes.length + entry.size;
    centralDirTotal += 46 + entry.nameBytes.length;
  }
  const eocdTotal = 22;
  const totalLength = localHeadersTotal + centralDirTotal + eocdTotal;

  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  // 1. Write Local File Headers and file payloads
  const localOffsets = [];
  for (const entry of entries) {
    localOffsets.push(offset);

    // Signature 0x04034b50
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 10, true); // Version needed (1.0)
    view.setUint16(offset + 6, 0x0800, true); // Bit 11: UTF-8 filename flag
    view.setUint16(offset + 8, 0, true); // Compression: 0 (Store)
    view.setUint16(offset + 10, dosTime, true);
    view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.size, true); // Compressed size
    view.setUint32(offset + 22, entry.size, true); // Uncompressed size
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // Extra field length

    offset += 30;
    buffer.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;

    buffer.set(entry.data, offset);
    offset += entry.size;
  }

  // 2. Write Central Directory Headers
  const centralDirStartOffset = offset;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const localOffset = localOffsets[i];

    // Signature 0x02014b50
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true); // Version made by (2.0)
    view.setUint16(offset + 6, 10, true); // Version needed (1.0)
    view.setUint16(offset + 8, 0x0800, true); // Bit 11: UTF-8 filename flag
    view.setUint16(offset + 10, 0, true); // Compression: 0 (Store)
    view.setUint16(offset + 12, dosTime, true);
    view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.size, true);
    view.setUint32(offset + 24, entry.size, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // Extra field length
    view.setUint16(offset + 32, 0, true); // Comment length
    view.setUint16(offset + 34, 0, true); // Disk number start
    view.setUint16(offset + 36, 0, true); // Internal attributes
    view.setUint32(offset + 38, 0, true); // External attributes
    view.setUint32(offset + 42, localOffset, true); // Offset of local header

    offset += 46;
    buffer.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  }

  const centralDirSize = offset - centralDirStartOffset;

  // 3. Write End of Central Directory Record (EOCD)
  view.setUint32(offset, 0x06054b50, true); // Signature 0x06054b50
  view.setUint16(offset + 4, 0, true); // Disk number
  view.setUint16(offset + 6, 0, true); // Start disk
  view.setUint16(offset + 8, entries.length, true); // Disk records
  view.setUint16(offset + 10, entries.length, true); // Total records
  view.setUint32(offset + 12, centralDirSize, true); // Central dir size
  view.setUint32(offset + 16, centralDirStartOffset, true); // Central dir offset
  view.setUint16(offset + 20, 0, true); // Comment length

  return new Blob([buffer], { type: "application/zip" });
}
