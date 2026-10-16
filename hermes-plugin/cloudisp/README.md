# Plugin `cloudisp` para Hermes

Capa comercial del Asistente CloudISP: lo que el motor de agentes no ofrece como configuración. Se escribió y se
verificó contra Hermes **v0.22.0+139 (`79651b7`)**; `requires_hermes: ">=0.22"`.

| Qué | Cómo |
| --- | --- |
| Sólo comandos de CloudISP | `pre_gateway_dispatch`: `allowed_commands` (por defecto `new`, `guia`, `start`) pasan; `/start` se reescribe a `/guia`; cualquier otro se reescribe a un comando propio que contesta «Ese comando no está disponible…». |
| Corte por cupo | El mismo hook consulta `GET /agent/usage/status` (cache de 60 s por perfil). `exhausted` → «⛔ Se agotó el cupo…» y no se llama al modelo; un error del admin deja pasar el mensaje (el corte duro lo da el ledger). |
| Aviso al 80 % | `transform_llm_output` agrega «⚠️ … más del 80 % del cupo…» a la próxima respuesta, una vez por período (marca en `~/.cache/cloudisp-plugin/warned-*`). |
| `/guia` | `register_command`: devuelve `guia.md` (generada por `npm run guide`) sin pasar por el modelo. |
| Identidad del operador (falla cerrado) | `pre_tool_call` (`modify`) **pisa** el `_operator` de toda llamada al MCP con el de la sesión (o con `null` si no hay usuario válido); nada de lo que mande el modelo sobrevive. La puerta de aprobación vuelve a derivar el operador por su cuenta y **bloquea** la escritura si no puede («No pude identificar quién pide esta acción…»). Un error en cualquiera de los dos callbacks bloquea las escrituras (aviso en español) y deja salir las lecturas sin operador; queda `CLOUDISP_GUARD_ERROR` en el log. Un MCP con `CLOUDISP_REQUIRE_OPERATOR=1` rechaza además toda escritura sin operador. |
| Aprobación en español | `pre_tool_call` (`approve`): «✍️ Confirmá: <acción> — <argumentos>», con `rule_key` nueva por llamada. La tarjeta de Telegram se reescribe (parche, ver abajo): título «Necesito tu confirmación para esta acción», la acción en español en el recuadro, «Detalle: …», sólo **✅ Aprobar** y **❌ Denegar**. Los subagentes que escriben reciben `block`. |
| Un «no» es definitivo | `post_approval_response` anota la confirmación denegada, vencida o cancelada; en ese mismo turno cualquier escritura recibe `block` («No la reintentes…»). Sólo un mensaje nuevo del operador abre otro turno. |
| Consumo | `post_api_request` y `post_auxiliary_call`: `POST /agent/usage` desde un thread (3 s); si falla, cola `usage-spool-<perfil>.jsonl` y reintento (máx. 50) en el siguiente. |
| Marcas fuera | `transform_llm_output` (respuesta), middleware `llm_request` (prompt: host, modelo, proveedor, marca) y un pack de textos `es`/`en` (`strings.py`: banner de `/new`, progreso y latido, tarjetas de aprobación y de `clarify`, avisos de reinicio y de error, comando desconocido). |
| Parches del runtime | `patches.py`, dos y con guarda (ver «Parches»): sin `(Recommended)` en las opciones de `clarify` y tarjeta de aprobación sin nombre de herramienta ni botones «sesión»/«siempre». |

## Instalación

```bash
ln -s ~/.local/share/cloudisp-mcp/hermes-plugin/cloudisp ~/.hermes/plugins/cloudisp                       # host
ln -s ~/.local/share/cloudisp-mcp/hermes-plugin/cloudisp ~/.hermes/profiles/<perfil>/plugins/cloudisp     # perfil
```

`deploy/hermes-tenant/host-setup.sh` (una vez por host) y `new-tenant.sh` (por cliente) hacen esto y toda la
configuración. **El plugin tiene que estar habilitado en el host Y en el perfil** (`plugins.enabled`): el gateway
multiplexado despacha los mensajes entrantes y los comandos desde el home del host, y los turnos (herramientas,
consumo, respuesta) desde el del perfil. Cada instancia lee los ajustes del perfil que atiende
(`plugins.entries.cloudisp.settings` de su `config.yaml`):

| Ajuste | Por defecto | Para qué |
| --- | --- | --- |
| `env_file` | — | `prod.env` del MCP: de ahí salen `CLOUDISP_API_BASE` y `CLOUDISP_API_KEY` (una referencia `op://` no sirve: el plugin no tiene `op`). Nunca se loguean. |
| `tenant_name`, `bot_name` | `tu empresa`, `Asistente CloudISP` | Textos de `/guia` y del corte. |
| `mcp_server` | `cloudisp` | Nombre del servidor en `mcp_servers`; las herramientas llegan como `mcp__<servidor>__<herramienta>`. |
| `allowed_commands` | `[new, guia, start]` | Comandos que llegan al motor. |

