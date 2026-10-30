# LosBroles Widget Lab

Laboratorio estatico para probar widgets de StreamElements y Twitch sin emitir en directo. Usa HTML, CSS y JavaScript vanilla, no requiere tokens reales, OAuth, secretos ni APIs privadas.

## Estructura

```text
/index.html
/src/app.js
/src/styles.css
/src/fixtures/streamelements/
/src/fixtures/streamelements/chat/
/src/fixtures/twitch/predictions/
/src/harness/se-chat-mock.js
/src/harness/se-mock.js
/src/harness/twitch-eventsub-mock.js
/src/harness/worker-mock.js
/widgets/registry.json
/widgets/demo/widget.json
/widgets/demo/widget.html
/widgets/demo/widget.css
/widgets/demo/widget.js
/widgets/demo/fields.json
/widgets/demo/mocks/
```

## Ejecutar en local

Sirve la carpeta con cualquier servidor HTTP estatico:

```bash
python -m http.server 4173
```

Abre `http://localhost:4173/`.

## GitHub Pages

URL publica: <https://xseesx.github.io/Broles-Widget-Lab/>

El despliegue automatico se ejecuta con GitHub Actions desde `.github/workflows/deploy-pages.yml` y publica la web completa desde la raiz del repositorio. La aplicacion usa rutas relativas y funciona servida desde la ruta de un repositorio, por ejemplo `/Broles-Widget-Lab/`.

## Funcionamiento

- El listado de widgets se carga desde `widgets/registry.json`.
- `widgets/registry.json` es el indice principal del almacen de widgets.
- El selector carga el HTML, CSS, JS, fields y mocks declarados en el registry.
- El laboratorio lee `widget.html`, `widget.css`, `widget.js` y `fields.json`.
- El iframe se construye con `srcdoc` y `sandbox="allow-scripts"`.
- Los mocks de `src/harness/` se inyectan antes de ejecutar el JavaScript del widget.
- El boton `Validate widgets` comprueba campos obligatorios y que los archivos declarados cargan correctamente.
- El modo Debug captura logs del iframe, `console.log`, `console.warn`, `console.error` y errores JS cuando el navegador expone stack.
- El modo Responsive permite presets `1920x1080`, `1280x720`, `960x240`, `800x200`, zoom visual y fondos transparente, gris, chroma y oscuro. El laboratorio arranca en `1280x720` al `75%` para dejar mas area visible del widget.
- La pantalla `Import widget` permite pegar HTML, CSS, JS y `fields JSON`, previsualizar sin guardar, descargar un paquete y copiar la estructura de carpeta.
- La seccion `Chat simulator` emula mensajes de Twitch dentro del formato de chat de StreamElements.
- Los botones emiten payloads mock de StreamElements: `onWidgetLoad`, chat message, follow, subscriber, tip, cheer y `kvstore:update`.
- El editor JSON muestra el payload del ultimo boton usado. Edita el JSON y pulsa el mismo boton para reenviarlo con cambios.
- La validacion JSON aparece en pantalla y bloquea el envio cuando el payload no es valido.
- El panel Prediction Lab simula el ciclo EventSub de predicciones: begin, progress, lock, end y escenarios de stress.
- El panel Worker WebSocket simula los mensajes que llegarian desde el Cloudflare Worker sin conectarse al Worker real por defecto.
- La consola en pantalla recibe logs del laboratorio y del widget aislado.
- Las secciones del panel lateral son colapsables y el panel tiene scroll propio para mantener visible la zona de preview.

## Fase 1: contrato y límites de emulación

La revisión de fidelidad, cobertura, pruebas y escenarios de resultado atascado está en [docs/phase-1-fidelity.md](docs/phase-1-fidelity.md). Para comprobar contratos sin dependencias: `node tests/contracts.mjs`. GitHub Actions ejecuta la misma suite y pruebas de iframes reales en Chromium, con capturas de Demo, Marco, Predicción, almacenamiento y la regresión del resultado atascado. El contraste con StreamElements real y OBS es un paso independiente.

## Mock de StreamElements

