// ============================================================
//  Ingestor de Fútbol — Argentinos en las 5 grandes ligas de Europa
//  (football-data.org → Supabase)
//  Corre cada ~2 horas.
// ============================================================
//
//  Variables de entorno necesarias:
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//    FOOTBALL_DATA_API_KEY   (gratis en football-data.org/client/register)
//
//  Cobertura: Premier League, La Liga, Serie A, Bundesliga, Ligue 1,
//  Championship (Inglaterra) y Champions League — son las competencias
//  incluidas en el plan gratuito de football-data.org.
//  OJO: la Europa League y la Conference League NO están en el plan
//  gratis, así que quedan afuera por ahora.
//
//  Si algún club no aparece en los logs con "resuelto", puede ser que:
//   a) esté en una liga que no cubre el plan gratis, o
//   b) el nombre no matcheó bien con el de la API (revisar TEAM_ID_MANUAL).
//
//  Uso local:
//    node ingest-futbol-exterior.mjs
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FD_KEY          = process.env.FOOTBALL_DATA_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !FD_KEY) {
  console.error('Faltan SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o FOOTBALL_DATA_API_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const FD_BASE = 'https://api.football-data.org/v4';
const FD_HEADERS = { 'X-Auth-Token': FD_KEY };

// Competencias domésticas a resolver (Champions League sale sola al traer
// los partidos de cada equipo, no hace falta listarla acá).
const LIGAS_DOMESTICAS = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'ELC']; // ELC = Championship

// ---------- jugadores argentinos en el exterior (slug → club) ----------
const JUGADORES = [
  { slug: 'matias-soule', club: 'Roma' },
  { slug: 'santiago-castro', club: 'Roma' },
  { slug: 'paulo-dybala', club: 'Roma' },
  { slug: 'leonardo-balerdi', club: 'Roma' },
  { slug: 'nahuel-molina', club: 'Roma' },
  { slug: 'benjamin-dominguez', club: 'Bologna' },
  { slug: 'mikel-amondarain', club: 'Bologna' },
  { slug: 'nicolas-paz', club: 'Como' },
  { slug: 'maximo-perrone', club: 'Como' },
  { slug: 'franco-mastantuono', club: 'Fiorentina' },
  { slug: 'mateo-pellegrino', club: 'Fiorentina' },
  { slug: 'lautaro-martinez', club: 'Inter' },
  { slug: 'nicolas-gonzalez', club: 'Juventus' },
  { slug: 'santiago-pierotti', club: 'Lecce' },
  { slug: 'exequiel-zeballos', club: 'Monza' },
  { slug: 'david-romero', club: 'Parma' },
  { slug: 'mariano-troilo', club: 'Parma' },
  { slug: 'christian-ordonez', club: 'Parma' },
  { slug: 'lautaro-valenti', club: 'Parma' },
  { slug: 'franco-carboni', club: 'Parma' },
  { slug: 'thomas-de-martis', club: 'Parma' },
  { slug: 'giovanni-simeone', club: 'Torino' },
  { slug: 'matias-moreno', club: 'Venezia' },

  { slug: 'julian-alvarez', club: 'Atletico Madrid' },
  { slug: 'giuliano-simeone', club: 'Atletico Madrid' },
  { slug: 'cristian-romero', club: 'Atletico Madrid' },
  { slug: 'juan-musso', club: 'Atletico Madrid' },
  { slug: 'valentin-gomez', club: 'Betis' },
  { slug: 'giovani-lo-celso', club: 'Betis' },
  { slug: 'lucas-boye', club: 'Alaves' },
  { slug: 'nahuel-tenaglia', club: 'Alaves' },
  { slug: 'nicolas-valentini', club: 'Alaves' },
  { slug: 'facundo-buonanotte', club: 'Elche' },
  { slug: 'federico-redondo', club: 'Elche' },
  { slug: 'abiel-osorio', club: 'Elche' },
  { slug: 'matias-dituro', club: 'Elche' },
  { slug: 'ezequiel-ponce', club: 'Elche' },
  { slug: 'kevin-lomonaco', club: 'Elche' },
  { slug: 'zaid-romero', club: 'Getafe' },
  { slug: 'thiago-fernandez', club: 'Levante' },
  { slug: 'augusto-batalla', club: 'Rayo Vallecano' },
  { slug: 'guido-rodriguez', club: 'Valencia' },
  { slug: 'juan-foyth', club: 'Villarreal' },

  { slug: 'alejandro-garnacho', club: 'Aston Villa' },
  { slug: 'emiliano-buendia', club: 'Aston Villa' },
  { slug: 'julio-soler', club: 'Bournemouth' },
  { slug: 'emiliano-martinez', club: 'Chelsea' },
  { slug: 'valentin-barco', club: 'Chelsea' },
  { slug: 'aaron-anselmino', club: 'Chelsea' },
  { slug: 'walter-benitez', club: 'Crystal Palace' },
  { slug: 'carlos-alcaraz', club: 'Everton' },
  { slug: 'exequiel-palacios', club: 'Ipswich Town' },
  { slug: 'geronimo-rulli', club: 'Manchester City' },
  { slug: 'enzo-fernandez', club: 'Manchester City' },
  { slug: 'claudio-echeverri', club: 'Manchester City' },
  { slug: 'lisandro-martinez', club: 'Manchester United' },
  { slug: 'nicolas-dominguez', club: 'Nottingham Forest' },
  { slug: 'alexis-mac-allister', club: 'Liverpool' },
  { slug: 'marcos-senesi', club: 'Tottenham' },

  { slug: 'joaquin-panichelli', club: 'Strasbourg' },
  { slug: 'mateo-del-blanco', club: 'Strasbourg' },
  { slug: 'nicolas-tagliafico', club: 'Lyon' },
  { slug: 'julian-vignolo', club: 'Toulouse' },
  { slug: 'santiago-hidalgo', club: 'Toulouse' },

  { slug: 'facundo-medina', club: 'Bayer Leverkusen' },
  { slug: 'ezequiel-fernandez', club: 'Bayer Leverkusen' },
  { slug: 'nicolas-capaldo', club: 'Hamburgo' },
];

// Si la búsqueda automática no encuentra bien un club, se puede forzar
// el ID numérico de football-data.org acá (clave = mismo texto usado arriba en "club").
const TEAM_ID_MANUAL = {
  // 'Monza': 12345,
};

function normalizar(texto) {
  return texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function coincide(nombreClub, nombreEquipoAPI) {
  const a = normalizar(nombreClub);
  const b = normalizar(nombreEquipoAPI);
  const stopwords = new Set(['fc', 'cf', 'ac', 'afc', 'de', 'club', 'calcio', 'ud', 'sv']);
  const palabrasA = a.split(' ').filter(w => !stopwords.has(w));
  return palabrasA.every(p => b.includes(p)) || b.includes(a) || a.includes(b.split(' ')[0]);
}

async function fdGet(path) {
  const resp = await fetch(`${FD_BASE}${path}`, { headers: FD_HEADERS });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`football-data.org respondió ${resp.status} en ${path}: ${body}`);
  }
  return resp.json();
}

