/**
 * Agent Skills spec checks for every skills/<name>/SKILL.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('./skills/', import.meta.url);

for (const dir of fs.readdirSync(root)) {
    test(`skill ${dir} follows the Agent Skills spec`, () => {
        const text = fs.readFileSync(new URL(`${dir}/SKILL.md`, root), 'utf8');
        const lines = text.split('\n');
        assert.equal(lines[0], '---');
        const end = lines.indexOf('---', 1);
        assert.ok(end > 0, 'frontmatter is closed');

        const meta = Object.fromEntries(lines.slice(1, end).map((line) => {
            const at = line.indexOf(':');
            return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')];
        }));

        assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
        assert.ok(meta.name.length <= 64);
        assert.equal(meta.name, dir);
        assert.ok(meta.description.length >= 1 && meta.description.length <= 1024);
        assert.ok(lines.length - end - 1 < 500);
    });
}
