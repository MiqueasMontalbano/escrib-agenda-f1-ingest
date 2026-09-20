// ============================================================
//  Ingestor de Básquet — Argentinos en Euroliga/ACB (clubes)
//  (TheSportsDB → Supabase)
//  Corre cada ~2 horas.
// ============================================================
//
//  Variables de entorno necesarias:
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//
//  No necesita API key propia (usa la key pública "3" de TheSportsDB).
//
//  Ojo: la key gratis de TheSportsDB solo devuelve 1 próximo evento por
//  equipo (no una lista completa) — es una limitación del plan free,
//  no un bug del script.
//
//  Uso local:
//    node ingest-basquet-clubes.mjs
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SPORTSDB_KEY  = process.env.THESPORTSDB_API_KEY || '3';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const SPORTSDB_BASE = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}`;

// ---------- basquetbolistas argentinos en Europa (slug → club) ----------
const JUGADORES = [
  { slug: 'facundo-campazzo',     club: 'Real Madrid Baloncesto' },
  { slug: 'gabriel-deck',         club: 'Real Madrid Baloncesto' },
  { slug: 'luca-vildoza',         club: 'Virtus Bologna' },
  { slug: 'leandro-bolmaro',      club: 'Olimpia Milano' },
  { slug: 'juani-marcos',         club: 'UCAM Murcia' },
  { slug: 'nicolas-laprovittola', club: 'Joventut Badalona' },
  { slug: 'gonzalo-corbalan',     club: 'Valencia Basket' },
  { slug: 'maximo-fjellerup',     club: 'Bàsquet Girona' },
];

async function sportsDbGet(path) {
  const resp = await fetch(`${SPORTSDB_BASE}${path}`);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`TheSportsDB respondió ${resp.status}: ${body}`);
  }
  return resp.json();
}

function pausa(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Escudos reales vía TheSportsDB — por ID de equipo (sin ambigüedad de nombres) ----------
const cacheEscudosEnMemoria = {};

async function resolverEscudoPorId(teamId) {
  if (!teamId) return null;
  const clave = `id:${teamId}`;
  if (clave in cacheEscudosEnMemoria) return cacheEscudosEnMemoria[clave];

  const { data: cacheado } = await supabase
    .from('escudos_clubes').select('escudo_url').eq('nombre_club', clave).maybeSingle();

  if (cacheado && cacheado.escudo_url) {
    cacheEscudosEnMemoria[clave] = cacheado.escudo_url;
    return cacheado.escudo_url;
  }

  let escudoUrl = null;
  try {
    const data = await sportsDbGet(`/lookupteam.php?id=${teamId}`);
    escudoUrl = data?.teams?.[0]?.strTeamBadge ?? null;
    await pausa(1200);
  } catch (e) {
    console.warn(`No pude resolver el escudo del equipo id ${teamId}: ${e.message}`);
  }

  if (escudoUrl) {
    await supabase
      .from('escudos_clubes')
      .upsert({ nombre_club: clave, escudo_url: escudoUrl, actualizado_en: new Date().toISOString() }, { onConflict: 'nombre_club' });
  }

  cacheEscudosEnMemoria[clave] = escudoUrl;
  return escudoUrl;
}

async function resolverClubId(nombreClub) {
  const data = await sportsDbGet(`/searchteams.php?t=${encodeURIComponent(nombreClub)}`);
  const encontrado = data?.teams?.find(t => t.strSport === 'Basketball') ?? data?.teams?.[0];
  if (!encontrado) {
    console.warn(`No encontré el club "${nombreClub}" en TheSportsDB.`);
    return { id: null, badge: null };
  }
  return { id: encontrado.idTeam, badge: encontrado.strTeamBadge ?? null };
}

async function main() {
  // ---------- 0. deporte "basquet" ya existe (lo creó el ingestor de selecciones) ----------
  const { data: deporteBasquet, error: errDeporte } = await supabase
    .from('deportes').select('id').eq('slug', 'basquet').maybeSingle();

  if (errDeporte || !deporteBasquet) {
    console.error('No encontré el deporte "basquet" en Supabase. Corré primero el ingestor de selecciones.');
    process.exit(1);
  }
  const deporteId = deporteBasquet.id;

  // ---------- 1. IDs de nuestros jugadores en Supabase ----------
  const slugs = JUGADORES.map(j => j.slug);
  const { data: deportistas, error: errDep } = await supabase
    .from('deportistas').select('id, slug').in('slug', slugs);
  if (errDep) throw errDep;
  const deportistaIdPorSlug = Object.fromEntries((deportistas ?? []).map(d => [d.slug, d.id]));

  const faltantes = slugs.filter(s => !deportistaIdPorSlug[s]);
  if (faltantes.length) {
    console.warn(`Faltan cargar en deportistas: ${faltantes.join(', ')}`);
  }

  // ---------- 2. resolver el club de cada jugador cargado ----------
  const clubesUnicos = Array.from(new Set(JUGADORES.filter(j => deportistaIdPorSlug[j.slug]).map(j => j.club)));
  const teamIdPorClub = {};
  const teamBadgePorClub = {};

  for (const club of clubesUnicos) {
    const resuelto = await resolverClubId(club);
    teamIdPorClub[club] = resuelto.id;
    teamBadgePorClub[club] = resuelto.badge;
    console.log(`DEBUG resolverClubId("${club}") → id=${resuelto.id} badge=${resuelto.badge ?? 'NULL'}`);
    await pausa(1500);
  }

  // ---------- 3. traer el próximo partido de cada club y guardarlo ----------
  let creados = 0;

  for (const club of clubesUnicos) {
    const teamId = teamIdPorClub[club];
    if (!teamId) continue;

    let partidos;
    try {
      const resp = await sportsDbGet(`/eventsnext.php?id=${teamId}`);
      partidos = resp?.events ?? [];
    } catch (e) {
      console.warn(`No pude traer partidos de ${club}: ${e.message}`);
      continue;
    }

    const jugadoresDelClub = JUGADORES.filter(j => j.club === club && deportistaIdPorSlug[j.slug]);

    for (const p of partidos) {
      if (!p.dateEvent) continue;

      const horaConfirmada = !!p.strTime && p.strTime !== '00:00:00';
      const comienzaEn = horaConfirmada ? `${p.dateEvent}T${p.strTime}Z` : `${p.dateEvent}T12:00:00Z`;
      const nombreLiga = p.strLeague ?? 'Básquet Europa';
      const anio = p.dateEvent.slice(0, 4);
      const slugComp = `basquet-${nombreLiga.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${anio}`;

      const { data: competencia, error: errComp } = await supabase
        .from('competencias')
        .upsert(
          { slug: slugComp, nombre: nombreLiga, deporte_id: deporteId, temporada: anio, prioridad: 5 },
          { onConflict: 'slug' }
        )
        .select()
        .single();

      if (errComp) { console.error(`Error en competencia "${nombreLiga}":`, errComp.message); continue; }

      const titulo = `${p.strHomeTeam} vs ${p.strAwayTeam}`;
      console.log(`DEBUG partido: idHomeTeam=${p.idHomeTeam} idAwayTeam=${p.idAwayTeam} nuestro teamId=${teamId} strHomeTeam=${p.strHomeTeam} strAwayTeam=${p.strAwayTeam}`);

      // Nuestro club ya tiene el escudo resuelto (teamBadgePorClub). Para el rival,
      // usamos su ID de equipo (idHomeTeam/idAwayTeam vienen en el partido) — sin
      // adivinar por nombre, que es donde fallaba antes.
      const esLocalNuestro = String(p.idHomeTeam) === String(teamId);
      const escudoLocal = esLocalNuestro
        ? teamBadgePorClub[club]
        : await resolverEscudoPorId(p.idHomeTeam);
      const escudoVisitante = !esLocalNuestro
        ? teamBadgePorClub[club]
        : await resolverEscudoPorId(p.idAwayTeam);
      console.log(`DEBUG escudos: local=${escudoLocal ?? 'NULL'} visitante=${escudoVisitante ?? 'NULL'}`);

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
            escudo_local: escudoLocal,
            escudo_visitante: escudoVisitante,
            actualizado_en: new Date().toISOString(),
          },
          { onConflict: 'fuente,fuente_id' }
        )
        .select()
        .single();

      if (errEvento) { console.error(`Error en partido "${titulo}":`, errEvento.message); continue; }

      creados++;

      for (const j of jugadoresDelClub) {
        const { error: errPart } = await supabase
          .from('participaciones')
          .upsert(
            { evento_id: evento.id, deportista_id: deportistaIdPorSlug[j.slug] },
            { onConflict: 'evento_id,deportista_id', ignoreDuplicates: true }
          );
        if (errPart) console.error('Error linkeando participación:', errPart.message);
      }
    }

    await pausa(1500);
  }

  console.log(`Listo. ${creados} eventos de básquet sincronizados.`);
}

main().catch(err => {
  console.error('El ingestor de básquet falló:', err);
  process.exit(1);
});