`src/harness/se-mock.js` expone dentro del iframe:

- `window.SE_API.store.get(key)`
- `window.SE_API.store.set(key, value)`
- `window.SE_API.sanitize(message)`
- `window.SE_API.cheerFilter(message)`
- `window.SE_API.counters.get(counter)`
- `window.SE_API.setField(key, value)`
- `window.emitSEWidgetLoad({ fieldData, channel, session, recents, currency })`
- `window.emitSEEventReceived({ listener, event })`
- `window.emitSESessionUpdate({ session })`

Los eventos se entregan con `window.addEventListener("onWidgetLoad", handler)`, `window.addEventListener("onEventReceived", handler)` y `window.addEventListener("onSessionUpdate", handler)`, usando `event.detail` como en widgets reales. El canal de prueba usa `username: "losbroles"` y `apiToken: "fake-api-token-never-real"`.

`onWidgetLoad` se emite automáticamente en cada nueva fuente. `SE_API.store` vive fuera del iframe: es compartido por las fuentes de la cuenta simulada y persiste en el mismo navegador al recargar el laboratorio. Cada `set` sobrescribe el objeto completo y notifica a todas las fuentes vivas con `event.data.key = "customWidget.<key>"` y `event.data.value`. No se expone `delete` ni `clear`; el reset de predicciones no borra ese almacenamiento. No se garantiza un retorno Promise de `set`. Los errores del almacenamiento se registran, y un fallo de lectura rechaza el Promise.

Los payloads de ejemplo estan en `src/fixtures/streamelements/`.

## Chat simulator

En StreamElements el chat no llega como `onMessageReceived`. El evento correcto es `onEventReceived` y, para mensajes de chat, `event.detail.listener` debe ser `"message"`. Los datos del mensaje van en `event.detail.event.data`.

La seccion `Chat simulator` construye payloads de Twitch con perfil de streamer, viewer normal, mod o subscriber y los entrega al iframe activo como:

```js
window.dispatchEvent(new CustomEvent("onEventReceived", {
  detail: {
    listener: "message",
    event: {
      data: {}
    }
  }
}));
```

El laboratorio no expone APIs propias al widget para el chat. El widget solo recibe el evento real de StreamElements. Si el sandbox del iframe bloquea el dispatch directo desde la pagina padre, el mensaje entra por `se-mock.js` y se despacha dentro del iframe con el mismo `CustomEvent`.

El chatbox rellena `data.text`, `data.emotes` y `data.tags.emotes`. Si `Parse known Twitch emotes` esta activo, escribir codigos como `Kappa`, `PogChamp`, `LUL`, `BibleThump` o `SeemsGood` calcula los indices `start` y `end` inclusivos y genera el formato Twitch de tags, por ejemplo:

```text
hola Kappa test -> 25:5-9
```

Tambien hay historial visible, debug del ultimo payload enviado, log en la consola del laboratorio y boton `Copy last chat payload`.

Fixtures manuales del chatbox: `src/fixtures/streamelements/chat/manual-tests.json`.

## Mock de Twitch EventSub

`src/harness/twitch-eventsub-mock.js` ofrece un adaptador de laboratorio. El formato siguiente corresponde al puente del Worker, no al sobre nativo de WebSocket de Twitch ni a un evento oficial de StreamElements:

```json
{
  "type": "channel.prediction.begin",
  "subscription": {
    "type": "channel.prediction.begin"
  },
  "event": {}
}
```

Tipos soportados:

- `channel.prediction.begin`
- `channel.prediction.progress`
- `channel.prediction.lock`
- `channel.prediction.end`

El panel permite configurar titulo, duracion, numero de opciones, nombre de cada opcion, usuarios, puntos y `winning_outcome_id`. Cada accion registra en la consola el evento emitido, timestamp y resumen del payload.

Los payloads base estan en `src/fixtures/twitch/predictions/`.

## Mock del Cloudflare Worker

`src/harness/worker-mock.js` sustituye `window.WebSocket` dentro del iframe y, por defecto, intercepta cualquier URL que contenga `/ws`. No se configura ninguna URL real ni se conecta al Worker real por defecto.