Si el plugin no carga, el MCP (con `CLOUDISP_REQUIRE_OPERATOR=1`) rechaza toda escritura: no hay escrituras sin
plugin. Con el plugin cargado pero sin `write_tools.json` el registro falla (no queda ningún hook a medias).

## Hallazgos de la verificación (fuente de CT 108, sólo lectura)

| Supuesto del plan | Resultado |
| --- | --- |
| `pre_gateway_dispatch(event, gateway, session_store)` | Existe y corre **antes** de la autenticación (`gateway/run_inbound.py::_hm_admit_event`). `event.get_command()` ya devuelve el comando en minúscula y sin `@bot`. En multiplex corre con el home del **host**, no el del perfil. |
| Enviar con `gateway._delivery_adapter_for(source)` | Existe, pero **no se usa**: como el hook corre antes de auth, enviar desde ahí le contestaría a desconocidos. En su lugar el hook devuelve `rewrite` hacia comandos propios (`/cloudisp-blocked`, `/cloudisp-quota`): la respuesta sigue el camino normal y sólo llega a usuarios autorizados. |
| `ctx.register_command` | Existe: `register_command(name, handler, description, args_hint)`; el handler recibe `raw_args` y devuelve `str`; se despacha sin modelo, con las variables de sesión ya puestas. Rechaza nombres que choquen con comandos del motor (`guia` no choca). |
| `pre_tool_call` `modify` llega al MCP | **Sí**: `agent/tool_executor.py` ejecuta con los args modificados y `registry.dispatch` no valida contra el schema. Cada callback devuelve **una** directiva, por eso hay dos callbacks (`modify` y `approve`/`block`). En esta versión una excepción o un timeout de un callback de `pre_tool_call` ya se convierte en `block` (`plugins_dispatch.PluginDispatchMixin.invoke_hook`, `_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS = {"pre_tool_call"}`, con un mensaje en inglés); el plugin bloquea igual por su cuenta, en español y sin depender de la versión. El callback corre en un thread con una copia del contexto, así que `get_session_env` ve al usuario. Los dos callbacks reciben los mismos `args` del modelo (el `modify` se aplica recién después). |
| Prefijo de las herramientas MCP | `mcp__<servidor>__<herramienta>` (`tools/mcp_tool_schema.py`). |
| Detección de subagente | Los kwargs de `pre_tool_call` son `tool_name, args, task_id, session_id, tool_call_id, turn_id, api_request_id`: **no hay `parent_session_id`**, y `HERMES_SESSION_SOURCE` no vale `subagent`. Se usa `subagent_start(child_session_id)` y `agent.delegation_context.is_delegated_child_context()` (el predicado que usa el propio motor). |
| `approve` muestra la tarjeta con botones | **Sí**: `request_tool_approval` → `send_exec_approval`; Telegram dibuja botones y el texto es el `message`. **Pero** el motor la arma sin que se pueda configurar: encabezado «Hermes quiere ejecutar un comando…» (cambia con la clave `gateway.exec_approval.header` del pack), un recuadro con `<mcp__cloudisp__herramienta> (plugin approval rule)` (nombre interno) y los botones «sesión» y «siempre» (`allow_session`/`allow_permanent` van fijos en `True`; no hay clave ni cadena que los oculte, y una etiqueta vacía rompe el botón). Por eso el parche de `send_exec_approval`. `/yolo` y `approvals.mode: off` saltean la tarjeta: `/yolo` queda bloqueado por el allowlist. |
| `post_approval_response` | Se dispara también en el camino del gateway, desde el thread del agente, con `pattern_key` (`plugin_rule:<rule_key>`), `choice` (`once`/`session`/`always`/`deny`/`timeout`/`cancelled`/`notify_failed`), `session_id` y `turn_id`: los mismos que ve `pre_tool_call`. Con eso se bloquea el reintento del mismo turno. |
| `post_api_request` | Los tokens vienen en el kwarg **`usage`** (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`; la entrada **no** incluye la caché), además de `model`, `provider`, `session_id`, `api_request_id`, `started_at`, `ended_at`. `post_auxiliary_call` trae lo mismo y también se reporta. |
| `transform_llm_output(text, …)` | La firma real es `transform_llm_output(response_text, session_id, model, platform, turn_id)`; devuelve `str` o `None`. Corre antes de persistir la respuesta. |
| `pre_progress` | **No existe** en v0.22 (no está en `VALID_HOOKS`); no se pueden renombrar las etiquetas de progreso por herramienta. Contingencia: el pack de textos reemplaza `gateway.progress.tool_preview` y `tool_pending` por «{emoji} Consultando CloudISP…», sin nombre de herramienta ni argumentos. Por eso **no hay `labels.json`**. Si en la matriz de pruebas aparece algún nombre interno, `display.platforms.telegram.tool_progress off`. |
| Config para ocultar comandos core | No existe; el allowlist es el hook. Los comandos con argumentos también pasan por el hook (se mira sólo el nombre). |
| `register_hook`/middleware | Un tercer hueco útil: `register_middleware("llm_request", fn)` reescribe lo que se manda al proveedor. Se usa para sacar del prompt el host, el modelo, el proveedor y la marca, que el motor inyecta sin ninguna clave de configuración (ver abajo). |

### Lo que el motor le cuenta al modelo (y cómo se corta)

Fuente: `agent/system_prompt.py`, `agent/prompt_builder.py`. Sin clave de configuración: «You run on Hermes Agent (by Nous
Research)…», `Active Hermes profile: … /home/hermes/…`, el trailer `Model: / Provider: / Platform:` y el bloque
`# Hermes runtime environment` (kernel, home, cwd). El middleware `llm_request` los borra del prompt de cada llamada
(determinístico, el caché del proveedor sigue funcionando) y cambia «Hermes» por «CloudISP» en el resto. Con clave:
`agent.environment_probe: false`. La nota del primer mensaje («presentate y mencioná /help») se saca del mensaje del usuario.

### Lo que el motor le dice al usuario (y cómo se corta)

| Texto | Origen | Solución |
| --- | --- | --- |
| Banner de `/new` (modelo, proveedor, contexto, «Consejo: …») | `gateway/slash_commands_session.py::_handle_reset_command` | Pack de textos: `gateway.reset.header_*`, `gateway.reset.tip` y `gateway.session.info_*`. El aviso de reinicio por inactividad también. |
| Tarjeta de `clarify`: «1. ✅ Confirmar (Recommended)» y «Responde "skip" para omitir…» | `tools/clarify_tool.py::mark_recommended` (constante en inglés, sin clave) y `gateway.clarify.skip_hint` | El hint se vacía con el pack; el marcador se saca con el parche `patch_clarify`. |
| Latido «⏳ Trabajando — 0 min — receiving stream response … — mcp__cloudisp__reboot_onu» | `gateway/run_turn.py::_run_agent_notify_long_running`: con `long_running_notifications: true` agrega la última actividad (en inglés) y la herramienta en curso | `display.platforms.telegram.long_running_notifications generic` usa frases de `display.status_phrases` (en inglés por defecto): `display.status_phrases.mode replace` y las listas `status`/`generic` en español. El pack además quita el `{detail}` de `gateway.progress.working_heartbeat`. |
| «💡 First-time tip — I just interrupted my current task… /busy queue…» y el de `/verbose` | `agent/onboarding.py`: texto fijo en inglés, se muestra una vez y queda en `onboarding.seen.<flag>` | Marcarlos como vistos: `onboarding.seen.busy_input_prompt true` y `onboarding.seen.tool_progress_prompt true` (host y perfil). |
| Avisos de reinicio, apagado y error («Hermes está de vuelta…», «Usa /retry», `hermes doctor`) | `gateway.startup.online`, `gateway.shutdown.*`, `gateway.errors.*` | Pack de textos (con un canal principal el motor manda los de arranque y apagado). |
| «No hay un canal principal configurado…» | `gateway/run_turn.py::_hmwa_first_contact_notes` | `TELEGRAM_HOME_CHANNEL=<id del usuario autorizado>` en el `.env` del perfil (también `hermes config set TELEGRAM_HOME_CHANNEL <id>`); el pack deja el texto vacío por si falta. |
| Tarjeta de confirmación de `/new` | `approvals.destructive_slash_confirm` (por defecto `true`) | `false` en host y perfil. |
| «Comando desconocido /xyz» | `gateway/run_inbound.py::_hm_unknown_slash_reply` | El hook intercepta antes; el pack lo reemplaza por si llega igual. |

## Parches

El plugin parchea dos funciones del runtime **en memoria** (sin tocar los archivos de Hermes), una sola vez y con guarda: si el
destino cambia o no existe, el runtime sigue con su texto y nunca se cae, pero **el fallo no pasa en silencio** (ver «Salud y arranque»).
Antes de parchear se comprueba que el destino siga siendo lo que se espera (que `send_exec_approval` siga siendo una corrutina con los
mismos parámetros), y después que el parche tenga efecto (`mark_recommended` se prueba de punta a punta con la tarjeta de `clarify`; un
adaptador de Telegram que sobreescriba `send_exec_approval` se saltearía el parche y también cuenta como fallo).

| Parche | Qué hace | Si falla |
| --- | --- | --- |
| `mark_recommended`: `tools.clarify_tool.mark_recommended` → identidad | Las opciones de `clarify` salen tal cual («✅ Confirmar», sin «(Recommended)»). La limpieza de la respuesta del usuario sigue funcionando. | Aparece «(Recommended)». |
| `send_exec_approval`: `gateway.platforms.base.BasePlatformAdapter.send_exec_approval` envuelto | Sólo si el comando es `<mcp__…> (plugin approval rule)` y la descripción empieza con «✍️ Confirmá: »: pone la acción y el detalle en español y pasa `allow_session=False`, `allow_permanent=False` (quedan Aprobar y Denegar). Cualquier otra aprobación sigue igual. | Tarjeta con el nombre interno y cuatro botones. |

Verificados contra el código real de CT 108 (`BasePlatformAdapter` renderizando la tarjeta con el pack y el parche: «⚠️ Necesito tu confirmación…
/ Reiniciar la ONU / Detalle: Abonado: 2861», botones Aprobar y Denegar), pero no dentro de un gateway vivo. Si una actualización de Hermes los rompe, la matriz de pruebas lo muestra en G8/G9.

## Salud y arranque

Cada vez que el motor carga el plugin (una vez por home: el del host y el de cada perfil) `register` escribe **una** línea de salud, la
última, con el estado de los parches:

```
CLOUDISP_PLUGIN_READY patches=ok version=0.5.0 write_tools=19 middleware=ok locale=ok profile=cloudisp-nvs
CLOUDISP_PLUGIN_READY patches=failed:mark_recommended,send_exec_approval version=0.5.0 ...
```

Nivel `INFO` si todo está bien; `WARNING` si faltó el middleware o el pack de textos; `ERROR` si algún parche falló. Cada parche que no
se pudo aplicar deja además, a `ERROR`, `CLOUDISP_PATCH_FAILED <mark_recommended|send_exec_approval> reason=<Excepción>: <motivo>`, y un
error de los callbacks de identidad o aprobación deja `CLOUDISP_GUARD_ERROR stage=<identity|gate> tool=<herramienta> error=<…>`.

El plugin loguea con `logging.getLogger(__name__)`: bajo el runtime es `hermes_plugins.cloudisp…`, el prefijo que el filtro de
`gateway.log` deja pasar (un logger llamado a secas `cloudisp` sólo llegaría a `agent.log`). Revisión de aceptación:

```bash
grep -h "CLOUDISP_PLUGIN_READY" ~/.hermes/logs/gateway.log ~/.hermes/profiles/cloudisp-*/logs/gateway.log | tail -n 4   # patches=ok en cada uno
grep -h "CLOUDISP_PATCH_FAILED\|CLOUDISP_GUARD_ERROR" ~/.hermes/logs/errors.log ~/.hermes/profiles/cloudisp-*/logs/errors.log  # no debe haber nada
```

## Límites conocidos

- `display.busy_input_mode` queda en `interrupt` (default del motor): un mensaje que llega con una tarea en curso la interrumpe (y cancela una tarjeta de aprobación pendiente). `queue` la pone en cola; se cambia con `hermes config set display.busy_input_mode queue`.
- Con el allowlist por defecto también quedan bloqueados `/stop`, `/approve` y `/deny` (las tarjetas de aprobación usan botones, no comandos); sumalos a `allowed_commands` si hacen falta.
- Un operador por turno: la identidad sale de las variables de sesión del turno.
- El pack de textos reemplaza el idioma `es` y `en` de todo el proceso (el host `default` también lo ve).
- `transform_llm_output` no alcanza el texto que ya se envió en streaming parcial; la regla principal está en el SOUL.
- Un `_operator` falsificado por el modelo se pisa siempre y, si la identidad no se puede derivar, la escritura se bloquea. Sin el plugin cargado
  nada lo pisa: el MCP sólo puede comprobar que el operador **exista** (`CLOUDISP_REQUIRE_OPERATOR=1`), no que sea auténtico, y con `trust: full`
  tampoco habría tarjeta de aprobación. Por eso el plugin tiene que estar habilitado en el host y en el perfil (ver la línea `CLOUDISP_PLUGIN_READY`).
- En un fallo de los callbacks las lecturas salen sin operador sólo si la herramienta es del servidor MCP con el nombre por defecto (`cloudisp`);
  una escritura con nombre de herramienta de CloudISP se bloquea sea cual sea el servidor.

## Pruebas

```bash
cd hermes-plugin && python -m pytest cloudisp/tests    # necesita pytest y pyyaml; no importa Hermes
```
