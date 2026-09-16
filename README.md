# agenda-f1-ingest

Ingestor de calendario de F1 (fuente: jolpica-f1) hacia Supabase, para la agenda de deportistas argentinos.

## 1. Instalar dependencias (local)

```bash
npm install
```

## 2. Probar localmente

Conseguí `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` desde tu panel de Supabase
(Project Settings → API → service_role, NO la anon key).

```bash
SUPABASE_URL="https://tuproyecto.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="tu-service-role-key" \
node ingest-f1.mjs
```

Si sale bien vas a ver algo como:

```
Buscando calendario 2026...
Listo. N sesiones sincronizadas para 2026.
Participaciones sincronizadas.
```

## 3. Subir a GitHub y programarlo

1. Creá un repo (puede ser privado) y subí toda esta carpeta.
2. En el repo: **Settings → Secrets and variables → Actions → New repository secret**
   y cargá `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
3. El workflow en `.github/workflows/ingest-f1.yml` ya está listo: corre
   cada 2 horas automáticamente, y también lo podés disparar a mano desde
   la pestaña **Actions** del repo (botón "Run workflow").

## Notas

- Los días de Gran Premio podés bajar la frecuencia del cron a cada 30 min
  cambiando `'0 */2 * * *'` por `'*/30 * * * *'` en el archivo del workflow.
- Requiere que las tablas `competencias`, `deportistas`, `eventos` y
  `participaciones` ya existan en Supabase, y que el piloto
  `franco-colapinto` esté cargado en `deportistas`.
