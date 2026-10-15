/**
 * Self-contained Spanish HTML report for the `build_report` tool: logo (data URI), brand palette,
 * print CSS and inline SVG charts. No scripts, no external requests, no dependencies.
 */

import { LOGO_DATA_URI } from './logo.mjs';
import { escapeHtml, formatValue, renderChart } from './svg-charts.mjs';

export const MAX_SECTIONS = 20;
export const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 12;
const MAX_KPIS = 12;
const MAX_SERIES = 8;
const MAX_CATEGORIES = 60;
const NO_DATA = 'no disponible';
const TIME_ZONE = 'America/Argentina/Salta';

/** A report argument that does not fit the schema; the tool answers it as `validation_failed`. */
export class ReportInputError extends Error {}

const CLOCK = new Intl.DateTimeFormat('es-AR', {
    timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/**
 * @param {Date} date Instant.
 * @return {string} `DD/MM/YYYY HH:MM` in Argentina (Salta) time.
 */
export function formatArgentinaTime(date) {
    const parts = Object.fromEntries(CLOCK.formatToParts(date).map((part) => [part.type, part.value]));

    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * @param {boolean} condition Must hold.
 * @param {string} message Failure reason.
 * @return {void}
 */
function check(condition, message) {
    if (!condition) {
        throw new ReportInputError(message);
    }
}

/**
 * @param {unknown} value Candidate.
 * @param {string} name Field name for the message.
 * @param {number} max Longest accepted length.
 * @return {string} The trimmed text.
 */
function requireText(value, name, max) {
    check(typeof value === 'string' && value.trim() !== '' && value.length <= max, `${name} is required: a non-empty string of at most ${max} characters.`);

    return value.trim();
}

/**
 * @param {unknown} value Candidate.
 * @param {string} name Field name for the message.
 * @param {number} max Longest accepted length.
 * @return {string|undefined} The trimmed text, or undefined when absent.
 */
function optionalText(value, name, max) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    check(typeof value === 'string' && value.length <= max, `${name} must be a string of at most ${max} characters.`);

    return value.trim();
}

/**
 * @param {unknown} value Candidate cell, KPI value or category.
 * @param {string} where Location for the message.
 * @return {string|null} Display text, or null when there is no data.
 */
function cell(value, where) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    if (typeof value === 'number') {
        check(Number.isFinite(value), `${where} must be a finite number.`);

        return formatValue(value);
    }

    check(typeof value === 'string' || typeof value === 'boolean', `${where} must be a string, number, boolean or null.`);

    return String(value);
}

/**
 * @param {unknown} raw Candidate chart.
 * @param {string} where Location for the message.
 * @return {object} Validated chart.
 */
function normalizeChart(raw, where) {
    check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), `${where} must be an object.`);
    check(['bar', 'line', 'donut'].includes(raw.type), `${where}.type must be bar, line or donut.`);
    check(Array.isArray(raw.categories) && raw.categories.length >= 1 && raw.categories.length <= MAX_CATEGORIES, `${where}.categories must have 1 to ${MAX_CATEGORIES} items.`);
    check(Array.isArray(raw.series) && raw.series.length >= 1 && raw.series.length <= MAX_SERIES, `${where}.series must have 1 to ${MAX_SERIES} items.`);
    check(raw.type !== 'donut' || raw.series.length === 1, `${where}.series must have exactly one series for a donut.`);

    const categories = raw.categories.map((category, index) => cell(category, `${where}.categories[${index}]`) ?? NO_DATA);
    const series = raw.series.map((item, index) => {
        const name = requireText(item?.name, `${where}.series[${index}].name`, 80);

        check(Array.isArray(item.data) && item.data.length === categories.length, `${where}.series[${index}].data must have one value per category (${categories.length}); use null for a missing value.`);

        const data = item.data.map((value, position) => {
            if (value === null || value === undefined) {
                return null;
            }

            check(typeof value === 'number' && Number.isFinite(value), `${where}.series[${index}].data[${position}] must be a number or null.`);
            check(raw.type !== 'donut' || value >= 0, `${where}.series[${index}].data[${position}] must not be negative in a donut.`);

            return value;
        });

        return { name, data };
    });

    return { type: raw.type, categories, series, unit: optionalText(raw.unit, `${where}.unit`, 20) ?? '' };
}

/**
 * @param {unknown} raw Candidate table.
 * @param {string} where Location for the message.
 * @return {{ columns: string[], rows: Array<Array<string|null>> }} Validated table.
 */
function normalizeTable(raw, where) {
    check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), `${where} must be an object.`);
    check(Array.isArray(raw.columns) && raw.columns.length >= 1 && raw.columns.length <= MAX_TABLE_COLUMNS, `${where}.columns must have 1 to ${MAX_TABLE_COLUMNS} items.`);
    check(Array.isArray(raw.rows) && raw.rows.length <= MAX_TABLE_ROWS, `${where}.rows must be an array of at most ${MAX_TABLE_ROWS} rows.`);

    const columns = raw.columns.map((column, index) => requireText(column, `${where}.columns[${index}]`, 80));
    const rows = raw.rows.map((row, index) => {
        check(Array.isArray(row) && row.length === columns.length, `${where}.rows[${index}] must have exactly ${columns.length} cells (one per column); use null for a missing value.`);

        return row.map((value, position) => cell(value, `${where}.rows[${index}][${position}]`));
    });

    return { columns, rows };
}

/**
 * Validate and normalise the `build_report` arguments.
 *
 * @param {object} args Tool arguments.
 * @return {object} Normalised report.
 * @throws {ReportInputError} When an argument does not fit the schema.
 */
