/**
 * The user-facing catalogue of what the agent can do, one entry per MCP tool.
 *
 * `GUIDE` is attached to the tools by `server.mjs`; `npm run guide` renders it into
 * `hermes-plugin/cloudisp/guia.md` (what `/guia` answers) and `write_tools.json` (which tools the
 * plugin sends to human approval, with the label shown on the card). Copy is Spanish (rioplatense)
 * and never names a tool: the guide is read by operators, not by the model.
 *
 * The only markup in the guide is `**bold**`, which the Telegram adapter converts to MarkdownV2. Underscores
 * are NOT converted (it escapes them), so `_italic_` would show raw: examples go between « » instead.
 */

/** Fixed category order of the guide. */
export const GUIDE_CATEGORIES = [
    'Abonados',
    'ONU y WiFi',
    'Red y equipos (sólo lectura)',
    'Consumo y tráfico',
    'Órdenes de trabajo',
    'Informes y gráficos',
    'Conocimiento',
];

const [SUBSCRIBERS, ONU, NETWORK, USAGE, ORDERS, REPORTS, KNOWLEDGE] = GUIDE_CATEGORIES;

/**
 * `hidden` keeps an internal helper out of the printed guide; every entry still carries its label
 * (the approval card of a write uses it).
 *
 * @type {Record<string, { category: string, label_es: string, example_es: string, hidden?: boolean }>}
 */
