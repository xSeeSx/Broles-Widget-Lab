# Revisión de recargas y retorno a escenas, 2 de noviembre de 2026

Base revisada: `xSeeSx/Broles-Widget-Lab@e6876e3440ff35a878553293b304710feb9d0b44` (widget 2.0.6) y `xSeeSx/Broles-Predicciones-Worker@2980fcddd80a91d016ab8d806004feb06be34869`.

## Casos encontrados

- La primera respuesta `ready` podía fijar el reloj con un `server_now` antiguo. Si ese paquete había quedado en cola, un resultado ya caducado podía reaparecer durante otro intervalo visual.
- Al recibir un evento de retorno a una fuente se representaba la copia local antes de pedir el estado actual. Si esa instancia se había perdido el final, podía volver a mostrar una predicción desactualizada.
- El reloj calculaba el tiempo transcurrido solo con `performance.now()`. Si ese reloj se detiene durante una suspensión y el reloj civil avanza, no bastaba para caducar el resultado al volver.
- Los eventos de visibilidad y actividad de OBS podían emitir solicitudes redundantes. Una primera respuesta perdida se reintentaba según el intervalo normal, en vez del de recuperación.

## Corrección del widget

Al cargar o reactivar una fuente se mantiene oculta la copia local hasta obtener una verificación reciente. Un primer paquete sin correlación no puede fijar el reloj: hace falta una respuesta al `request_id` de esta fuente, con un recorrido máximo de 5 segundos medido tanto con el reloj monotónico como con el civil. Una respuesta `syncing` puede verificar la hora, pero no habilita la representación del estado persistido.

Las diferencias entre ambos relojes fuerzan una nueva verificación, sin hacer avanzar permanentemente el reloj del servidor con un posible cambio de hora local. Las respuestas antiguas no rebobinan la hora ni reinician el plazo. Una respuesta lenta obsoleta tampoco oculta un estado que ya haya sido confirmado por otra más reciente.

Se agrupan los eventos de retorno que ocurren juntos. La recuperación sin primera respuesta se reintenta cada 5 segundos. La limpieza sigue siendo independiente de la conexión y de `animationend`; el plazo continúa anclado a `ended_at` o `locked_at`.

El Worker revisado ya devuelve la hora actual en cada snapshot y conserva `request_id` en las respuestas de sincronización. No necesita un cambio de protocolo para esta reparación. Se ejecutan sus 27 pruebas desde el código del commit indicado, sin credenciales ni llamadas a Twitch.

## Pruebas reproducibles

`node --test tests/predictions-v2-recovery.test.mjs` ejecuta el cliente completo con DOM y relojes controlados. Los 13 casos cubren primer paquete atrasado, respuesta en cola con reloj detenido, retorno tras perderse el final, suspensión, limpieza sin conexión ni eventos CSS, conservación del plazo, caché sin autoridad, eventos OBS duplicados, respuesta inicial syncing, reintento con ambos relojes y con el monotónico detenido, respuesta obsoleta y cancelación caducada.

Contra el cliente anterior, siete casos fallan. Para contrastarlo en un checkout de este repositorio:

```bash
git show e6876e3440ff35a878553293b304710feb9d0b44:src/predictions/client.js > /tmp/broles-client-before-recovery.js
RECOVERY_CLIENT_SOURCE=/tmp/broles-client-before-recovery.js node --test tests/predictions-v2-recovery.test.mjs
node --test tests/predictions-v2-recovery.test.mjs
```

`tests/predictions-v2-recovery-browser.mjs` usa iframes y el widget compilado. Inyecta un primer paquete antiguo después de cargar las fuentes, observa cualquier retirada del atributo `hidden`, retiene y responde a solicitudes de sincronización, comprueba un retorno con final perdido, el plazo original de un resultado reciente y una discontinuidad de reloj provocada. Se ejecuta tanto en CI como sobre la publicación de Pages.

## Alcance

Estas pruebas reproducen fallos deterministas del contrato y del cliente; no emulan CEF, la GPU ni la suspensión real de OBS. Tampoco certifican la configuración del Worker desplegado. El repositorio del puente sigue indicando que el despliegue en el servicio real está pendiente de contrastar su configuración. No se ha modificado ni desplegado Cloudflare durante esta revisión.
