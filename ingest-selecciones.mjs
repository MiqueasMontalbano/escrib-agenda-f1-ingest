// ============================================================
//  Ingestor de Selecciones Nacionales — Básquet, Rugby, Vóley, Hockey
//  (TheSportsDB → Supabase)
//  Corre cada ~2 horas.
// ============================================================
//
//  Variables de entorno necesarias:
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//
//  No necesita API key propia (usa la key pública de prueba "3" de
//  TheSportsDB, igual que el ingestor de la Selección de fútbol).
//
//  IMPORTANTE — antes de correr esto necesitás tener cargadas en tu
//  tabla `deportistas` estas filas (mismo formato que "seleccion-argentina"):
//    slug: seleccion-basquet-argentina   | nombre: Selección Argentina (Básquet)
//    slug: los-pumas                     | nombre: Los Pumas (Rugby)
//    slug: seleccion-voley-argentina     | nombre: Selección Argentina (Vóley)
//    slug: las-leonas                    | nombre: Las Leonas (Hockey)
//    slug: los-leones                    | nombre: Los Leones (Hockey)
//
//  Uso local:
//    node ingest-selecciones.mjs
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SPORTSDB_KEY  = process.env.THESPORTSDB_API_KEY || '3';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const SPORTSDB_BASE = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}`;

// ---------- selecciones a seguir ----------
// teamId: null significa "buscalo por nombre" (se resuelve solo la primera vez)
const SELECCIONES = [
  { deporteSlug: 'futbol',  deportistaSlug: 'seleccion-argentina-futbol', teamId: '134509', teamNombreBusqueda: 'Argentina' },
  { deporteSlug: 'basquet', deportistaSlug: 'seleccion-basquet-argentina', teamId: '136736', teamNombreBusqueda: 'Argentina Basketball' },
  { deporteSlug: 'rugby',   deportistaSlug: 'los-pumas',                   teamId: '137124', teamNombreBusqueda: 'Argentina Rugby' },
  { deporteSlug: 'voley',   deportistaSlug: 'seleccion-voley-argentina',   teamId: '141818', teamNombreBusqueda: 'Argentina Volleyball' },
  { deporteSlug: 'hockey',  deportistaSlug: 'las-leonas',                  teamId: '141709', teamNombreBusqueda: 'Argentina Hockey Women' },
  { deporteSlug: 'hockey',  deportistaSlug: 'los-leones',                  teamId: '136712', teamNombreBusqueda: 'Argentina Hockey' },
];

async function sportsDbGet(path, reintentos = 2) {
  const resp = await fetch(`${SPORTSDB_BASE}${path}`);
  if (resp.status === 429 || resp.status === 403) {
    if (reintentos > 0) {
      console.warn(`TheSportsDB nos frenó (${resp.status}), espero 30s y reintento...`);
      await new Promise(r => setTimeout(r, 30000));
      return sportsDbGet(path, reintentos - 1);
    }
  }
  if (!resp.ok) {
    throw new Error(`TheSportsDB respondió ${resp.status}`);
  }
  return resp.json();
}

async function resolverTeamId(seleccion) {
  if (seleccion.teamId) return seleccion.teamId;

  const data = await sportsDbGet(`/searchteams.php?t=${encodeURIComponent(seleccion.teamNombreBusqueda)}`);
  const encontrado = data?.teams?.[0];
  if (!encontrado) {
    console.warn(`No encontré el equipo "${seleccion.teamNombreBusqueda}" en TheSportsDB.`);
    return null;
  }
  console.log(`Resolví "${seleccion.teamNombreBusqueda}" → id ${encontrado.idTeam} (${encontrado.strTeam})`);
  return encontrado.idTeam;
}

async function asegurarDeporte(slug, nombreLindo) {
  const { data: existente } = await supabase.from('deportes').select('id').eq('slug', slug).maybeSingle();
  if (existente) return existente.id;

  const { data: nuevo, error } = await supabase
    .from('deportes').insert({ slug, nombre: nombreLindo }).select().single();
  if (error) throw error;
  console.log(`Creé el deporte "${slug}" con id ${nuevo.id}.`);
  return nuevo.id;
}

const NOMBRES_DEPORTES = {
  basquet: 'Básquet',
  rugby: 'Rugby',
  voley: 'Vóley',
  hockey: 'Hockey',
};

async function guardarPartido(p, seleccion, deporteId, deportista) {
  if (!p.dateEvent) return false;

  const horaConfirmada = !!p.strTime && p.strTime !== '00:00:00';
  const comienzaEn = horaConfirmada ? `${p.dateEvent}T${p.strTime}Z` : `${p.dateEvent}T12:00:00Z`;
  const nombreLiga = p.strLeague ?? NOMBRES_DEPORTES[seleccion.deporteSlug];
  const anio = p.dateEvent.slice(0, 4);
  const slugComp = `${seleccion.deporteSlug}-${nombreLiga.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${anio}`;

  const { data: competencia, error: errComp } = await supabase
    .from('competencias')
    .upsert(
      { slug: slugComp, nombre: nombreLiga, deporte_id: deporteId, temporada: anio, prioridad: 5 },
      { onConflict: 'slug' }
    )
    .select()
    .single();

  if (errComp) { console.error(`Error en competencia "${nombreLiga}":`, errComp.message); return false; }

  const titulo = `${p.strHomeTeam} vs ${p.strAwayTeam}`;
  const finalizado = p.intHomeScore != null && p.intAwayScore != null;
  const resultado = finalizado ? `${p.intHomeScore}-${p.intAwayScore}` : null;

  const { data: evento, error: errEvento } = await supabase
    .from('eventos')
    .upsert(
      {
        fuente: 'thesportsdb',
        fuente_id: String(p.idEvent),
        competencia_id: competencia.id,
        comienza_en: comienzaEn,
        titulo,
        instancia: p.strRound || nombreLiga,
        sede: p.strVenue ?? null,
        horario_confirmado: horaConfirmada,
        finalizado,
        resultado,
        actualizado_en: new Date().toISOString(),
      },
      { onConflict: 'fuente,fuente_id' }
    )
    .select()
    .single();

  if (errEvento) { console.error(`Error en partido "${titulo}":`, errEvento.message); return false; }

  const { error: errPart } = await supabase
    .from('participaciones')
    .upsert(
      { evento_id: evento.id, deportista_id: deportista.id },
      { onConflict: 'evento_id,deportista_id', ignoreDuplicates: true }
    );
  if (errPart) console.error('Error linkeando participación:', errPart.message);

  return true;
}

async function main() {
  for (const seleccion of SELECCIONES) {
    console.log(`\n--- ${seleccion.deportistaSlug} ---`);

    // ---------- 0. deporte + deportista ----------
    const deporteId = await asegurarDeporte(seleccion.deporteSlug, NOMBRES_DEPORTES[seleccion.deporteSlug]);

    const { data: deportista } = await supabase
      .from('deportistas').select('id, slug').eq('slug', seleccion.deportistaSlug).maybeSingle();

    if (!deportista) {
      console.warn(`No encontré "${seleccion.deportistaSlug}" en deportistas — agregalo y volvé a correr.`);
      continue;
    }

    // ---------- 1. resolver team id ----------
    const teamId = await resolverTeamId(seleccion);
    if (!teamId) continue;

    // ---------- 2. próximos partidos + últimos jugados ----------
    let proximos = [], finalizados = [];
    try {
      const resp = await sportsDbGet(`/eventsnext.php?id=${teamId}`);
      proximos = resp?.events ?? [];
    } catch (e) {
      console.warn(`No pude traer próximos partidos de ${seleccion.deportistaSlug}: ${e.message}`);
    }
    try {
      const resp = await sportsDbGet(`/eventslast.php?id=${teamId}`);
      finalizados = resp?.results ?? [];
    } catch (e) {
      console.warn(`No pude traer partidos finalizados de ${seleccion.deportistaSlug}: ${e.message}`);
    }

    console.log(`${proximos.length} próximos, ${finalizados.length} finalizados encontrados.`);

    let creados = 0;
    for (const p of [...proximos, ...finalizados]) {
      const ok = await guardarPartido(p, seleccion, deporteId, deportista);
      if (ok) creados++;
    }

    console.log(`Listo: ${creados} eventos sincronizados para ${seleccion.deportistaSlug}.`);
  }
}

main().catch(err => {
  console.error('El ingestor de selecciones falló:', err);
  process.exit(1);
});
