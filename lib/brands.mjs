/**
 * Brands of the `build_report` informes: the look of the CloudISP reports and the NextScale one that
 * the admin reports (`report_branding` of `GET /agent/context`) tell the bot to use for NextScale clients.
 */

import { readFileSync } from 'node:fs';

import { LOGO_DATA_URI } from './logo.mjs';
import { DEFAULT_THEME } from './svg-charts.mjs';

/** The look every informe had before brands; also what a context without a brand, or one that cannot be read, gets. */
export const CLOUDISP_BRAND = Object.freeze({
    key: 'cloudisp',
    primary: '#0f0b14',
    accent: '#c026a3',
    muted: '#6b5c7b',
    palette: DEFAULT_THEME.palette,
    clientName: null,
    preparedBy: 'CloudISP',
    logoDataUri: LOGO_DATA_URI,
});

const NEXTSCALE_PALETTE = ['#0D1B3E', '#00B4D8', '#707B8C', '#5FD3E8', '#2A4A80', '#C9CEDA', '#142A52', '#9FE6F2'];

/**
 * @param {string} name File below `lib/`.
 * @return {Buffer} Its content.
 */
function asset(name) {
    return readFileSync(new URL(name, import.meta.url));
}

let nextscaleAssets = null;

/**
 * @return {{ logoSvg: string, iconSvg: string }} The two official SVGs, read once.
 */
function nextscaleSvgs() {
    nextscaleAssets ??= { logoSvg: asset('brands/nextscale-logo.svg').toString('utf8'), iconSvg: asset('brands/nextscale-icon.svg').toString('utf8') };

    return nextscaleAssets;
}

/**
 * The brand an informe is drawn with.
 *
 * @param {object|null|undefined} context Answer of `GET /agent/context` (the envelope or its `data`).
 * @return {object} `nextscale` when `report_branding.brand` says so, otherwise {@link CLOUDISP_BRAND}.
 */
export function brandFor(context) {
    const data = context?.data ?? context;
    const branding = data?.report_branding;

    if (branding?.brand !== 'nextscale') {
        return CLOUDISP_BRAND;
    }

    const name = [branding.client_name, data.platform?.name].find((candidate) => typeof candidate === 'string' && candidate.trim() !== '');

    return {
        key: 'nextscale',
        primary: '#0D1B3E',
        accent: '#00B4D8',
        muted: '#707B8C',
        palette: NEXTSCALE_PALETTE,
        clientName: name === undefined ? null : name.trim(),
        preparedBy: 'NextScale',
        ...nextscaleSvgs(),
    };
}

/**
 * The `@font-face` rules of the NextScale informes: Calibri's metric twin Carlito (body) and Fira Sans
 * (Trebuchet MS headings), latin subset woff2 embedded as base64 so the HTML needs no request.
 *
 * @return {string} CSS.
 */
export function nextscaleFontFaces() {
    const face = (family, weight, file) => `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${asset(`fonts/${file}`).toString('base64')}) format('woff2')}`;

    return [
        face('Carlito', 400, 'Carlito-Regular.woff2'),
        face('Carlito', 700, 'Carlito-Bold.woff2'),
        face('Fira Sans', 600, 'FiraSans-SemiBold.woff2'),
        face('Fira Sans', 700, 'FiraSans-Bold.woff2'),
    ].join('\n');
}
