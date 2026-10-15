/**
 * Zero-dependency SVG charts (bar, line, donut) for the self-contained HTML reports.
 *
 * `renderChart` returns a `<figure>`: the inline SVG, an HTML legend and, when a series has a
 * `null` value, a caption that says so. A `null` is a gap, never a 0: bars get a dashed stub on
 * the baseline, lines break and a hollow marker sits on the baseline, donuts skip the slice.
 */

const PALETTE = ['#c026a3', '#2563eb', '#0d9488', '#f59e0b', '#7c3aed', '#ef4444', '#64748b', '#16a34a'];
const NO_DATA = 'no disponible';
const NUMBER = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
const GRID = '#e6dfeb';
const AXIS = '#9b8fa8';
const INK = '#3b2f4a';

const WIDTH = 720;
const HEIGHT = 360;
const FONT = 'font-family="-apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif"';

/**
 * @param {unknown} value Any value.
 * @return {string} HTML-escaped text.
 */
export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char]);
}

/**
 * @param {number} value Number to show.
 * @param {string} [unit] Optional unit; `%` sticks to the number, anything else follows a space.
 * @return {string} es-AR formatted number.
 */
export function formatValue(value, unit = '') {
    const text = NUMBER.format(value);

    if (unit === '') {
        return text;
    }

    return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

/**
 * Round a data range to "nice" axis ticks (1, 2, 5 times a power of ten).
 *
 * @param {number} min Smallest value.
 * @param {number} max Largest value.
 * @param {number} [count] Wanted number of intervals.
 * @return {{ min: number, max: number, ticks: number[] }}
 */
export function niceScale(min, max, count = 5) {
    let low = min >= 0 ? 0 : min;
    let high = max <= 0 ? 0 : max;

    if (low === high) {
        high = low + 1;
    }

    const raw = (high - low) / count;
    const exponent = Math.floor(Math.log10(raw));
    const fraction = raw / 10 ** exponent;
    const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * 10 ** exponent;

    low = Math.floor(low / step) * step;
    high = Math.ceil(high / step) * step;

    const ticks = [];

    for (let tick = low; tick <= high + step / 2; tick += step) {
        ticks.push(Number(tick.toFixed(10)));
    }

    return { min: low, max: high, ticks };
}

/**
 * @param {string} text Label.
 * @param {number} limit Maximum characters.
 * @return {string} The label, cut with an ellipsis when longer.
 */
function clip(text, limit) {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * @param {number} number Coordinate.
 * @return {string} Coordinate with at most 2 decimals.
 */
function px(number) {
    return String(Math.round(number * 100) / 100);
}

/**
 * Geometry shared by the bar and line charts.
 *
 * @param {object} chart Validated chart.
 * @return {object} Plot box, scale and the position helpers.
 */
function cartesian(chart) {
    const { categories, series, unit = '' } = chart;
    const values = series.flatMap((item) => item.data).filter((value) => value !== null);
    const scale = niceScale(values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 1);
    const tickLabels = scale.ticks.map((tick) => formatValue(tick, unit));
    const left = Math.max(...tickLabels.map((label) => label.length)) * 7 + 16;
    const rotate = categories.length > 6 || categories.some((category) => category.length > 10);
    const top = 16;
    const bottom = rotate ? 78 : 36;
    const plotWidth = WIDTH - left - 16;
    const plotHeight = HEIGHT - top - bottom;

    return {
        scale,
        tickLabels,
        left,
        top,
        rotate,
        plotWidth,
        plotHeight,
        baseline: top + plotHeight,
        y: (value) => top + plotHeight - ((value - scale.min) / (scale.max - scale.min)) * plotHeight,
        slot: plotWidth / categories.length,
    };
}

/**
 * Axes, grid and category labels.
 *
 * @param {object} chart Validated chart.
 * @param {object} geo Output of {@link cartesian}.
 * @return {string} SVG fragment.
 */
function axes(chart, geo) {
    const { categories } = chart;
    const every = Math.ceil(categories.length / 14);
    let out = '';

    geo.scale.ticks.forEach((tick, index) => {
        const y = geo.y(tick);

        out += `<line x1="${px(geo.left)}" y1="${px(y)}" x2="${WIDTH - 16}" y2="${px(y)}" stroke="${tick === 0 ? AXIS : GRID}" stroke-width="1"/>`
            + `<text x="${px(geo.left - 8)}" y="${px(y + 4)}" text-anchor="end" font-size="12" fill="${INK}" ${FONT}>${escapeHtml(geo.tickLabels[index])}</text>`;
    });

    categories.forEach((category, index) => {
        if (index % every !== 0) {
            return;
        }

        const x = geo.left + geo.slot * (index + 0.5);
        const y = geo.baseline + 18;
        const label = escapeHtml(clip(category, 16));

        out += geo.rotate
            ? `<text x="${px(x)}" y="${px(y)}" text-anchor="end" font-size="12" fill="${INK}" transform="rotate(-35 ${px(x)} ${px(y)})" ${FONT}>${label}</text>`
            : `<text x="${px(x)}" y="${px(y)}" text-anchor="middle" font-size="12" fill="${INK}" ${FONT}>${label}</text>`;
    });

    return out;
}

/**
 * @param {object} chart Validated bar chart.
 * @return {string} SVG body.
 */
function barBody(chart) {
    const geo = cartesian(chart);
    const count = chart.series.length;
    const groupWidth = geo.slot * 0.8;
    const barWidth = groupWidth / count;
    const showValues = chart.categories.length * count <= 12;
    let out = axes(chart, geo);

    chart.series.forEach((item, seriesIndex) => {
        const color = PALETTE[seriesIndex % PALETTE.length];

        item.data.forEach((value, index) => {
            const x = geo.left + geo.slot * index + geo.slot * 0.1 + barWidth * seriesIndex;
            const label = `${item.name} · ${chart.categories[index]}: ${value === null ? NO_DATA : formatValue(value, chart.unit)}`;

            if (value === null) {
                out += `<line x1="${px(x + 2)}" y1="${px(geo.baseline - 3)}" x2="${px(x + barWidth - 2)}" y2="${px(geo.baseline - 3)}" stroke="${color}" stroke-width="2" stroke-dasharray="3 3"><title>${escapeHtml(label)}</title></line>`;

                return;
            }

            const y = geo.y(value);
            const zero = geo.y(0);

            out += `<rect x="${px(x + 1)}" y="${px(Math.min(y, zero))}" width="${px(Math.max(barWidth - 2, 1))}" height="${px(Math.max(Math.abs(zero - y), 1))}" fill="${color}" rx="2"><title>${escapeHtml(label)}</title></rect>`;

            if (showValues) {
                out += `<text x="${px(x + barWidth / 2)}" y="${px(Math.min(y, zero) - 4)}" text-anchor="middle" font-size="11" fill="${INK}" ${FONT}>${escapeHtml(formatValue(value, chart.unit))}</text>`;
            }
        });
    });

    return out;
}

/**
 * @param {object} chart Validated line chart.
 * @return {string} SVG body.
 */
function lineBody(chart) {
    const geo = cartesian(chart);
    let out = axes(chart, geo);

    chart.series.forEach((item, seriesIndex) => {
        const color = PALETTE[seriesIndex % PALETTE.length];
        let path = '';
        let drawing = false;

        item.data.forEach((value, index) => {
            const x = geo.left + geo.slot * (index + 0.5);

            if (value === null) {
                drawing = false;
                out += `<circle cx="${px(x)}" cy="${px(geo.baseline)}" r="4" fill="#fff" stroke="${color}" stroke-width="1.5" stroke-dasharray="2 2"><title>${escapeHtml(`${item.name} · ${chart.categories[index]}: ${NO_DATA}`)}</title></circle>`;

                return;
            }

            path += `${drawing ? 'L' : 'M'}${px(x)} ${px(geo.y(value))} `;
            drawing = true;
        });

        out += `<path d="${path.trim()}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

        item.data.forEach((value, index) => {
            if (value !== null) {
                out += `<circle cx="${px(geo.left + geo.slot * (index + 0.5))}" cy="${px(geo.y(value))}" r="3.5" fill="${color}"><title>${escapeHtml(`${item.name} · ${chart.categories[index]}: ${formatValue(value, chart.unit)}`)}</title></circle>`;
            }
        });
    });

    return out;
}

/**
 * @param {object} chart Validated donut chart (one series).
 * @return {{ body: string, total: number }} SVG body and the sum of the known values.
 */
function donutBody(chart) {
    const values = chart.series[0].data;
    const total = values.reduce((sum, value) => sum + (value ?? 0), 0);
    const radius = 100;
    const circumference = 2 * Math.PI * radius;
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2;
    let out = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${GRID}" stroke-width="48"/>`;
    let offset = 0;

    values.forEach((value, index) => {
        if (value === null || value <= 0 || total <= 0) {
            return;
        }

        const length = (value / total) * circumference;

        out += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${PALETTE[index % PALETTE.length]}" stroke-width="48" `
            + `stroke-dasharray="${px(length)} ${px(circumference - length)}" stroke-dashoffset="${px(-offset)}" transform="rotate(-90 ${cx} ${cy})">`
            + `<title>${escapeHtml(`${chart.categories[index]}: ${formatValue(value, chart.unit)}`)}</title></circle>`;
        offset += length;
    });

    out += `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="26" font-weight="700" fill="${INK}" ${FONT}>${escapeHtml(total > 0 ? formatValue(total, chart.unit) : NO_DATA)}</text>`
        + `<text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="13" fill="${AXIS}" ${FONT}>total</text>`;

    return { body: out, total };
}

/**
 * @param {Array<{ name: string, color: string, text?: string }>} entries Legend rows.
 * @return {string} HTML legend.
 */
function legend(entries) {
    return `<ul class="legend">${entries.map((entry) => `<li><span class="sw" style="background:${entry.color}"></span>${escapeHtml(entry.name)}${entry.text ? ` — ${escapeHtml(entry.text)}` : ''}</li>`).join('')}</ul>`;
}

/**
 * @param {object} chart Validated chart.
 * @return {string} Caption listing the missing values, or an empty string.
 */
function missingCaption(chart) {
    const gaps = [];

    chart.series.forEach((item) => {
        item.data.forEach((value, index) => {
            if (value === null) {
                gaps.push(chart.type === 'donut' ? chart.categories[index] : `${item.name} (${chart.categories[index]})`);
            }
        });
    });

    if (gaps.length === 0) {
        return '';
    }

    const shown = gaps.slice(0, 10).join(', ');
    const more = gaps.length > 10 ? ` y ${gaps.length - 10} más` : '';

    return `<figcaption>Sin dato (${NO_DATA}): ${escapeHtml(shown)}${more}.</figcaption>`;
}

/**
 * Render one chart as a `<figure>` with inline SVG.
 *
 * @param {{ type: 'bar'|'line'|'donut', categories: string[], series: Array<{ name: string, data: Array<number|null> }>, unit?: string }} chart Validated chart.
 * @param {string} id Unique id of the chart in the document (accessible title).
 * @return {string} HTML fragment.
 */
export function renderChart(chart, id) {
    const description = `Gráfico de ${{ bar: 'barras', line: 'líneas', donut: 'anillo' }[chart.type]}: ${chart.series.map((item) => item.name).join(', ')}`;
    let body;
    let entries;

    if (chart.type === 'donut') {
        const donut = donutBody(chart);

        body = donut.body;
        entries = chart.categories.map((category, index) => {
            const value = chart.series[0].data[index];

            return {
                name: category,
                color: PALETTE[index % PALETTE.length],
                text: value === null ? NO_DATA : `${formatValue(value, chart.unit)}${donut.total > 0 ? ` (${NUMBER.format((value / donut.total) * 100)}%)` : ''}`,
            };
        });
    } else {
        body = chart.type === 'bar' ? barBody(chart) : lineBody(chart);
        entries = chart.series.length > 1
            ? chart.series.map((item, index) => ({ name: item.name, color: PALETTE[index % PALETTE.length] }))
            : [];
    }

    return `<figure class="chart"><svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="${id}-t" xmlns="http://www.w3.org/2000/svg">`
        + `<title id="${id}-t">${escapeHtml(description)}</title>${body}</svg>`
        + `${entries.length ? legend(entries) : ''}${missingCaption(chart)}</figure>`;
}