export const GUIDE = {
    find_subscriber: { category: SUBSCRIBERS, label_es: 'Buscar un abonado', example_es: 'Buscá al abonado #1234' },
    get_subscriber: { category: SUBSCRIBERS, label_es: 'Ver los datos de un abonado', example_es: 'Mostrame la ficha de #1234' },
    diagnose_subscriber: { category: SUBSCRIBERS, label_es: 'Diagnosticar a un abonado', example_es: 'El abonado #1234 no tiene internet, diagnosticalo' },
    list_invoices: { category: SUBSCRIBERS, label_es: 'Ver las facturas de un abonado', example_es: '¿Tiene facturas vencidas el #1234?' },
    list_plans: { category: SUBSCRIBERS, label_es: 'Ver los planes disponibles', example_es: '¿Qué planes tenemos?' },
    list_internet_profiles: { category: SUBSCRIBERS, label_es: 'Ver los perfiles de velocidad', example_es: '¿Qué perfiles de velocidad hay?', hidden: true },
    change_subscriber_plan: { category: SUBSCRIBERS, label_es: 'Cambiar el plan de un abonado', example_es: 'Pasá al #1234 a otro plan' },
    change_subscriber_bandwidth: { category: SUBSCRIBERS, label_es: 'Cambiar el perfil de velocidad', example_es: 'Cambiale la velocidad al #1234' },
    disconnect_subscriber: { category: SUBSCRIBERS, label_es: 'Cortar el servicio de un abonado', example_es: 'Desconectá al abonado #1234' },
    reconnect_subscriber: { category: SUBSCRIBERS, label_es: 'Reconectar el servicio de un abonado', example_es: 'Reconectá al abonado #1234' },
    kick_pppoe: { category: SUBSCRIBERS, label_es: 'Cerrar la sesión de conexión (PPPoE)', example_es: 'Cerrá la sesión PPPoE del #1234 para que se reconecte' },

    onu_read: { category: ONU, label_es: 'Leer el estado de la ONU y el WiFi', example_es: 'Leé el WiFi del #1234' },
    onu_diagnose: { category: ONU, label_es: 'Diagnosticar la ONU', example_es: 'Diagnosticá la ONU del #1234' },
    list_onus: { category: ONU, label_es: 'Listar ONU por OLT, PON o estado', example_es: 'Mostrame las ONU caídas de una OLT' },
    list_onu_models: { category: ONU, label_es: 'Ver los modelos de ONU del parque', example_es: '¿Qué modelos de ONU hay y cuántas de cada uno?' },
    get_task: { category: ONU, label_es: 'Seguir una tarea en curso', example_es: '¿Terminó el reinicio de la ONU del #1234?', hidden: true },
    reboot_onu: { category: ONU, label_es: 'Reiniciar la ONU', example_es: 'Reiniciá la ONU del #1234' },
    set_onu_catv: { category: ONU, label_es: 'Activar o desactivar el CATV', example_es: 'Desactivá el CATV del #1234' },
    change_subscriber_wifi: { category: ONU, label_es: 'Cambiar el WiFi', example_es: 'Cambiá el nombre del WiFi del #1234' },
    change_wifi_radio: { category: ONU, label_es: 'Cambiar el canal del WiFi', example_es: 'Poné el WiFi de 5 GHz del #1234 en otro canal' },
    optimize_wifi: { category: ONU, label_es: 'Optimizar el WiFi', example_es: 'Optimizá el WiFi del #1234' },
    restore_wifi: { category: ONU, label_es: 'Restaurar el WiFi', example_es: 'Restaurá el WiFi del #1234 como estaba registrado' },
    sync_onu: { category: ONU, label_es: 'Sincronizar la ONU', example_es: 'Sincronizá la ONU del #1234' },
    reprovision_onu: { category: ONU, label_es: 'Reaprovisionar la ONU', example_es: 'Reaprovisioná la ONU del #1234' },
    factory_reset_onu: { category: ONU, label_es: 'Restablecer la ONU de fábrica', example_es: 'Restablecé de fábrica la ONU del #1234' },
    set_onu_admin_state: { category: ONU, label_es: 'Habilitar o deshabilitar la ONU en la OLT', example_es: 'Deshabilitá la ONU del #1234' },
    locate_new_onu: { category: ONU, label_es: 'Ubicar una ONU nueva por MAC', example_es: 'Buscá la ONU nueva con la MAC AA:BB:CC:DD:EE:FF', hidden: true },
    swap_onu: { category: ONU, label_es: 'Cambiar la ONU de un abonado', example_es: 'Cambiá la ONU del #1234 por la nueva (MAC AA:BB:CC:DD:EE:FF)' },

    network_snapshot: { category: NETWORK, label_es: 'Ver el estado general de la red', example_es: '¿Cuántos abonados hay online ahora?' },
    list_olts: { category: NETWORK, label_es: 'Listar las OLT', example_es: 'Mostrame las OLT y su estado' },
    get_olt: { category: NETWORK, label_es: 'Ver una OLT y sus PON', example_es: 'Mostrame el detalle de una OLT' },
    olt_read: { category: NETWORK, label_es: 'Consultar una OLT en vivo', example_es: 'Revisá la salud de una OLT' },
    olt_poll_runs: { category: NETWORK, label_es: 'Ver los últimos sondeos de una OLT', example_es: '¿Cuándo se sondeó por última vez una OLT?' },
    list_routers: { category: NETWORK, label_es: 'Listar los routers', example_es: 'Mostrame los routers' },
    get_router: { category: NETWORK, label_es: 'Ver un router', example_es: 'Mostrame el estado de un router' },
    router_read: { category: NETWORK, label_es: 'Consultar un router en vivo', example_es: 'Mirá las sesiones PPPoE de un router' },
    list_eoc_masters: { category: NETWORK, label_es: 'Listar los masters EoC', example_es: 'Mostrame los masters EoC' },
    network_alerts: { category: NETWORK, label_es: 'Ver las alertas de red', example_es: '¿Hay alertas de red activas?' },
    device_metrics: { category: NETWORK, label_es: 'Ver métricas de un PON o un uplink', example_es: 'Mostrame el tráfico del uplink de una OLT en las últimas horas' },
    device_tasks: { category: NETWORK, label_es: 'Ver el historial de tareas de los equipos', example_es: '¿Qué tareas se le hicieron a la ONU del #1234?' },
    platform_logs: { category: NETWORK, label_es: 'Ver los logs de la plataforma', example_es: 'Mostrame los últimos logs de una OLT' },

    subscriber_usage: { category: USAGE, label_es: 'Ver el consumo de un abonado', example_es: '¿Cuánto consumió el #1234 en las últimas 24 horas?' },
    usage_ranking: { category: USAGE, label_es: 'Ranking de consumo', example_es: '¿Quiénes consumen más en una OLT esta semana?' },
    live_traffic: { category: USAGE, label_es: 'Ver el tráfico en vivo de un abonado', example_es: 'Mostrame el tráfico en vivo del #1234' },

    find_work_orders: { category: ORDERS, label_es: 'Buscar órdenes de trabajo', example_es: 'Mostrame las órdenes pendientes del #1234' },
    get_work_order: { category: ORDERS, label_es: 'Ver una orden de trabajo', example_es: 'Mostrame la orden 5527' },
    find_technician: { category: ORDERS, label_es: 'Buscar un técnico', example_es: '¿Quién es el técnico Marcos?', hidden: true },
    create_work_order: { category: ORDERS, label_es: 'Crear una orden de trabajo', example_es: 'Cargá una visita técnica para el #1234' },
    assign_work_order: { category: ORDERS, label_es: 'Asignar una orden de trabajo', example_es: 'Asigná la visita técnica del #1234 a Marcos' },

    list_reports: { category: REPORTS, label_es: 'Ver qué informes hay', example_es: '¿Qué informes me podés dar?' },
    run_report: { category: REPORTS, label_es: 'Consultar un informe', example_es: 'Resumime las órdenes de trabajo de este mes' },
    export_report: { category: REPORTS, label_es: 'Descargar un informe en PDF o CSV', example_es: 'Haceme un informe PDF de órdenes de trabajo de este mes' },
    build_report: { category: REPORTS, label_es: 'Armar un informe con gráficos (HTML)', example_es: 'Haceme un informe con gráfico del consumo de una PON' },

    search_knowledge: { category: KNOWLEDGE, label_es: 'Buscar en la base de conocimiento', example_es: '¿Cómo se resuelve un abonado sin IP?' },
    cloudisp_context: { category: KNOWLEDGE, label_es: 'Cargar las reglas y el conocimiento', example_es: '¿Qué reglas seguís?', hidden: true },
};

