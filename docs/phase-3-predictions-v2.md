# Fase 3: widget de predicciones v2

La versión nueva es `widgets/prediccion-v2`. La referencia original sigue en `widgets/prediccion` y conserva sus pruebas, incluida la reproducción del resultado atascado. El código del puente pertenece al repositorio independiente [Broles-Predicciones-Worker](https://github.com/xSeeSx/Broles-Predicciones-Worker), no al recolector de estadísticas.

## Probar en el laboratorio

Seleccionar **Predicción v2** y pulsar **Iniciar predicción**. Aplicar y enviar votos, duplicar el overlay B y recargarlo a mitad del ciclo. La versión nueva se reconstruye desde un snapshot sin necesitar begin. El generador y los controles del laboratorio conservan el contrato EventSub del legado.

El mock reconoce `/ws/v2`: entrega estado completo al conectar y al recibir `bridge.sync`. Su dataset Helix simulado conserva el último estado completo. Un begin continúa sin incluir contadores; la consulta simulada proporciona los ceros iniciales de esa predicción del generador. El protocolo legado conserva las opciones de replay configurables. El mock no ejecuta OAuth ni contacta con Twitch.

El escenario **Result + B disconnect + scene switch (stress)** corta el socket de B durante el resultado y vuelve a B doce segundos después. En el legado reproduce trofeos atascados; en v2 deben estar ocultos y el título vacío. Es una inyección de fallo concreta, no una afirmación de que OBS corte sockets al ocultar fuentes.

## Instalar en StreamElements

Primero desplegar y verificar el puente v2 en el Worker correcto. Después copiar el contenido completo de estas pestañas:

- HTML: `widgets/prediccion-v2/widget.html`.
- CSS: `widgets/prediccion-v2/widget.css`.
- JS: `widgets/prediccion-v2/widget.js`, autocontenido y generado a partir de `src/predictions/`.
- Fields: `widgets/prediccion-v2/fields.json`.

El campo `workerUrl` apunta a `wss://losbroles.lessergio.workers.dev/ws/v2?broadcaster_id=133649243`. El Worker antiguo no implementa ese endpoint. Publicar solo el widget nuevo sin actualizar primero el puente dejaría la fuente sin sincronización.

La posición y el ancho visual mantienen la referencia de 960 px con margen de 100 px. Se conservan Manrope, barras inclinadas y los colores amarillo, azul y rojo. El layout se ajusta entre dos y diez opciones; los porcentajes son los reales por puntos y los multiplicadores son orientativos. Antes de recibir los contadores, los porcentajes muestran el reparto inicial equitativo de la referencia original. Los contadores desconocidos siguen siendo null en el estado y los usuarios muestran el cero inicial de la referencia durante active si aún faltan contadores. Ese cero visual no sustituye el null del protocolo ni se persiste como dato real. El texto de Twitch se inserta con textContent.

## Recuperación y persistencia

La clave compartida `brolesPredictions133649243v2` guarda `{schemaVersion:2,snapshot}`. El widget lee esa caché al cargar, incluye su revisión conocida al pedir sincronización y confirma el estado con el puente antes de mostrarlo. No usa localStorage, cookies ni IndexedDB del iframe. La versión del servidor prevalece sobre lecturas tardías y escrituras KV invertidas. El eco KV puede solicitar resync, nunca inicia otra escritura en bucle.

Las transiciones se guardan inmediatamente; progress se agrupa durante un segundo. `store.set` no se trata como un acuse Promise garantizado. Un error de almacenamiento no impide que la pantalla siga recibiendo el servidor. Un snapshot confirmado con prediction=null limpia el widget y guarda el estado vacío versionado.

El reloj usa server_now y una estimación mediante solicitud/respuesta, apoyada en performance.now. Su precisión depende de la latencia y la asimetría de la red. Se compara siempre con fechas absolutas: el bloqueo inicia su salida a los quince segundos y se limpia a los 15,7; el resultado inicia su salida a los 10,5 y se limpia a los 11,2. Una recarga a los ocho segundos del resultado deja unos 3,2 segundos de su secuencia original, sin reiniciarla.

El render vuelve a comprobar el plazo al recibir estado, al recuperar visibilidad y mediante su temporizador independiente. Tras la entrada original de medio segundo, a los 3,5 segundos del resultado empiezan a desaparecer las barras perdedoras y a los 5,5 se amplía la ganadora. A los 10,5 se conservan la salida de las barras con slideOut y el fadeOut del conjunto. Al llegar al plazo se fuerzan hidden, título vacío y eliminación de barras. No depende de animationend ni de clones creados previamente durante lock. Un resultado cancelado no muestra trofeos.

## Comprobaciones

```bash
node tests/contracts.mjs
node scripts/build-predictions.mjs --check
# Con Playwright/Chromium y servidor HTTP en 127.0.0.1:4173:
node tests/browser-smoke.mjs
node tests/predictions-v2-browser.mjs
```

Las pruebas nuevas usan el widget real dentro de iframes y comprueban recuperación activa y bloqueada, final sin lock, cancelación, diez opciones, texto que parece HTML, replay sin reiniciar plazo, KV antiguo, recarga después de caducar y cambio de escena tras una desconexión durante end. Un contexto separado comprueba que ni un resultado reciente en SE_API.store aparece sin confirmación del puente. El repo del Worker tiene sus propias pruebas de carreras, persistencia, OAuth y upstream.

`src/predictions/state.mjs` es una copia versionada del protocolo del puente. `src/predictions/source.json` identifica su revisión y hash. El script de compilación comprueba ese hash y genera el JS para pegar en StreamElements; no se editan directamente las copias generadas.

## Pendiente de validar en el entorno real

No se ha desplegado el Worker de Cloudflare ni se han cambiado sus enlaces o secretos. Hay que contrastar su namespace y backend de Durable Objects y su historial de migraciones antes de conectar Builds al repositorio nuevo. El README de ese proyecto explica actualización y rollback. Las pruebas automatizadas no acreditan esos recursos ni la configuración OAuth desplegada.

La revisión final debe hacerse en una fuente Navegador de OBS real: fuente viva oculta, apagado de la fuente al ocultarla, recarga, resolución en otra escena, recuperación después del plazo y una predicción nueva tras la anterior. La vista `?view=obs&widget=prediccion-v2&controls=1` usa el renderer real de OBS cuando se abre dentro de OBS; el laboratorio del navegador no emula CEF.

## Regresiones visuales y controles

Se ha restaurado el CSS original, la estructura de métricas con iconos, la entrada escalonada de barras y los STOP en ambos extremos. El resultado reinicia su entrada una sola vez incluso si llega directamente desde active. Las barras existentes se fijan en su posición al resolver; la perdedora se desvanece a los 3,5 segundos y la ganadora se desplaza y amplía a los 5,5, aunque no haya habido lock. El plazo absoluto sigue limpiando el DOM sin depender de animationend. Los porcentajes iniciales vuelven al reparto equitativo y el cálculo del ancho conserva las proporciones reales salvo el mínimo necesario para leer opciones pequeñas.

El laboratorio incluye **Empate exacto de puntos**. Begin limpia la selección del resultado; Resolver exige elegirlo expresamente. Un reparto igualado no determina el resultado de Twitch ni provoca por sí solo una victoria o cancelación.

Los dos botones de envío usan los campos numéricos actuales como totales acumulados. El laboratorio muestra los totales enviados y bloquea una bajada en modo Twitch, con un aviso junto a los controles, en vez de emitirla y mostrar cifras distintas porque el puente conserva los máximos. Iniciar otra predicción pone los contadores a cero. El preset de empate iguala a los totales más altos existentes para no provocar una bajada. La batería visual edita los inputs reales, verifica 25/75 en porcentajes, geometría y almacenamiento, y compara tipografía y posiciones verticales con los archivos originales.

La comparación función por función y sus criterios de aceptación están en [Conservación visual del original](original-prediction-visual-parity.md).
