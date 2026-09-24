import { Readable } from 'node:stream';

export const HEADER = 'store_id,store_name,address,city,state,country';

export function csvStream(text: string): Readable {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

/** Builds a multipart/form-data body by hand so tests don't need an extra dependency. */
export function multipartBody(
  filename: string,
  content: string | Buffer,
  field = 'file',
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----tierforge-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
        'Content-Type: text/csv\r\n\r\n',
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