Cuando un widget abre `new WebSocket(url)` con una URL que contiene `/ws`, el mock:

- crea una conexion WebSocket compatible con `send`, `close`, `onopen`, `onmessage`, `onerror`, `onclose` y `addEventListener`;
- envia automaticamente `{ "type": "welcome", "session_id": "mock-session-id" }`;
- registra en la consola del laboratorio los mensajes enviados por el widget;
- permite broadcasts desde el panel hacia todas las conexiones WebSocket mock abiertas en los iframes.

El panel Worker WebSocket incluye:

- toggle `Interceptar WebSocket del Worker`;
- campo informativo `Worker URL real`, vacio por defecto;
- botones para enviar `welcome`, `bridge.error` y predicciones `begin`, `progress`, `lock`, `end`;
- consola de conexiones WebSocket mock.

Cuando el widget activo es `Prediccion`, el laboratorio tambien reenvia los eventos del panel `Prediction Lab` por el WebSocket mock, porque ese widget real espera recibir predicciones como JSON de Worker y no escucha el evento interno `twitch:eventsub`.

Los mensajes de prediccion enviados por el mock del Worker mantienen el contrato adaptado del puente de Los Broles:

```json
{
  "type": "channel.prediction.progress",
  "subscription": {
    "type": "channel.prediction.progress"
  },
  "event": {}
}
```

## Prediction torture testing

`Prediction Lab` es el panel recomendado para probar predicciones en uso normal. Esta organizado en:

- `Prediction setup`: modo Twitch/stress, titulo, duracion, numero de opciones, presets 2/3/5/10, ganador seleccionado, outcomes, validacion y estado interno.
- `Vote generator`: patrones de votos y `Send progress` para emitir `channel.prediction.progress` con los votos actuales.
- `Normal flow`: `Begin`, `Progress`, `Lock`, `End selected winner` y `Cancel`.
- `Stress scenarios`: casos raros de directo como `Begin 1s stress`, `active_expired`, lock sin resolver, fade tras lock, end tardio y reset del estado del laboratorio.

En `Twitch valid mode` aplica los limites oficiales usados por Twitch: 2-10 outcomes, titulo de prediccion de hasta 45 caracteres, titulo de outcome de hasta 25 caracteres y `prediction_window` entre 30 y 1800 segundos. En este modo cada Begin crea un ID nuevo, se impide tener dos predicciones sin resolver y la ventana programa un lock automático; ese temporizador se cancela al resolver, reiniciar o sustituir la predicción. Begin no inventa contadores de votos que Twitch no envía.

En `Stress mode` se pueden generar duraciones cortas como 1s, `locks_at` en pasado, progress tras expiracion y eventos fuera de orden.

Para el widget real `Prediccion`, los eventos relevantes son los del Worker WebSocket. Los eventos directos del panel Twitch Predictions pueden reenviarse al Worker mock por compatibilidad, pero el widget importado escucha mensajes JSON por WebSocket, no el evento interno `twitch:eventsub`. Los botones de bajo nivel del panel `Worker WebSocket` quedan dentro de `Worker debug actions`; para el flujo habitual usa `Prediction Lab`.

El laboratorio guarda `currentPrediction`, `predictionHistory`, `lastPredictionPayload`, `currentPredictionStatus` y `currentPredictionStage`. El Worker mock soporta replay en conexiones nuevas:

- `welcome only` mantiene el comportamiento por defecto.
- `none` no envia nada al conectar.
- `last payload` reenvia el ultimo payload.
- `current prediction snapshot` reenvia el estado actual.
- `full history` reenvia el historial completo.

La seccion `Overlay / OBS scenarios` permite ocultar una fuente, mostrarla, refrescarla como Browser Source, desactivar/activar escena, duplicar el widget como Overlay A/B y elegir el destino del Worker con el selector `Destino Worker`. Cambiar ese selector no emite payloads; para reenviar estado usa explicitamente `Replay last payload`, `Replay current prediction` o `Replay full history`.

Modos de overlay oculto:

- `Deliver while hidden`: solo oculta visualmente el iframe. El widget sigue cargado y recibe eventos.
- `Skip delivery while hidden`: inyección de fallos que excluye overlays ocultos del enrutador del Worker. No es un apagado real de OBS ni desactiva las notificaciones compartidas de SE store.
- `Destroy iframe when hidden`: elimina el iframe y sus conexiones WebSocket. Al mostrarlo se recrea desde el widget cargado y depende del `Replay mode` configurado para recuperar o no estado.

Cada overlay tiene su propio WebSocket mock y los broadcasts pueden llegar a ambas instancias cuando el destino es `Broadcast to all overlays`.

Para reproducir el bug de overlays:

1. Selecciona `Prediccion`.
2. Pulsa `onWidgetLoad`.
3. Cambia a `Stress mode`.
4. Pulsa `Begin 1s stress`.
5. Pulsa `Active expired, no lock, no end`.
6. Pulsa `Lock sin resolver` o `Lock y esperar fade`.
7. Espera 16 segundos si quieres forzar el ocultado interno tras lock.
8. Usa `Hide source`, `Refresh source` o `Duplicate overlay instance`.
9. Pulsa `End despues de lock tardio`.
10. Observa si el widget queda en un estado visual colgado o desincronizado entre Overlay A y Overlay B.

El escenario `Result + B disconnect + scene switch (stress)` explora el título/trofeos atascados: termina una predicción en A/B, corta el socket B durante el resultado y cambia de escena tras 12 segundos. El corte es una inyección explícita, no una causa atribuida automáticamente a OBS. Consultar la matriz completa en `docs/phase-1-fidelity.md`.

## Almacen de widgets

`widgets/registry.json` es la fuente principal. Cada entrada debe incluir:

```json
{
  "id": "demo",
  "name": "Demo widget",
  "description": "Descripcion breve",
  "version": "0.1.0",
  "author": "LosBroles",
  "category": "demo",
  "width": 800,
  "height": 200,
  "html": "widgets/demo/widget.html",
  "css": "widgets/demo/widget.css",
  "js": "widgets/demo/widget.js",
  "fields": "widgets/demo/fields.json",
  "mocks": "widgets/demo/mocks/index.json",
  "notes": "Notas internas"
}
```

El validador del laboratorio comprueba campos obligatorios, dimensiones positivas y carga de `html`, `css`, `js`, `fields` y `mocks`. Los errores se muestran en pantalla.

## Importador manual

La pantalla `Import widget` crea un paquete local desde archivos pegados. No usa GitHub API, no escribe en el repositorio desde el navegador y no guarda nada de forma permanente.

Campos disponibles:

- `id`
- `name`
- `description`
- `width`
- `height`
- `HTML`
- `CSS`
- `JS`
- `fields JSON`

Acciones:

- `Preview without saving`: carga el widget pegado en el iframe con los mocks del laboratorio, sin modificar `widgets/registry.json`.
- `Download widget package`: descarga un `.zip` con una carpeta lista para colocar en el repo.
- `Copy folder structure`: copia el arbol esperado y una entrada de registry para usarla como referencia.

El paquete generado incluye:

```text
widgets/{id}/widget.json
widgets/{id}/widget.html
widgets/{id}/widget.css
widgets/{id}/widget.js
widgets/{id}/fields.json
widgets/{id}/mocks/index.json
```

Los cinco primeros archivos son la base compatible del widget. `mocks/index.json` se incluye vacio para que el widget pueda registrarse en el almacen actual y pasar `Validate widgets`.

Para guardar de verdad un widget importado:

1. Extrae el paquete dentro del repositorio.
2. Anade la entrada generada a `widgets/registry.json`.
3. Ejecuta `Validate widgets`.
4. Haz commit y push de esos archivos.

## Crear widgets

1. Crea una carpeta dentro de `widgets/`.
2. Anade `widget.html`, `widget.css`, `widget.js`, `fields.json` y mocks locales.
3. Registra el widget completo en `widgets/registry.json`.
4. Ejecuta `Validate widgets` antes de commitear.
