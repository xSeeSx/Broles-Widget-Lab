# Fase 1: fidelidad del laboratorio

Revisión de contrato: 2026-10-30.

## Alcance y estado

Esta fase modifica el laboratorio. El widget importado en `widgets/prediccion/` se conserva íntegro como referencia con fallos conocidos. No se ha modificado el Worker desplegado ni se ha iniciado el widget de la fase 3.

El laboratorio reproduce contratos y ciclos de vida para detectar errores. No certifica equivalencia completa con StreamElements, sus servidores, OBS ni CEF. Las pruebas de contrato se ejecutan con dobles de eventos y reloj; no son pruebas visuales del navegador.

## Qué se comprueba

| Superficie | Comportamiento implementado | Límite |
|---|---|---|
| `onWidgetLoad` | Automático al cargar cada iframe, incluidos B y recargas; campos y datos iniciales | El botón manual sigue disponible para inyectar cargas adicionales |
| `SE_API.store.get` | Promise con objeto completo, copias independientes | Clave ausente devuelve undefined, elección del mock no garantizada por la documentación |
| `SE_API.store.set` | Sobrescritura completa, compartida por cuenta simulada, sin Promise garantizada | Sin transacciones, CAS, bloqueo de escritores ni garantía de orden entre dispositivos |
| Persistencia | Fuera del iframe, localStorage de la página del laboratorio | Mismo navegador/origen, no nube; si falla se informa. Un fallo de lectura/escritura se registra, nunca se anuncia como éxito |
| `kvstore:update` | `detail.event.data.key = customWidget.<key>` y `value`, para fuentes vivas A/B y escritor | La latencia de Internet y la entrega del servidor SE no se reproducen |
| API auxiliar | counters.get devuelve {id,count}; getOverlayStatus y sanitize tienen forma documentada | Sin filtros de palabras de una cuenta real, getOverlayStatus fijo en modo editor; setField y cola no emulan todas las funciones del editor |
| Predicciones | Begin sin contadores; progress/lock/end con campos propios y nulls | Votos y premios sintéticos, no algoritmo económico de Twitch |
| Twitch valid mode | Identificador nuevo por Begin, una predicción sin resolver, cierre automático al vencer la ventana, sin votos tras lock, configuración inmutable durante la predicción | No ejecuta OAuth, límites de frecuencia, resolución automática a las 24 horas ni Helix |
| Stress | Eventos explícitos sin completar con fixtures; controles de errores y pérdida de entrega | Son inyecciones de fallos, no comportamientos normales garantizados |
| WebSocket del Worker | Welcome por defecto, recuento de OPEN, reset borra nulls, replay explícito | Es el protocolo del puente de Los Broles, no el WebSocket nativo de Twitch |
| Escena oculta viva | Deliver conserva documento, conexión y eventos | No reproduce throttling de temporizadores, suspensión ni renderizado de CEF |
| Escena apagada | Destroy elimina iframe y conexiones, Show crea una instancia nueva | El estado recuperado depende del protocolo Worker y de lo que haga el widget con SE store |

El almacenamiento se comparte con las fuentes vivas aunque el destino del Worker sea A o B. `Skip delivery while hidden` descarta eventos del Worker y de los emisores manuales que usan el enrutador; no simula apagar la cuenta ni perder las notificaciones del almacenamiento.

El estado de predicción del servidor simulado vive en la página padre y sobrevive a recrear iframes. Recargar toda la página reinicia ese servidor simulado. El almacenamiento SE persiste por separado. La fase 2 debe definir la reconciliación con Helix antes de construir un mock de esa ruta.

## Tres contratos diferentes

1. StreamElements: eventos DOM `onWidgetLoad`, `onEventReceived`, `onSessionUpdate`.
2. Twitch EventSub: notificaciones con `subscription` y `event`; sobre WebSocket nativo van dentro de `metadata` y `payload`. No se ha implementado ese transporte nativo, su autenticación, suscripciones, keepalive o reconnect.
3. Puente Worker de Los Broles: JSON `{type, subscription, event}` por la conexión del overlay. El `type` superior es una adaptación del puente, no un campo del evento de Twitch. `twitch:eventsub` es un adaptador del laboratorio para demos, no un evento oficial de StreamElements.

