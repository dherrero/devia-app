# Herramientas de interfaz para cualquier agente (`devia-ui`)

Claude Code dejó de ofrecer su herramienta de preguntas en el modo que usa Devia,
y las tarjetas con botones dejaron de aparecer. Devia ahora sirve sus propias
herramientas de interfaz, y funcionan con **todos los agentes compatibles**, no
solo con Claude.

## Qué hay nuevo

- **Preguntas con opciones** (`devia_ask_user`): el agente te plantea una
  pregunta y respondes con un clic.
- **Lista de pasos** (`devia_todo`): el agente publica su plan y lo va marcando
  a medida que avanza. Se guarda con la sesión.
- **Aprobar el plan** (`devia_plan_approve`): en modo plan, el agente te enseña
  el plan y puedes aprobarlo, aprobarlo y ejecutarlo (Devia pasa la sesión a
  modo aplicar) o rechazarlo con un comentario.
- **Pedir revisión** (`devia_request_review`): el agente abre la vista Cambios
  para que comentes el diff línea a línea.
- **Confirmar acciones** (`devia_confirm`): antes de algo delicado, el agente
  pide permiso. "Permitir siempre" solo vale para esa acción exacta, y nunca se
  ofrece para las marcadas como peligrosas.
- **Elegir ficheros** (`devia_pick`): seleccionas ficheros o carpetas sobre el
  árbol del proyecto.
- **Avisos** (`devia_notify`): notificación del sistema si no estás mirando la
  ventana, y mensaje por Telegram si lo tienes conectado.
- **Skills para todos** (`devia_skill`): cualquier agente puede leer las skills
  del proyecto.
- **Enviar archivos al chat** (`devia_send_file`, S-32): si tienes Telegram
  conectado, el agente puede mandarte capturas, informes o exportaciones al
  chat. Llegan después de su respuesta, agrupados en álbumes (cada archivo con
  su propio comentario), y quedan también como tarjeta "Para Telegram" en el
  hilo de la app. Si detienes la ejecución, sus archivos no se envían. Solo
  archivos del workspace (nunca la carpeta de datos de Devia ni un workspace
  que sea tu carpeta personal), nunca secretos (`.env*`, claves, credenciales,
  historiales…) ni enlaces duros, hasta 50 MB y 10 por ejecución. Detalles en
  `docs/control-remoto-telegram.md`.

## El plan, paso a paso

- Cuando el agente propone un plan, encima del composer solo verás la propuesta.
- Al decidir, el plan **queda en el chat** ("Plan aprobado" o "Plan rechazado", con tu motivo), plegado y sin botones.
- Si lo apruebas y ejecutas, aparece un **stepper** plegado en una línea ("Paso 2/5 · …"). Avanza solo, a medida que el agente termina cada paso.
- Si en un paso el agente necesita algo de ti (confirmar una acción, elegir ficheros), el stepper se abre solo y el formulario aparece **dentro de ese paso**. Al responder, el formulario se convierte en una línea de resumen ("✓ Confirmado: …") y el stepper se vuelve a plegar.
- Las tarjetas ya respondidas desaparecen y no vuelven, y el panel se vacía al terminar la ejecución.
- Si el agente pide una revisión y no hay cambios sin confirmar, se le responde solo en vez de quedarse esperando.

## Desde Telegram

En el chat no hay botones, así que solo se ofrecen las herramientas que no
necesitan una decisión: la lista de pasos, los avisos, las skills y, si el envío
de archivos está activado (*Ajustes › Control remoto › Permitir que Devia envíe
archivos al chat*, activado por defecto), el envío de archivos. Para todo lo
demás, el agente te pregunta en texto con opciones numeradas y respondes en el
siguiente mensaje.

## Ajustes

Nueva sección **Herramientas de interfaz** en Ajustes: puedes desactivar las que
no quieras (cada una muestra cuánto contexto ocupa) y revocar los "permitir
siempre" que hayas concedido en el proyecto activo.

## Cambios internos

- Se retira el servidor `devia-ask` de la versión anterior. Devia limpia solo sus
  entradas de las configuraciones de los proyectos donde ya se usó; si añadiste
  una entrada a mano con ese nombre, se respeta.
- Las comprobaciones con cada agente se harán con el uso. Si alguna herramienta
  falla con un agente concreto, avísanos.
