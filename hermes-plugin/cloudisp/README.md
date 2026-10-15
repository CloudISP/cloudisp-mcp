# Plugin `cloudisp` para Hermes

Capa comercial del Asistente CloudISP: lo que el motor de agentes no ofrece como configuración. Se escribió y se
verificó contra Hermes **v0.22.0+139 (`79651b7`)**; `requires_hermes: ">=0.22"`.

| Qué | Cómo |
| --- | --- |
| Sólo comandos de CloudISP | `pre_gateway_dispatch`: `allowed_commands` (por defecto `new`, `guia`, `start`) pasan; `/start` se reescribe a `/guia`; cualquier otro se reescribe a un comando propio que contesta «Ese comando no está disponible…». |
| Corte por cupo | El mismo hook consulta `GET /agent/usage/status` (cache de 60 s por perfil). `exhausted` → «⛔ Se agotó el cupo…» y no se llama al modelo; un error del admin deja pasar el mensaje (el corte duro lo da el ledger). |
| Aviso al 80 % | `transform_llm_output` agrega «⚠️ … más del 80 % del cupo…» a la próxima respuesta, una vez por período (marca en `~/.cache/cloudisp-plugin/warned-*`). |
| `/guia` | `register_command`: devuelve `guia.md` (generada por `npm run guide`) sin pasar por el modelo. |
| Identidad del operador | `pre_tool_call` (`modify`) agrega `_operator` a toda llamada al MCP, desde las variables de sesión. Sin usuario → `_operator: null` (el MCP rechaza la escritura). |
| Aprobación en español | `pre_tool_call` (`approve`): «✍️ Confirmá: <acción> — <argumentos>», con `rule_key` nueva por llamada (ni «sesión» ni «siempre» aprueban otra escritura). Los subagentes que escriben reciben `block`. |
| Consumo | `post_api_request` y `post_auxiliary_call`: `POST /agent/usage` desde un thread (3 s); si falla, cola `usage-spool-<perfil>.jsonl` y reintento (máx. 50) en el siguiente. |
| Marcas fuera | `transform_llm_output` (respuesta), middleware `llm_request` (prompt: host, modelo, proveedor, marca) y un pack de textos `es`/`en` (banner de `/new`, líneas de progreso, comando desconocido). |

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
| `pre_tool_call` `modify` llega al MCP | **Sí**: `agent/tool_executor.py` ejecuta con los args modificados y `registry.dispatch` no valida contra el schema. Cada callback devuelve **una** directiva, por eso hay dos callbacks (`modify` y `approve`/`block`). Una excepción del hook no bloquea la llamada (por eso la identidad es fail-closed en el MCP). |
| Prefijo de las herramientas MCP | `mcp__<servidor>__<herramienta>` (`tools/mcp_tool_schema.py`). |
| Detección de subagente | Los kwargs de `pre_tool_call` son `tool_name, args, task_id, session_id, tool_call_id, turn_id, api_request_id`: **no hay `parent_session_id`**, y `HERMES_SESSION_SOURCE` no vale `subagent`. Se usa `subagent_start(child_session_id)` y `agent.delegation_context.is_delegated_child_context()` (el predicado que usa el propio motor). |
| `approve` muestra la tarjeta con botones | **Sí**: `request_tool_approval` → `send_exec_approval`; Telegram dibuja botones y el texto es el `message`. El encabezado y los botones salen en español con `display.language es`. Límites: el recuadro de código muestra `<mcp__cloudisp__herramienta> (plugin approval rule)` y la tarjeta ofrece «sesión» y «siempre» (sin efecto sobre otras escrituras por la `rule_key` única; «siempre» deja una entrada inútil en la lista de permitidos). `/yolo` y `approvals.mode: off` saltean la tarjeta: `/yolo` queda bloqueado por el allowlist. |
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
| «No hay un canal principal configurado…» | `gateway/run_turn.py::_hmwa_first_contact_notes` | `TELEGRAM_HOME_CHANNEL=<id del usuario autorizado>` en el `.env` del perfil (también `hermes config set TELEGRAM_HOME_CHANNEL <id>`); el pack deja el texto vacío por si falta. |
| Tarjeta de confirmación de `/new` | `approvals.destructive_slash_confirm` (por defecto `true`) | `false` en host y perfil. |
| «Comando desconocido /xyz» | `gateway/run_inbound.py::_hm_unknown_slash_reply` | El hook intercepta antes; el pack lo reemplaza por si llega igual. |

## Límites conocidos

- Con el allowlist por defecto también quedan bloqueados `/stop`, `/approve` y `/deny` (las tarjetas de aprobación usan botones, no comandos); sumalos a `allowed_commands` si hacen falta.
- Un operador por turno: la identidad sale de las variables de sesión del turno.
- El pack de textos reemplaza el idioma `es` y `en` de todo el proceso (el host `default` también lo ve).
- `transform_llm_output` no alcanza el texto que ya se envió en streaming parcial; la regla principal está en el SOUL.
- Un `_operator` falsificado por el modelo se pisa siempre (con `null` si la sesión no tiene usuario), salvo que el hook falle.

## Pruebas

```bash
cd hermes-plugin && python -m pytest cloudisp/tests    # necesita pytest y pyyaml; no importa Hermes
```