Los modos last payload, current snapshot y full history son herramientas explícitas del laboratorio. Twitch no reenvía eventos perdidos al reconectar. Activar uno de estos modos no prueba que el Worker de producción ofrezca recuperación.

## Regresión prioritaria: título y trofeos atascados en otro overlay

No asumir una única causa. Probar estas variantes con el mismo resultado y tiempos absolutos:

| Variante | Pasos | Comportamiento exigido a la versión robusta |
|---|---|---|
| B vivo y oculto | A/B reciben begin, progress, lock y end; B se oculta con Deliver; esperar a que caduque el resultado; mostrar B | No debe quedar título/trofeo ni reiniciarse su vida visible |
| B pierde el end | B recibe hasta lock; Skip mientras A recibe end; mostrar B | Debe reconciliar el estado y no mantener STOP |
| B apagado | Destroy B antes del end; A recibe end; recrear B después | Debe obtener estado actual y no presentar un resultado antiguo como nuevo |
| B se desconecta durante resultado | Ambos reciben el ciclo; cerrar WS de B durante end; esperar; mostrar B | Reconectar no puede cancelar definitivamente la limpieza del resultado |
| Nueva predicción después | Terminar P1; empezar P2; reenviar end de P1 por JSON/replay | P1 no puede sobrescribir u ocultar P2 |

El botón **Result + B disconnect + scene switch (stress)** prepara dos overlays, espera conexiones reales del mock, emite el ciclo, corta la conexión B durante el resultado y cambia a B 12 segundos después. La desconexión es una inyección explícita para explorar un mecanismo candidato. No demuestra la causa de un fallo concreto en OBS. Los 12 segundos corresponden al resultado de 10 segundos más margen del widget legado; no son un límite de Twitch ni una política definitiva para el widget futuro. El replay mode seleccionado se registra y se respeta.

Para las variantes sin desconexión, usar los controles existentes: destino all, Duplicate B, Deliver/Skip/Destroy, Begin/Progress/Lock/End y Hide/Show/Refresh. Repetir con replay welcome y los modos explícitos, registrando qué recibió cada overlay.

La versión actual puede fallar estos criterios. En fase 1 interesa poder observar ese fallo; no se debe ocultar modificando el mock para reconstruirle un begin artificial.

## Validación

Ejecutar:

```bash
node tests/contracts.mjs
```

La suite cubre almacenamiento compartido y persistente, notificaciones, sobrescritura, errores de lectura, carga automática, forma de eventos, ausencia de relleno artificial, URL de producción interceptada, recuento de conexiones, reset, historial, IDs nuevos, temporizadores por predicción y entrega A/B.

GitHub Actions también ejecuta `tests/browser-smoke.mjs` en Chromium real. Comprueba carga de Demo, DOM de Marco, begin de Predicción, SE_API.store entre iframes A/B, destroy/show/refresh y persistencia al recargar la página. Guarda capturas en el artefacto `lab-browser-smoke`. Incluye una reproducción explícita del fallo legado de trofeos tras desconexión durante el resultado: ese fallo del widget de referencia es esperado, no es un criterio de éxito de la versión futura.

Para ejecutar esa comprobación fuera de CI, instalar `playwright@1.64.1`, ejecutar `npx playwright install chromium`, servir la raíz en 127.0.0.1:4173 y lanzar `node tests/browser-smoke.mjs`.

Pendiente de contraste externo: una captura de eventos de StreamElements real y las variantes de escena en OBS con sus opciones de apagar/refrescar fuente anotadas. La revisión no tuvo acceso al navegador personal conectado ni a OBS. Chromium en CI no sustituye ese contraste.

## Fuentes oficiales

- https://docs.streamelements.com/overlays/custom-widget
- https://docs.streamelements.com/overlays/events
- https://docs.streamelements.com/overlays/widget-structure
- https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelpredictionbegin
- https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-prediction-begin-event
- https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
- https://dev.twitch.tv/docs/api/reference/#create-prediction
- https://dev.twitch.tv/docs/api/reference/#end-prediction
