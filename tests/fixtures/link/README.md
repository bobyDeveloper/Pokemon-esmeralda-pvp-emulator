# ROMs diagnósticas Link

Binarios de prueba MIT, sin ROMs comerciales ni BIOS, copiados sin modificar de
`mattrbeck/dingbat`, commit `91709f81223ee6a8be61e251466a7d748141d458`.
Se conserva la licencia del repositorio en `LICENSE`.

Fuentes originales: https://github.com/mattrbeck/dingbat/tree/91709f81223ee6a8be61e251466a7d748141d458/tests/roms

| Binario | SHA-256 |
| --- | --- |
| attachtest.gba | 4dc489ba2990e3c91219a57080d2572028d1e44a92ca2cf6aab91bdd70d31506 |
| linktest.gba | e4ff0b32961571cbc857d4885a3495ea1bd73066c4957786e0bf62bb740fc09a |
| normlinktest.gba | ab1506603ae2f6d73fd4a147fb66141af2113697158ef96a2ebf677ef4f03b1f |
| norm32linktest.gba | 86c7a9dc848001e59c3c6135a218b42f90d284924805a9facfd0747278290756 |

Son programas ARM sin cabecera. El harness aislado los carga en MEMFS después
de inicializar el adaptador con la ROM diagnóstica propia. No se modifica la
validación de archivos de la aplicación ni se usa su IndexedDB real.
`attachtest` admite conectar después del arranque; las otras tres ROMs deben
tener el cable instalado antes de su primera instrucción (fijan su rol al arrancar).
