# Predicciones y encuestas, rama experimental

Widget: `interacciones-v3`, versión `3.0.0-branch`. Requiere la rama `feat/encuestas-prioridad-predicciones` de Broles-Predicciones-Worker. No sustituye al widget `prediccion-v2` ni publica cambios en la web de producción.

## Comportamiento

- Encuesta activa: pregunta, reloj, entre dos y cinco opciones, nombre, porcentaje y número de votos. Sin multiplicador.
- Al terminar: se usan los totales finales de Twitch. Las perdedoras se funden mientras empieza la expansión, con el bounce y el énfasis del texto ya existentes. Después desaparece el resultado.
- No hay bloqueo de apuestas ni fase STOP en las encuestas.
- Un empate mantiene a todas las ganadoras, que comparten la expansión. Sin votos se muestra "Sin votos" y se sale sin inventar una ganadora.
- Una predicción visible tiene prioridad, incluida su salida. Cuando queda oculta esperando resolución, puede aparecer la encuesta.
- Una resolución de predicción interrumpe la encuesta. Al terminar esa animación, la encuesta solo reaparece si todavía tiene algo vigente que mostrar.
- Los tiempos son absolutos. No se reinicia una encuesta ni se encola un resultado caducado cuando vuelve a tener sitio.
- El reloj a cero espera brevemente los totales confirmados y pide sincronización. Nunca calcula una ganadora a partir de un progreso provisional.

## Laboratorio

Seleccionar "Predicciones y encuestas". El panel "Encuestas" permite pregunta, duración (15 a 1800 segundos), dos a cinco opciones y votos acumulados. "Enviar votos" publica esos totales. La encuesta termina automáticamente o con "Terminar ahora".

Los controles de predicciones existentes funcionan a la vez. El panel de overlays permite duplicar, ocultar y recargar las fuentes. Se puede probar una encuesta durante una predicción, esperar a que el bloqueo oculte la predicción y resolverla para comprobar su prioridad.

Las opciones y sus nombres se fijan al iniciar. Los votos enviados solo aumentan. "Terminar ahora" usa los últimos votos enviados. "Reiniciar encuesta" solo elimina la encuesta de prueba.

## Copiar a StreamElements

En el editor de un Custom Widget, sustituir por completo el contenido de cada pestaña con el archivo correspondiente:

| Pestaña de StreamElements | Archivo |
| --- | --- |
| HTML | `widgets/interacciones-v3/widget.html` |
| CSS | `widgets/interacciones-v3/widget.css` |
| JS | `widgets/interacciones-v3/widget.js` |
| FIELDS | `widgets/interacciones-v3/fields.json` |

`widget.js` está compilado y es autónomo. No se copia `src/app.js`, el harness, los tests ni `widget.json`. El campo `workerUrl` debe apuntar al Worker con soporte v3 desplegado y autorizado. No se incluyen tokens ni secretos en el widget.

El laboratorio ejecuta esos mismos archivos. Simula `onWidgetLoad`, `SE_API.store.get/set`, `kvstore:update` y el WebSocket del Worker. Las respuestas `bridge.state` v3 usan el mismo normalizador y la misma política que el Worker, fijados en `src/interactions/source.json`.

La simulación comprueba formatos y comportamiento del cliente. No conecta a Twitch, no valida OAuth real ni sustituye una prueba en directo con StreamElements, Cloudflare y OBS.

## Verificación

- `node tests/contracts.mjs`
- `node --test tests/predictions-v2-recovery.test.mjs tests/interactions-v3-recovery.test.mjs`
- `node scripts/build-predictions.mjs --check`
- `node scripts/build-interactions.mjs --check`
- Con Playwright y el servidor local en el puerto 4173: `node tests/interactions-v3-browser.mjs`

GitHub Actions conserva todas las pruebas del widget actual y añade el flujo de encuestas, empate, recarga de resultado, prioridad durante bloqueo y resolución, recuperación de encuesta y expansión final.

Referencias oficiales: https://docs.streamelements.com/overlays/custom-widget y https://dev.twitch.tv/docs/api/polls/.
