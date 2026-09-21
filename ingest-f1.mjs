// ============================================================
//  Ingestor de F1 — jolpica-f1 → Supabase
//  Corre cada ~2 horas (más seguido los días de Gran Premio).
// ============================================================
//
//  Variables de entorno necesarias:
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY   (la "service_role", no la "anon" —
//                                 esta sí puede escribir, sáltate RLS)
//
//  Uso local:
//    node ingest-f1.mjs
//
//  En producción: Vercel Cron Job o GitHub Action programada.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// jolpica exige un User-Agent identificable, o empieza a limitar/bloquear.
const HEADERS = { 'User-Agent': 'AgendaArgentinos/1.0 (contacto@tudominio.com)' };

// ---------- Pilotos argentinos a seguir ----------
// Agregar acá cuando debute otro (hoy solo Colapinto en la grilla 2026).
const PILOTOS_AR = {
  colapinto: 'franco-colapinto',   // driverId de jolpica → slug en tu tabla `deportistas`
};

// ---------- Sesiones dentro de cada fin de semana de GP ----------
// clave jolpica → { instancia legible }
const SESIONES = [
  { clave: 'FirstPractice',    instancia: 'Práctica Libre 1' },
  { clave: 'SecondPractice',   instancia: 'Práctica Libre 2' },
  { clave: 'ThirdPractice',    instancia: 'Práctica Libre 3' },
  { clave: 'SprintQualifying', instancia: 'Clasificación Sprint' },
  { clave: 'Sprint',           instancia: 'Sprint' },
  { clave: 'Qualifying',       instancia: 'Clasificación' },
];

async function main() {
  const temporada = new Date().getFullYear();
  console.log(`Buscando calendario ${temporada}...`);

  const resp = await fetch(`https://api.jolpi.ca/ergast/f1/${temporada}.json?limit=40`, {
    headers: HEADERS,
  });
  if (!resp.ok) {
    throw new Error(`jolpica respondió ${resp.status}`);
  }
  const data = await resp.json();
  const carreras = data?.MRData?.RaceTable?.Races ?? [];

  if (!carreras.length) {
    console.log('No hay carreras listadas todavía para esta temporada.');
    return;
  }

  // ---------- 1. Competencia (la temporada en sí) ----------
  const { data: competencia, error: errComp } = await supabase
    .from('competencias')
    .upsert(
      {
        slug: `f1-${temporada}`,
        nombre: 'Fórmula 1',
        deporte_id: 3, // ver tabla `deportes` — 3 = f1 en el schema inicial
        temporada: String(temporada),
        prioridad: 10,
      },
      { onConflict: 'slug' }
    )
    .select()
    .single();

  if (errComp) throw errComp;

  // ---------- 2. IDs de los deportistas que vamos a linkear ----------
  const { data: deportistas, error: errDep } = await supabase
    .from('deportistas')
    .select('id, slug')
    .in('slug', Object.values(PILOTOS_AR));

  if (errDep) throw errDep;

  const idPorSlug = Object.fromEntries((deportistas ?? []).map(d => [d.slug, d.id]));

  let eventosCreados = 0;

  for (const carrera of carreras) {
    const sede = `${carrera.Circuit?.Location?.locality ?? ''}, ${carrera.Circuit?.Location?.country ?? ''}`;

    // ---- 2a. Sesiones previas (prácticas, clasi, sprint) ----
    for (const s of SESIONES) {
      const sesion = carrera[s.clave];
      if (!sesion?.date || !sesion?.time) continue; // esta GP no tiene sprint, por ej.

      await upsertEvento({
        fuenteId: `${temporada}-${carrera.round}-${s.clave}`,
        competenciaId: competencia.id,
        comienzaEn: `${sesion.date}T${sesion.time}`,
        titulo: `${carrera.raceName} — ${s.instancia}`,
        instancia: s.instancia,
        sede,
      });
      eventosCreados++;
    }

    // ---- 2b. La carrera ----
    if (carrera.date && carrera.time) {
      await upsertEvento({
        fuenteId: `${temporada}-${carrera.round}-Race`,
        competenciaId: competencia.id,
        comienzaEn: `${carrera.date}T${carrera.time}`,
        titulo: carrera.raceName,
        instancia: 'Carrera',
        sede,
      });
      eventosCreados++;

      // Si la carrera ya pasó, buscamos el resultado del piloto argentino.
      const yaPaso = new Date(`${carrera.date}T${carrera.time}`) < new Date();
      if (yaPaso) {
        await guardarResultadoCarrera(temporada, carrera.round, `${temporada}-${carrera.round}-Race`);
      }
    }
  }

  console.log(`Listo. ${eventosCreados} sesiones sincronizadas para ${temporada}.`);

  // ---------- 3. Participaciones de los pilotos argentinos ----------
  // F1 no tiene "convocados" como el fútbol: si está en la grilla, corre
  // todas las sesiones del fin de semana. Así que linkeamos a todos los
  // eventos de esta temporada que todavía no tengan su participación.
  for (const [driverId, slug] of Object.entries(PILOTOS_AR)) {
    const deportistaId = idPorSlug[slug];
    if (!deportistaId) {
      console.warn(`No encontré a "${slug}" en la tabla deportistas — ¿está cargado?`);
      continue;
    }

    const { data: eventosTemporada } = await supabase
      .from('eventos')
      .select('id')
      .eq('competencia_id', competencia.id)
      .like('fuente_id', `${temporada}-%`);

    if (!eventosTemporada?.length) continue;

    const filas = eventosTemporada.map(e => ({
      evento_id: e.id,
      deportista_id: deportistaId,
    }));

    const { error: errPart } = await supabase
      .from('participaciones')
      .upsert(filas, { onConflict: 'evento_id,deportista_id', ignoreDuplicates: true });

    if (errPart) console.error('Error linkeando participaciones:', errPart.message);
  }

  console.log('Participaciones sincronizadas.');
}

async function guardarResultadoCarrera(temporada, round, fuenteId) {
  try {
    const resp = await fetch(`https://api.jolpi.ca/ergast/f1/${temporada}/${round}/results.json`, { headers: HEADERS });
    if (!resp.ok) return;
    const data = await resp.json();
    const resultados = data?.MRData?.RaceTable?.Races?.[0]?.Results ?? [];

    // Buscamos a cualquiera de nuestros pilotos argentinos en la grilla de resultados.
    const driverIds = Object.keys(PILOTOS_AR);
    const filaPiloto = resultados.find(r => driverIds.includes(r.Driver?.driverId));
    if (!filaPiloto) return; // todavía no está cargado el resultado, o no corrió

    let resultadoTexto;
    if (filaPiloto.positionText && /^\d+$/.test(filaPiloto.positionText)) {
      resultadoTexto = `P${filaPiloto.positionText}`;
    } else {
      // "R" = abandono (retired), "D" = descalificado, etc.
      resultadoTexto = filaPiloto.status || `P${filaPiloto.positionText ?? '?'}`;
    }

    const { error } = await supabase
      .from('eventos')
      .update({ finalizado: true, resultado: resultadoTexto, actualizado_en: new Date().toISOString() })
      .eq('fuente', 'jolpica-f1')
      .eq('fuente_id', fuenteId);

    if (error) console.error(`Error guardando resultado de ${fuenteId}:`, error.message);
  } catch (e) {
    console.warn(`No pude traer el resultado de la carrera ${fuenteId}: ${e.message}`);
  }
}

async function upsertEvento({ fuenteId, competenciaId, comienzaEn, titulo, instancia, sede }) {
  const { error } = await supabase
    .from('eventos')
    .upsert(
      {
        fuente: 'jolpica-f1',
        fuente_id: fuenteId,
        competencia_id: competenciaId,
        comienza_en: comienzaEn, // ISO 8601 con Z → Postgres lo guarda en UTC solo
        titulo,
        instancia,
        sede,
        horario_confirmado: true, // F1 publica horarios fijos, a diferencia del tenis
        actualizado_en: new Date().toISOString(),
      },
      { onConflict: 'fuente,fuente_id' }
    );

  if (error) console.error(`Error guardando "${titulo}":`, error.message);
}

main().catch(err => {
  console.error('El ingestor falló:', err);
  process.exit(1);
});
