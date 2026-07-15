# TODO — fixtures reales del spike Claude Code v2.1.210

Aquí van las 5 líneas reales de payloads de hook capturadas en el spike
v2.1.210 (una por fichero, `NN-<hook-event>.json`, bytes tal cual salieron
del hook — sin re-formatear). Pendiente de que Rebeca las pase (F1.1 punto 4).

Mientras no existan, `cchook.test.ts` cubre el roundtrip con un payload
sintético con la forma de un PostToolUse y recoge automáticamente cualquier
`*.json` que se deje en este directorio (cero cambios de código al añadirlas).
