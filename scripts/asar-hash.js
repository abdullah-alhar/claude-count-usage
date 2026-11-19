const fs = require('fs');
const crypto = require('crypto');

const fd = fs.openSync(process.argv[2], 'r');
try {
  const prefix = Buffer.alloc(16);
  if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length) {
    throw new Error('Incomplete ASAR prefix');
  }
  const length = prefix.readUInt32LE(12);
  if (length === 0 || length > fs.fstatSync(fd).size - 16) {
    throw new Error('Invalid ASAR header length');
  }
  const header = Buffer.alloc(length);
  if (fs.readSync(fd, header, 0, length, 16) !== length) {
    throw new Error('Incomplete ASAR header');
  }
  console.log(crypto.createHash('sha256').update(header).digest('hex'));
} finally {
  fs.closeSync(fd);
}
