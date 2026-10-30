# Control remoto por Telegram

Devia puede controlarse desde Telegram **mientras la aplicación está abierta**.
Un controlador integrado en la app se conecta a tu bot de Telegram y actúa de
puente: lo que escribes por el chat se ejecuta en el proyecto activo, se refleja
en la app y te devuelve la respuesta del agente al móvil.

> No hay ningún servicio en segundo plano: el control remoto solo funciona con
> Devia abierto. Al cerrar la app, el bot deja de responder.

## 1. Crea un bot de Telegram

1. Abre Telegram y habla con [@BotFather](https://t.me/BotFather).
2. Envía `/newbot` y sigue las instrucciones (nombre + usuario del bot).
3. BotFather te dará una **API Key** (token) con este aspecto:
   `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

## 2. Obtén tu Chat ID

El **Chat ID** identifica el único chat autorizado a controlar la app.

1. Abre un chat con tu nuevo bot y envíale cualquier mensaje (p. ej. `hola`).
2. Habla con [@userinfobot](https://t.me/userinfobot) o
   [@RawDataBot](https://t.me/RawDataBot): te dirá tu `id` numérico.
3. Anota ese número (p. ej. `123456789`).

## 3. Configúralo en Devia

1. Cabecera → menú (⋯) → **Configuración** → sección **Control remoto**.
2. En **Telegram**:
   - Activa **Habilitar Telegram**.
   - Pega la **API Key del bot**.
   - Introduce el **Chat ID**.
3. Pulsa **Probar conexión** para verificar el token (te mostrará el `@usuario`
   del bot).
4. Guarda. El indicador de estado pasará a **Conectado**.

La API Key se guarda **cifrada** en tu equipo (llavero del sistema operativo) y
solo el Chat ID que has configurado puede controlar la app.

## 4. Úsalo

Desde el chat de tu bot:

- **Texto libre** → se ejecuta como instrucción en el proyecto activo. Verás la
  ejecución también en la app y, al terminar, recibirás la respuesta del agente.
- **Adjuntos** (imágenes, PDF, documentos, vídeo, audio) → envíalos con un
  **texto/caption** que sea la instrucción. Devia descarga el archivo, lo guarda
  y se lo pasa al agente para que lo lea con su herramienta Read. Puedes mandar
  varios a la vez (un álbum); si los envías **sin caption**, el bot te pedirá que
  los reenvíes con una instrucción.
- `/projects` — lista los proyectos del workspace. Cada línea trae el comando
  `/use <ruta>` listo para copiar y pegar, con 📦 para proyectos ejecutables y
  📂 para carpetas contenedoras. Si el proyecto activo es una carpeta, `/projects`
  muestra su contenido (con un ⬆️ para volver atrás).
- `/use <ruta>` — elige el proyecto o carpeta activa; acepta rutas anidadas
  (p. ej. `/use Eviatech/devia`). Sin argumento usa el último que tenías abierto
  en la app. Si eliges una carpeta contenedora, usa `/projects` para entrar en ella.
- `/status` — proyecto activo, si hay una ejecución en curso, agente y modo.
- `/stop [proyecto]` — detiene la ejecución en curso.
- `/clean [proyecto]` — reinicia la sesión del agente (empieza de cero).
- `/mode plan|apply|yolo` — modo de permisos de las ejecuciones.
- `/agent` — muestra el agente activo.
- `/exec <comando>` o `!<comando>` — ejecuta un comando de shell en el proyecto
  (solo si lo habilitas; ver abajo).
- `/help` — muestra la ayuda con todos los comandos.

En ejecuciones largas recibirás un aviso periódico de que sigue trabajando.

## Sincronizar las conversaciones con el escritorio

La conversación va en los dos sentidos:

- **Telegram → escritorio** (siempre): lo que escribes desde Telegram aparece
  también en el chat de la app, y la respuesta del agente se muestra en ambos
  sitios. En Telegram recibes además un aviso de en qué proyecto se ejecuta.
- **Escritorio → Telegram** (opcional): si activas *Ajustes › Control remoto ›
  Reflejar las conversaciones del escritorio en el chat*, cada conversación que
  inicies en la app se envía también a Telegram: tu mensaje (con `👤`) y la
  respuesta del agente, ambos etiquetados con el proyecto `*[proyecto]*` para
  que sepas de dónde viene.

Las preguntas funcionan **por turnos**: el agente puede preguntarte en texto,
pero libera el proceso para que le respondas en el siguiente mensaje (no hay
diálogos interactivos por Telegram).

> **Privacidad**: reflejar las conversaciones envía tus mensajes y las
> respuestas del agente (que pueden incluir fragmentos de código) a los
> servidores de Telegram. Está **desactivado por defecto**.

## Recibir archivos de Devia

El agente también puede **mandarte archivos al chat**: una captura, un informe,
un CSV exportado, un log largo… Basta con pedirlo con naturalidad:

- «mándame la captura de la home»
- «pásame el CSV con los resultados»
- «envíame el informe en PDF cuando termines»

Si una respuesta es demasiado larga para el chat, el agente puede decidir por su
cuenta enviarla como archivo en lugar de partirla en diez mensajes.

**Cómo llegan**

- Primero recibes la respuesta de texto del agente (con un aviso
  `📎 N archivo(s) a continuación`) y **después** los archivos.
- Si son varios, se agrupan en **álbumes** de hasta 10: fotos y vídeos juntos,
  documentos por un lado y audios por otro. Si el agente añadió un comentario a
  un archivo, aparece como pie de **ese** archivo (también dentro de un álbum).
- Los archivos llegan aunque la ejecución termine con error: el agente ya los
  había preparado y tú los habías pedido.
- Si **detienes** la ejecución (`/stop` o *Detener* en la app), no se envía
  ninguno de sus archivos pendientes: recibes un único aviso
  `⏹️ Ejecución detenida: no envié N archivo(s)`.
- Funciona igual con las conversaciones del escritorio si tienes activado
  *Reflejar las conversaciones del escritorio en el chat*: los archivos de esas
  ejecuciones también llegan a Telegram.
- En la app, cada archivo que el agente envía aparece en el hilo como una
  **tarjeta de archivo** con la etiqueta *Para Telegram*, y desde ella puedes
  abrirlo o mostrarlo en su carpeta. La etiqueta no significa que ya haya
  llegado: Devia lo sube al terminar la respuesta (y no lo sube si detienes la
  ejecución).

**Límites**

- Hasta **50 MB** por archivo (el límite de Telegram para bots). Si es más
  grande, el agente lo sabe y te propondrá comprimirlo o dividirlo.
- Las imágenes (JPG, PNG, WebP) se envían como **foto** hasta 10 MB; por encima,
  o en otros formatos (SVG, GIF, HEIC…), llegan como **documento**.
- Como máximo **10 archivos por ejecución**. Para más, pide que los comprima en
  un `.zip`.
- No se envían carpetas: el agente tiene que comprimirlas antes.

**Qué carpetas puede enviar**

Solo archivos que estén **dentro del workspace** de Devia (la carpeta raíz donde
tienes tus proyectos) y, si la conversación es una sesión aislada, dentro del
**worktree de esa sesión**. Nada fuera de ahí: ni tu carpeta personal, ni
descargas, ni otros discos. Los enlaces simbólicos se resuelven antes de
comprobarlo, así que un enlace dentro del proyecto que apunte fuera tampoco
sirve, y un archivo con **varios enlaces duros** se rechaza siempre (no se
puede saber de dónde viene: copia el archivo y envía la copia).

Además:

- Nada de la **carpeta de datos de Devia** (conversaciones, memoria, adjuntos,
  archivo de `outbox`) sale nunca, aunque esté dentro del workspace.
- Si tu workspace es tu **carpeta personal** (o una carpeta por encima de
  ella), el envío de archivos queda desactivado: elige una carpeta raíz más
  concreta en Devia.
- Justo antes de subirlo, Devia vuelve a comprobar que el archivo es el mismo
  que se validó (mismo archivo, mismo tamaño, no es un enlace). Si ha cambiado
  entretanto, no se envía.

**Qué no se envía nunca**

Todo lo que parezca un secreto o una credencial se rechaza siempre, aunque esté
dentro del proyecto y aunque se lo pidas expresamente. Por ejemplo:

- cualquier archivo `.env*` y variantes (`.env.local`, `.envrc`, `prod.env`,
  `.dev.vars`…);
- claves y certificados (`id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`,
  `*.ppk`…), llaveros y carpetas como `.ssh/`, `.gnupg/`, `.aws/`, `.kube/` o
  la configuración de `gcloud`;
- ficheros de credenciales y tokens (cualquier nombre con `credentials`,
  `secrets.*`, `kubeconfig`, `.npmrc`, `.netrc`, `.pgpass`, `.vault-token`,
  `*.tfvars`, `terraform.tfstate`…);
- historiales de la terminal (`.zsh_history`, `.bash_history`…);
- el interior de `.git/` y la configuración de Devia y de Claude.

Esta lista **no es configurable**: está fijada en el código para que ningún
agente pueda ampliarla.

**Activar o desactivar**

*Ajustes › Control remoto › Permitir que Devia envíe archivos al chat*. Está
**activado por defecto** y el cambio se aplica a la siguiente ejecución, sin
reiniciar el bot. Las restricciones anteriores (carpetas permitidas y archivos
secretos) se aplican siempre, esté como esté el ajuste.

> **Privacidad**: el contenido de los archivos enviados sale de tu equipo y se
> sube a los servidores de Telegram. Si no quieres que eso ocurra nunca,
> desactiva el ajuste.

**Si algo falla**

- Si un archivo no se puede subir (no existe ya, ha cambiado desde que se
  validó, Telegram lo rechaza, el bot se desconectó…), tras la respuesta recibes
  un mensaje `⚠️ No pude enviar: informe.pdf (changed), …` con cada archivo y
  el motivo. Los demás archivos se envían igualmente; si Telegram rechaza un
  álbum entero, Devia reintenta sus archivos uno a uno.
- Si Devia rechaza un archivo que el agente ya había dado por enviado (por
  ejemplo, cambió justo después de pedirlo), también aparece en ese aviso.
- Si el agente pide un archivo no permitido (fuera del workspace, secreto,
  demasiado grande o por encima del límite de 10), se le dice en el momento y
  debería explicártelo en su respuesta.

**Agentes sin herramientas MCP: la carpeta `outbox/`**

Algunos agentes no pueden usar las herramientas de Devia. En ese caso se les
indica que copien el archivo a una carpeta `outbox/` dentro de su directorio de
trabajo: al terminar, Devia la vacía (la guarda en su archivo local) y envía
esos archivos al chat con las mismas reglas y límites. Un archivo de `outbox/`
que no pueda salir (por ejemplo, un secreto) se queda archivado en tu equipo y
aparece en el aviso `⚠️ No pude enviar…`. En **modo plan** el agente no puede
escribir archivos, así que ahí solo funciona si dispone de la herramienta.

> Recomendación: añade `outbox/` al `.gitignore` de tus proyectos. Devia **no**
> lo hace automáticamente, y así evitas que un archivo de paso acabe en un
> commit.

## Seguridad

- **Solo tu Chat ID** puede controlar la app; se ignora cualquier otro chat y los
  mensajes anteriores al arranque.
- Los **comandos de shell** (`/exec`, `!`) están **desactivados por defecto**.
  Actívalos solo si los necesitas, en *Ajustes › Control remoto › Permitir
  comandos de shell*: conceden ejecución de comandos a quien controle el chat.
- La API Key nunca se muestra en registros ni se reenvía al chat.
- El **envío de archivos** al chat solo admite archivos del workspace y nunca
  secretos (ver *Recibir archivos de Devia*). Cada envío queda en el registro de
  auditoría con el nombre y el tamaño del archivo, nunca su contenido.

## Qué no está disponible en remoto

Algunas acciones de la app no tienen sentido por Telegram y no se incluyen
(por ejemplo, los túneles para previsualizar en remoto). Para tareas como
desplegar con Docker puedes usar `/exec docker compose up -d --build` si tienes
habilitado el shell.