export function normalizeReport(args) {
    const title = requireText(args.title, 'title', 200);
    const subtitle = optionalText(args.subtitle, 'subtitle', 300);

    check(Array.isArray(args.sections) && args.sections.length >= 1 && args.sections.length <= MAX_SECTIONS, `sections must have 1 to ${MAX_SECTIONS} items.`);

    const sections = args.sections.map((raw, index) => {
        const where = `sections[${index}]`;

        check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), `${where} must be an object.`);

        const section = { heading: requireText(raw.heading, `${where}.heading`, 200), text: optionalText(raw.text, `${where}.text`, 5000) };

        if (raw.kpis !== undefined && raw.kpis !== null) {
            check(Array.isArray(raw.kpis) && raw.kpis.length <= MAX_KPIS, `${where}.kpis must be an array of at most ${MAX_KPIS} items.`);
            section.kpis = raw.kpis.map((kpi, position) => ({
                label: requireText(kpi?.label, `${where}.kpis[${position}].label`, 80),
                value: cell(kpi?.value, `${where}.kpis[${position}].value`),
            }));
        }

        if (raw.table !== undefined && raw.table !== null) {
            section.table = normalizeTable(raw.table, `${where}.table`);
        }

        if (raw.chart !== undefined && raw.chart !== null) {
            section.chart = normalizeChart(raw.chart, `${where}.chart`);
        }

        return section;
    });

    return { title, subtitle, sections };
}

const STYLE = `
:root{--bg:#faf7fc;--ink:#261d33;--mut:#6b5c7b;--line:#e6dfeb;--pink:#c026a3;--pink-soft:#f6e8f4;--dark:#0f0b14}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.top{background:var(--dark);color:#f3eef7;padding:28px 6vw;border-bottom:4px solid #ff4fd8;display:flex;gap:24px;align-items:center;flex-wrap:wrap}
.logo{height:34px;width:auto}
.top h1{font-size:1.5rem;line-height:1.2}
.sub{color:#a99bb8;margin-top:4px}
main{max-width:980px;margin:0 auto;padding:24px 6vw 8px}
section{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:18px}
h2{font-size:1.15rem;color:var(--pink);margin-bottom:10px}
p{margin:0 0 10px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:8px 0 14px}
.kpi{background:var(--pink-soft);border-radius:10px;padding:12px 14px}
.kpi b{display:block;font-size:1.5rem;line-height:1.2}
.kpi span{color:var(--mut);font-size:.85rem}
.kpi .nd,td.nd{color:var(--mut);font-style:italic;font-weight:400;font-size:1rem}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:.9rem}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left}
th{background:var(--pink-soft);color:#86198f}
tbody tr:nth-child(even){background:#fcf9fd}
.chart{margin:8px 0 14px}
.chart svg{width:100%;height:auto;display:block}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:6px;font-size:.88rem}
.sw{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
figcaption{color:var(--mut);font-size:.82rem;margin-top:6px}
footer{max-width:980px;margin:0 auto;padding:6px 6vw 28px;color:var(--mut);font-size:.82rem}
@media print{
 @page{size:A4;margin:12mm}
 body{background:#fff}
 .top{padding:16px 0 14px}
 main{padding:14px 0 0;max-width:none}
 section{break-inside:avoid-page;border-radius:0}
 table,figure{break-inside:avoid}
 tr{break-inside:avoid}
 .scroll{overflow:visible}
 footer{padding:6px 0 0}
}
`.replace(/\n\s*/g, '\n').trim();

/**
 * @param {string} text Plain text with optional blank-line paragraphs.
 * @return {string} Escaped paragraphs.
 */
function paragraphs(text) {
    return text.split(/\n{2,}/).map((block) => `<p>${escapeHtml(block.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * @param {string|null} value Display text or null.
 * @param {string} tag `td` or `b`.
 * @return {string} Element, with the no-data marker when null.
 */
function valueElement(value, tag) {
    return value === null ? `<${tag} class="nd">${NO_DATA}</${tag}>` : `<${tag}>${escapeHtml(value)}</${tag}>`;
}

/**
 * Build the HTML document of a validated report.
 *
 * @param {object} report Output of {@link normalizeReport}.
 * @param {Date} [now] Generation instant.
 * @return {string} Complete HTML document.
 */
export function renderReportHtml(report, now = new Date()) {
    let chartIndex = 0;
    const sections = report.sections.map((section) => {
        let html = `<section><h2>${escapeHtml(section.heading)}</h2>`;

        if (section.text) {
            html += paragraphs(section.text);
        }

        if (section.kpis?.length) {
            html += `<div class="kpis">${section.kpis.map((kpi) => `<div class="kpi">${valueElement(kpi.value, 'b')}<span>${escapeHtml(kpi.label)}</span></div>`).join('')}</div>`;
        }

        if (section.chart) {
            chartIndex += 1;
            html += renderChart(section.chart, `chart-${chartIndex}`);
        }

        if (section.table) {
            html += `<div class="scroll"><table><thead><tr>${section.table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>`
                + section.table.rows.map((row) => `<tr>${row.map((value) => valueElement(value, 'td')).join('')}</tr>`).join('')
                + '</tbody></table></div>';
        }

        return `${html}</section>`;
    }).join('\n');

    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(report.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top"><img class="logo" alt="CloudISP" src="${LOGO_DATA_URI}"><div><h1>${escapeHtml(report.title)}</h1>${report.subtitle ? `<p class="sub">${escapeHtml(report.subtitle)}</p>` : ''}</div></header>
<main>
${sections}
</main>
<footer>Generado por el Asistente CloudISP · ${formatArgentinaTime(now)}</footer>
</body>
</html>
`;
}

/**
 * @param {string} title Report title.
 * @return {string} File-name-safe slug, accents folded, at most 60 characters.
 */
export function slugify(title) {
    const slug = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');

    return slug === '' ? 'informe' : slug;
}
