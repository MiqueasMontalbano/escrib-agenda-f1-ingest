// ============================================================
//  Ingestor de Rugby / Hockey / Vóley — Argentinos en clubes de Europa
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
//  Uso local:
//    node ingest-rugby-hockey-voley.mjs
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

// ---------- jugadores en clubes de Europa (slug → deporte, club) ----------
const JUGADORES = [
  // Rugby
  { slug: 'santiago-carreras',       deporteSlug: 'rugby', club: 'Bath' },
  { slug: 'julian-montoya',          deporteSlug: 'rugby', club: 'Section Paloise' },
  { slug: 'marcos-kremer',           deporteSlug: 'rugby', club: 'ASM Clermont Auvergne' },
  { slug: 'facundo-isa',             deporteSlug: 'rugby', club: 'Section Paloise' },
  { slug: 'guido-petti',             deporteSlug: 'rugby', club: 'Harlequins' },
  { slug: 'boris-wenger',            deporteSlug: 'rugby', club: 'Harlequins' },
  { slug: 'pedro-delgado',           deporteSlug: 'rugby', club: 'Harlequins' },
  { slug: 'rodrigo-isgro',           deporteSlug: 'rugby', club: 'Harlequins' },
  { slug: 'juan-martin-gonzalez',    deporteSlug: 'rugby', club: 'Saracens' },
  { slug: 'lucio-cinti',             deporteSlug: 'rugby', club: 'Saracens' },
  { slug: 'joel-sclavi',             deporteSlug: 'rugby', club: 'Leicester Tigers' },
  { slug: 'matias-alemanno',         deporteSlug: 'rugby', club: 'Gloucester' },
  { slug: 'mateo-carreras',          deporteSlug: 'rugby', club: 'Aviron Bayonnais' },
  { slug: 'gonzalo-garcia',          deporteSlug: 'rugby', club: 'Section Paloise' },
  // Hockey
  { slug: 'nicolas-della-torre',     deporteSlug: 'hockey', club: 'KHC Dragons' },
  { slug: 'lucas-martinez',          deporteSlug: 'hockey', club: 'KHC Dragons' },
  { slug: 'tomas-santiago',          deporteSlug: 'hockey', club: 'Herakles' },
  { slug: 'maico-casella',           deporteSlug: 'hockey', club: 'Gantoise' },
  { slug: 'facundo-sarto',           deporteSlug: 'hockey', club: 'Royal Victory' },
  { slug: 'juan-ignacio-catan',      deporteSlug: 'hockey', club: 'Mannheimer HC' },
  { slug: 'nicolas-keenan',          deporteSlug: 'hockey', club: 'Klein Zwitserland' },
  { slug: 'lucas-toscani',           deporteSlug: 'hockey', club: 'Laren' },
  { slug: 'eugenia-trinchinetti',    deporteSlug: 'hockey', club: 'Real Sociedad' },
  { slug: 'sofia-poy-toccalino',     deporteSlug: 'hockey', club: 'Real Sociedad' },
  { slug: 'victoria-sauze',          deporteSlug: 'hockey', club: 'Atletic Terrassa' },
  { slug: 'julieta-jankunas',        deporteSlug: 'hockey', club: 'Egara' },
  // Vóley
  { slug: 'agustin-loser',           deporteSlug: 'voley', club: 'Sir Safety Perugia' },
  { slug: 'sebastian-sole',          deporteSlug: 'voley', club: 'Sir Safety Perugia' },
  { slug: 'pablo-kukartsev',         deporteSlug: 'voley', club: 'Cucine Lube Civitanova' },
  { slug: 'santiago-orduna',         deporteSlug: 'voley', club: 'Cucine Lube Civitanova' },
  { slug: 'matias-sanchez',          deporteSlug: 'voley', club: 'Montpellier' },
  { slug: 'tomas-lopez',             deporteSlug: 'voley', club: 'Montpellier' },
  { slug: 'ezequiel-palacios-voley', deporteSlug: 'voley', club: 'Montpellier' },
];

async function sportsDbGet(path, reintentos = 2) {
  const resp = await fetch(`${SPORTSDB_BASE}${path}`);
  if (resp.status === 429 || resp.status === 403) {
    if (reintentos > 0) {
      console.warn(`TheSportsDB nos frenó (${resp.status}), espero 30s y reintento (${reintentos} intentos quedan)...`);
      await pausa(30000);
      return sportsDbGet(path, reintentos - 1);
    }
  }
  if (!resp.ok) {
    throw new Error(`TheSportsDB respondió ${resp.status}`);
  }
  return resp.json();
}

