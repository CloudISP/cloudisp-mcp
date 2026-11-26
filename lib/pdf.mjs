/**
 * HTML to PDF with headless Chromium (`CLOUDISP_CHROMIUM_BIN`, `chromium` by default).
 *
 * `--no-sandbox` is needed because the unprivileged LXC where the bot runs has no user namespaces; the HTML is
 * self-generated, with a CSP that blocks every request, so nothing untrusted is ever rendered. Every run gets its own
 * profile directory: a second Chromium on a shared profile would hand the page over to the first one and exit.
 */

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Longest a conversion may take. */
const PDF_TIMEOUT_MS = 60000;

/**
 * Print a local HTML file to A4 PDF.
 *
 * @param {string} htmlPath Absolute path of the HTML file.
 * @param {string} pdfPath Absolute path of the PDF to write.
 * @param {Record<string, string|undefined>} [env] Environment bag (`CLOUDISP_CHROMIUM_BIN`).
 * @return {Promise<void>} Resolves when `pdfPath` exists with content; rejects when Chromium is missing, fails or writes nothing.
 */
export async function htmlToPdf(htmlPath, pdfPath, env = process.env) {
    const profile = mkdtempSync(join(tmpdir(), 'cloudisp-chromium-'));

    try {
        await run(env.CLOUDISP_CHROMIUM_BIN || 'chromium', [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--no-pdf-header-footer',
            `--user-data-dir=${profile}`,
            `--print-to-pdf=${pdfPath}`,
            pathToFileURL(htmlPath).href,
        ], { timeout: PDF_TIMEOUT_MS });

        if (statSync(pdfPath).size === 0) {
            throw new Error('Chromium wrote an empty PDF.');
        }

        chmodSync(pdfPath, 0o600);
    } catch (error) {
        rmSync(pdfPath, { force: true });

        throw error;
    } finally {
        rmSync(profile, { recursive: true, force: true });
    }
}