function pausa(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // ---------- 0. Asegurar deporte "futbol" ----------
  let deporteId;
  const { data: deporteExistente } = await supabase
    .from('deportes').select('id').eq('slug', 'futbol').maybeSingle();
  if (deporteExistente) {
    deporteId = deporteExistente.id;
  } else {
    const { data: deporteNuevo, error } = await supabase
      .from('deportes').insert({ slug: 'futbol', nombre: 'Fútbol' }).select().single();
    if (error) throw error;
    deporteId = deporteNuevo.id;
  }

  // ---------- 1. IDs de nuestros jugadores en Supabase ----------
  const slugs = JUGADORES.map(j => j.slug);
  const { data: deportistas, error: errDep } = await supabase
    .from('deportistas').select('id, slug').in('slug', slugs);
  if (errDep) throw errDep;
  const deportistaIdPorSlug = Object.fromEntries((deportistas ?? []).map(d => [d.slug, d.id]));

  const faltantes = slugs.filter(s => !deportistaIdPorSlug[s]);
  if (faltantes.length) {
    console.warn(`Ojo: ${faltantes.length} jugadores no están en la tabla deportistas todavía (¿importaste el CSV?): ${faltantes.slice(0,5).join(', ')}${faltantes.length>5 ? '...' : ''}`);
  }

  // ---------- 2. Resolver el equipo de football-data.org para cada club ----------
  const clubesUnicos = Array.from(new Set(JUGADORES.map(j => j.club)));
  const teamIdPorClub = {};

  for (const codigoLiga of LIGAS_DOMESTICAS) {
    let teams;
    try {
      const resp = await fdGet(`/competitions/${codigoLiga}/teams`);
      teams = resp.teams ?? [];
    } catch (e) {
      console.warn(`No pude traer equipos de ${codigoLiga}: ${e.message}`);
      continue;
    }

    for (const club of clubesUnicos) {
      if (teamIdPorClub[club]) continue;
      if (TEAM_ID_MANUAL[club]) { teamIdPorClub[club] = TEAM_ID_MANUAL[club]; continue; }

      const encontrado = teams.find(t => coincide(club, t.name) || coincide(club, t.shortName ?? ''));
      if (encontrado) teamIdPorClub[club] = encontrado.id;
    }

    await pausa(6500); // respetar el límite de 10 requests/minuto del plan free
  }

  const noResueltos = clubesUnicos.filter(c => !teamIdPorClub[c]);
  if (noResueltos.length) {
    console.warn(`No pude resolver estos clubes (puede que estén fuera de las ligas cubiertas por el plan free): ${noResueltos.join(', ')}`);
  }

  // ---------- 3. Traer próximos partidos de cada club resuelto ----------
  let eventosCreados = 0;

  for (const club of clubesUnicos) {
    const teamId = teamIdPorClub[club];
    if (!teamId) continue;

    let partidos;
    try {
      const resp = await fdGet(`/teams/${teamId}/matches?status=SCHEDULED&limit=15`);
      partidos = resp.matches ?? [];
    } catch (e) {
      console.warn(`No pude traer partidos de ${club}: ${e.message}`);
      continue;
    }

    const jugadoresDelClub = JUGADORES.filter(j => j.club === club && deportistaIdPorSlug[j.slug]);

    for (const partido of partidos) {
      const competencia_nombre = partido.competition?.name ?? 'Torneo';
      const competencia_codigo = partido.competition?.code ?? 'otro';
      const anio = new Date(partido.utcDate).getFullYear();
      const slugComp = `futbol-${competencia_codigo.toLowerCase()}-${anio}`;

      const { data: competencia, error: errComp } = await supabase
        .from('competencias')
        .upsert(
          { slug: slugComp, nombre: competencia_nombre, deporte_id: deporteId, temporada: String(anio), prioridad: 5 },
          { onConflict: 'slug' }
        )
        .select()
        .single();

      if (errComp) { console.error(`Error en competencia "${competencia_nombre}":`, errComp.message); continue; }

      const local = partido.homeTeam?.name ?? '?';
      const visitante = partido.awayTeam?.name ?? '?';

      const { data: evento, error: errEvento } = await supabase
        .from('eventos')
        .upsert(
          {
            fuente: 'football-data',
            fuente_id: String(partido.id),
            competencia_id: competencia.id,
            comienza_en: partido.utcDate,
            titulo: `${local} vs ${visitante}`,
            instancia: partido.stage ?? competencia_nombre,
            sede: partido.venue ?? null,
            horario_confirmado: true,
            actualizado_en: new Date().toISOString(),
          },
          { onConflict: 'fuente,fuente_id' }
        )
        .select()
        .single();

      if (errEvento) { console.error(`Error en partido "${local} vs ${visitante}":`, errEvento.message); continue; }

      eventosCreados++;

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

    await pausa(6500); // límite de requests/minuto
  }

  console.log(`Listo. ${eventosCreados} eventos de clubes sincronizados.`);
}

main().catch(err => {
  console.error('El ingestor de fútbol (exterior) falló:', err);
  process.exit(1);
});
