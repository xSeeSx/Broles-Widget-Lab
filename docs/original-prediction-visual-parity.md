# Conservación visual del widget original

El objetivo de la versión 2.0.1 es conservar las funciones visuales de `widgets/prediccion` y reparar la recepción y recuperación del estado. Esos archivos originales permanecen intactos. La versión nueva utiliza su CSS, estructura de métricas y animaciones; cambia cómo reconstruye y limpia el estado.

| Función original | Comportamiento que debe conservar v2 | Comprobación |
| --- | --- | --- |
| Posición y tamaño | Referencia de 960 px y margen de 100 px | Comparación con el original en el mismo host y modo HTML estándar |
| Tipografía | Manrope, pesos e inclinaciones originales; porcentaje centrado en Franklin Gothic Medium | Propiedades calculadas y posiciones de título, reloj, barras y métricas |
| Barras | Colores amarillo/azul/rojo, gradiente y cortes inclinados; separación compacta | Colores de cada opción y geometría de 2 a 10 opciones |
| Entrada | FadeIn del conjunto de 0,5 s; slideIn de barras con retraso de 0,5 s y escalonado de 150 ms | Barras visibles al terminar el último escalón, incluso con diez opciones |
| Inicio | Reparto equitativo, usuarios iniciales en cero y multiplicador x1.0 | Inspección del widget, sin convertir contadores null del protocolo en ceros persistidos |
| Votación | Anchos animados con la curva original, proporción por puntos y mínimos legibles | Inputs reales, reparto 25/75 y reparto extremo en todos los números de opciones |
| Métricas | Usuarios con icono, separador de miles y multiplicador con estrella | Texto, iconos y posición; detectar solapamiento con multiplicadores grandes |
| Reloj | Cuenta atrás y heartbeat; conserva espacio y desvanece en 0,3 s al cerrar | Opacidad tras bloqueo y clases/animaciones originales |
| Bloqueo | STOP a ambos extremos, barras conservadas y salida tras 15 s | Bloqueo solo, salida y resultado posterior al ocultamiento |
| Resultado | Trofeos a ambos extremos y nueva entrada, también si llega desde active | Resolución directa y tras lock |
| Perdedoras | Comienzan a desvanecerse a los 3,5 s, durante 0,8 s | Fotogramas con opacidad intermedia y estado final |
| Ganadora | Empieza a desplazarse y ampliarse a los 5,5 s, durante 1 s | Ganadoras primera, intermedia y última; 2, 3, 5 y 10 opciones |
| Salida | A los 10,5 s: slideOut de barras de 0,4 s y fadeOut del conjunto de 0,7 s | Ambas animaciones activas y limpieza física a los 11,2 s |
| Fuente recuperada | Retoma la pose de la fase ya transcurrida; no repite la secuencia | Snapshots consumidos a mitad de fade, expansión, salida y después de caducar |

## Reparaciones funcionales que se mantienen

- El resultado se reconstruye aunque falten begin o lock. No depende de clones creados en un evento anterior.
- Las fechas de Twitch gobiernan los plazos compartidos. Recargar, repetir un paquete o leer KV no añade otros once segundos.
- La limpieza elimina barras y título. Se ejecuta con un temporizador independiente de CSS y también al recuperar visibilidad.
- Hay una pose estática final: sin animaciones CSS, la ganadora sigue ocupando su sitio y el resultado caduca.
- Una cancelación no inventa ganador ni muestra trofeos de victoria. El empate de apuestas no selecciona una opción.
- Editar votos deja un borrador; Enviar usa esos totales. Bloquear o resolver conserva los últimos totales enviados y descarta el borrador pendiente, con aviso.
- El texto remoto se inserta como texto, sin interpretar HTML. La caché de StreamElements no puede resucitar por sí sola un resultado.
- La entrada del laboratorio y el módulo del protocolo llevan versión para impedir mezclas con JavaScript anterior conservado en caché.

## Baterías reproducibles

`tests/predictions-v2-visual.mjs` compara el original y comprueba edición manual, empate, resultado directo, fotogramas intermedios, final de movimiento y salida.

`tests/predictions-v2-parity.mjs` recorre las posiciones ganadoras, los tamaños de predicción, el cierre solo, la resolución tardía y fuentes incorporadas en distintas fases. Guarda un informe y capturas en `test-results/parity/`.

Las pruebas de recuperación y estrés existentes se ejecutan después de esas comprobaciones. El repo independiente del puente comprueba también los límites temporales y la persistencia. La política compartida está identificada por commit y hash en `src/predictions/source.json`.

Estas pruebas usan Chromium. Una revisión en una fuente Navegador de OBS real sigue siendo necesaria para acreditar su renderizado y la configuración de StreamElements/Twitch desplegada; el laboratorio no emula el CEF de OBS.
