/**
 * Vitest setup: runs once before any test file is loaded.
 *
 * Polyfills the `File` global for Node versions below 20. undici (pulled in
 * transitively by cheerio and anything that touches global fetch) references
 * `File` at module-load time; on Node 18 that throws `ReferenceError: File is
 * not defined` before any test even runs. We map it to `buffer.File` which
 * has been available since Node 18.13.
 *
 * On Node 20+ the global is already present and this assignment is a no-op.
 */
import { File as BufferFile } from 'node:buffer';

if (typeof (globalThis as { File?: unknown }).File === 'undefined') {
  (globalThis as { File?: unknown }).File = BufferFile;
}
