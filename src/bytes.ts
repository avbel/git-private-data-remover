// File content from git is handled as "byte strings": latin1-decoded strings
// whose code units map 1:1 to bytes. Decoding blobs as UTF-8 instead replaces
// every invalid sequence with U+FFFD, which silently corrupted the untouched
// lines of Latin-1, Shift-JIS or binary-ish files when they were written back.
export type ByteString = string;

export function bytesToByteString(bytes: Buffer): ByteString {
  return bytes.toString('latin1');
}

export function byteStringToBuffer(value: ByteString): Buffer {
  return Buffer.from(value, 'latin1');
}

export function textToByteString(text: string): ByteString {
  return Buffer.from(text, 'utf8').toString('latin1');
}

export function byteStringToText(value: ByteString): string {
  return Buffer.from(value, 'latin1').toString('utf8');
}

export function displayLine(value: ByteString): string {
  return byteStringToText(value).replace(/\r$/, '');
}

// A replacement typed at the prompt never carries the line terminator, so a
// CRLF line keeps its `\r` instead of turning into a mixed-ending file.
export function encodeReplacement(originalLine: ByteString, replacementText: string): ByteString {
  const encoded = textToByteString(replacementText);
  const keepCr = originalLine.endsWith('\r') && !encoded.endsWith('\r');
  return keepCr ? `${encoded}\r` : encoded;
}

const MIN_NEEDLE_BYTES = 6;

// The part of the line the user actually removed: what differs between the
// original and its replacement. Searching for this (instead of the whole line)
// also finds the secret where an older commit formatted the line differently.
// Too short a fragment would match unrelated content, so fall back to the
// whole trimmed line.
export function deriveNeedle(originalLine: ByteString, replacement: ByteString): ByteString | undefined {
  const original = originalLine.replace(/\r$/, '');
  const replaced = replacement.replace(/\r$/, '');
  let start = 0;

  while (start < original.length && start < replaced.length && original[start] === replaced[start]) {
    start++;
  }

  let end = 0;

  while (
    end < original.length - start &&
    end < replaced.length - start &&
    original[original.length - 1 - end] === replaced[replaced.length - 1 - end]
  ) {
    end++;
  }

  const removed = original.slice(start, original.length - end).trim();

  if (removed.length >= MIN_NEEDLE_BYTES) {
    return removed;
  }

  const whole = original.trim();
  return whole === '' ? undefined : whole;
}
