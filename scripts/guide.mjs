#!/usr/bin/env node
/**
 * Regenerate the plugin files that come from the tool catalogue (`npm run guide`):
 *
 *   hermes-plugin/cloudisp/guia.md          what `/guia` answers
 *   hermes-plugin/cloudisp/write_tools.json the write tools the plugin sends to human approval
 *
 * The tests regenerate both in memory and fail when the files on disk differ.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderGuide, renderWriteTools } from '../lib/guide.mjs';
import { guideCatalog } from '../server.mjs';

const PLUGIN_DIR = new URL('../hermes-plugin/cloudisp/', import.meta.url);
const catalog = guideCatalog();

for (const [file, content] of [['guia.md', renderGuide(catalog)], ['write_tools.json', renderWriteTools(catalog)]]) {
    writeFileSync(new URL(file, PLUGIN_DIR), content);
    console.log(`escrito ${fileURLToPath(new URL(file, PLUGIN_DIR))}`);
}