function pausa(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Escudos reales vía TheSportsDB — por ID de equipo ----------
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

async function resolverClubId(nombreClub, deporteEsperado) {
  const data = await sportsDbGet(`/searchteams.php?t=${encodeURIComponent(nombreClub)}`);
  const candidatos = data?.teams ?? [];

  // Filtramos por el deporte que esperamos — sin esto, un nombre corto/ambiguo
  // como "Pau" o "Real Sociedad" puede matchear el club de FÚTBOL homónimo
  // (mucho más conocido en la base) en vez del de rugby/hockey/vóley real.
  const SPORT_THESPORTSDB = { rugby: 'Rugby Union', hockey: 'Field Hockey', voley: 'Volleyball' };
  const sportEsperado = SPORT_THESPORTSDB[deporteEsperado];
  const encontrado = candidatos.find(t => t.strSport === sportEsperado);

  if (!encontrado) {
    console.warn(`No encontré el club "${nombreClub}" en TheSportsDB con deporte "${sportEsperado}" (evito adivinar mal).`);
    return { id: null, badge: null };
  }
  return { id: encontrado.idTeam, badge: encontrado.strTeamBadge ?? null };
}

async function main() {
  // ---------- 0. deportes ya existen (los creó el ingestor de selecciones) ----------
  const { data: deportesRows } = await supabase.from('deportes').select('id, slug').in('slug', ['rugby', 'hockey', 'voley']);
  const deporteIdPorSlug = Object.fromEntries((deportesRows ?? []).map(d => [d.slug, d.id]));

  // ---------- 1. IDs de nuestros deportistas en Supabase ----------
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
    const deporteDelClub = JUGADORES.find(j => j.club === club)?.deporteSlug;
    const resuelto = await resolverClubId(club, deporteDelClub);
    teamIdPorClub[club] = resuelto.id;
    teamBadgePorClub[club] = resuelto.badge;
    await pausa(1200);
  }

  // ---------- 3. traer el próximo partido de cada club y guardarlo ----------
  let creados = 0;

  for (const club of clubesUnicos) {
    const teamId = teamIdPorClub[club];
    if (!teamId) continue;

    const jugadoresDelClub = JUGADORES.filter(j => j.club === club && deportistaIdPorSlug[j.slug]);
    const deporteSlug = jugadoresDelClub[0]?.deporteSlug;
    const deporteId = deporteIdPorSlug[deporteSlug];
    if (!deporteId) { console.warn(`No encontré el deporte "${deporteSlug}" en Supabase.`); continue; }

    let proximos = [], finalizados = [];
    try {
      const resp = await sportsDbGet(`/eventsnext.php?id=${teamId}`);
      proximos = resp?.events ?? [];
    } catch (e) {
      console.warn(`No pude traer próximos partidos de ${club}: ${e.message}`);
    }
    try {
      const resp = await sportsDbGet(`/eventslast.php?id=${teamId}`);
      finalizados = resp?.results ?? [];
    } catch (e) {
      console.warn(`No pude traer partidos finalizados de ${club}: ${e.message}`);
    }

    for (const p of [...proximos, ...finalizados]) {
      if (!p.dateEvent) continue;

      const horaConfirmada = !!p.strTime && p.strTime !== '00:00:00';
      const comienzaEn = horaConfirmada ? `${p.dateEvent}T${p.strTime}Z` : `${p.dateEvent}T12:00:00Z`;
      const nombreLiga = p.strLeague ?? deporteSlug;
      const anio = p.dateEvent.slice(0, 4);
      const slugComp = `${deporteSlug}-${nombreLiga.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${anio}`;

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

      const esLocalNuestro = String(p.idHomeTeam) === String(teamId);
      const escudoLocal = esLocalNuestro
        ? teamBadgePorClub[club]
        : await resolverEscudoPorId(p.idHomeTeam);
      const escudoVisitante = !esLocalNuestro
        ? teamBadgePorClub[club]
        : await resolverEscudoPorId(p.idAwayTeam);

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
            escudo_local: escudoLocal,
            escudo_visitante: escudoVisitante,
            finalizado,
            resultado,
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

    await pausa(1200);
  }

  console.log(`Listo. ${creados} eventos de rugby/hockey/vóley sincronizados.`);
}

main().catch(err => {
  console.error('El ingestor de rugby/hockey/vóley falló:', err);
  process.exit(1);
});