/**
 * @param {Array<{ name: string, write?: boolean, guide: object }>} catalog Tools, as `guideCatalog()` returns them.
 * @return {string} Markdown of `/guia`, with `{bot_name}` and `{tenant_name}` placeholders.
 */
export function renderGuide(catalog) {
    const lines = [
        '**👋 Soy el {bot_name} de {tenant_name}**',
        'Te ayudo a operar tu red de CloudISP: diagnosticar abonados, ONU y WiFi, consultar equipos y consumos, y gestionar órdenes de trabajo.',
        'Escribime en lenguaje natural; para un abonado usá su número, por ejemplo #1234. Todo lo que hago queda registrado a tu nombre.',
    ];

    for (const category of GUIDE_CATEGORIES) {
        const entries = catalog.filter((tool) => tool.guide.category === category && !tool.guide.hidden);

        if (entries.length === 0) {
            continue;
        }

        lines.push('', `**${category}**`);

        for (const { write, guide } of entries) {
            lines.push(`• **${guide.label_es}**${write ? ' ✍️' : ''} — ejemplo: «${guide.example_es}»`);
        }
    }

    lines.push('', 'Las acciones con ✍️ siempre piden tu confirmación. Usá /new para empezar una conversación nueva.');

    return `${lines.join('\n')}\n`;
}

/**
 * @param {Array<{ name: string, write?: boolean, guide: object }>} catalog Tools, as `guideCatalog()` returns them.
 * @return {string} JSON object `{ <write tool>: <label shown on the approval card> }`.
 */
export function renderWriteTools(catalog) {
    const writes = Object.fromEntries(catalog.filter((tool) => tool.write).map((tool) => [tool.name, tool.guide.label_es]));

    return `${JSON.stringify(writes, null, 2)}\n`;
}
