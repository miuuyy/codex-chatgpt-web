/** Fixed read-only program; arguments are data, never a model-authored command.
 * Dispatch must still use the current native harness's command tool and policy. */
const READ_PROGRAM = `import os, stat, sys, json, codecs
fd = None
try:
    path, offset, limit = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Only regular text files are supported')
    if offset > info.st_size:
        raise ValueError('Offset exceeds file size')
    os.lseek(fd, offset, os.SEEK_SET)
    data = os.read(fd, limit)
    final = offset + len(data) >= info.st_size
    decoder = codecs.getincrementaldecoder('utf-8')('strict')
    text = decoder.decode(data, final=final)
    pending = len(decoder.getstate()[0])
    consumed = len(data) - pending
    if '\\x00' in text:
        raise ValueError('Binary data is not supported')
    print(json.dumps({'text': text, 'offset': offset, 'bytes_read': consumed,
        'next_offset': offset + consumed, 'file_size': info.st_size,
        'truncated': offset + consumed < info.st_size}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({'error': type(error).__name__, 'message': str(error)}))
    sys.exit(2)
finally:
    if fd is not None:
        os.close(fd)
`;

function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

export function nativeTextReadCommand(path: string, offset = 0, maxBytes = 65_536): string {
  if (process.platform === "win32") throw new Error("Native text reading currently requires a POSIX command shell");
  if (!path || path.length > 16_384 || path.includes("\0")) throw new Error("Invalid text file path");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid byte offset");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 65_536) throw new Error("Read size must be 4 to 65536 bytes");
  return `/usr/bin/python3 -I -S -B -c ${quote(READ_PROGRAM)} ${quote(path)} ${offset} ${maxBytes}`;
}
