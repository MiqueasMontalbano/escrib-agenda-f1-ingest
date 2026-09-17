// ============================================================
//  Ingestor de Tenis — Live Tennis API → Supabase
//  Corre cada ~2 horas (más seguido en días de Grand Slam/Masters).
// ============================================================
//
//  Variables de entorno necesarias:
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY   (la "service_role", no la "anon")
//    LIVETENNIS_API_KEY          (gratis en livetennisapi.com/subscribe/free)
//
//  Uso local:
//    node ingest-tenis.mjs
//
//  En producción: GitHub Action programada (ver .github/workflows/ingest-tenis.yml)
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIVETENNIS_KEY = process.env.LIVETENNIS_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !LIVETENNIS_KEY) {
  console.error('Faltan SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o LIVETENNIS_API_KEY en el entorno.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const API_BASE = 'https://api.livetennisapi.com/api/public/v1';
const HEADERS = { Authorization: `Bearer ${LIVETENNIS_KEY}` };

// ---------- Tenistas argentinos a seguir ----------
// slug en tu tabla `deportistas` → nombre para buscar en Live Tennis API
const TENISTAS_AR = {
  'francisco-cerundolo':    'Francisco Cerundolo',
  'tomas-etcheverry':       'Tomas Etcheverry',
  'mariano-navone':         'Mariano Navone',
  'sebastian-baez':         'Sebastian Baez',
  'juan-manuel-cerundolo':  'Juan Manuel Cerundolo',
  'roman-burruchaga':       'Roman Burruchaga',
  'thiago-tirante':         'Thiago Tirante',
  'camilo-ugo-carabelli':   'Camilo Ugo Carabelli',
  'facundo-diaz-acosta':    'Facundo Diaz Acosta',
  'marco-trungelliti':      'Marco Trungelliti',
  'francisco-comesana':     'Francisco Comesana',
  'solana-sierra':          'Solana Sierra',
  'nadia-podoroska':        'Nadia Podoroska',
};

function slugify(texto) {
  return texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function apiGet(path) {
  const resp = await fetch(`${API_BASE}${path}`, { headers: HEADERS });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Live Tennis API respondió ${resp.status} en ${path}: ${body}`);
  }
  return resp.json();
}

async function main() {
  // ---------- 0. Asegurar que exista el deporte "tenis" ----------
  let deporteId;
  const { data: deporteExistente } = await supabase
    .from('deportes')
    .select('id')
    .eq('slug', 'tenis')
    .maybeSingle();

  if (deporteExistente) {
    deporteId = deporteExistente.id;
  } else {
    const { data: deporteNuevo, error: errDeporte } = await supabase
      .from('deportes')
      .insert({ slug: 'tenis', nombre: 'Tenis' })
      .select()
      .single();
    if (errDeporte) throw errDeporte;
    deporteId = deporteNuevo.id;
    console.log(`Creé el deporte "tenis" con id ${deporteId}.`);
  }

  // ---------- 1. IDs de nuestros tenistas en Supabase ----------
  const { data: deportistas, error: errDep } = await supabase
    .from('deportistas')
    .select('id, slug')
    .in('slug', Object.keys(TENISTAS_AR));

  if (errDep) throw errDep;

  const deportistaIdPorSlug = Object.fromEntries((deportistas ?? []).map(d => [d.slug, d.id]));

  for (const slug of Object.keys(TENISTAS_AR)) {
    if (!deportistaIdPorSlug[slug]) {
      console.warn(`No encontré a "${slug}" en la tabla deportistas — ¿está cargado?`);
    }
  }

  // ---------- 2. Resolver el playerId de la API para cada tenista ----------
  const playerIdPorSlug = {};

  for (const [slug, nombreBusqueda] of Object.entries(TENISTAS_AR)) {
    if (!deportistaIdPorSlug[slug]) continue; // no está cargado, saltar

    const resultado = await apiGet(`/players?search=${encodeURIComponent(nombreBusqueda)}&limit=5`);
    const candidatos = resultado?.data ?? [];

    // Preferimos un candidato argentino; si no hay, el primero que devuelva la búsqueda.
    const elegido = candidatos.find(c => (c.country ?? '').toLowerCase() === 'arg') ?? candidatos[0];

    if (!elegido) {
      console.warn(`No encontré a "${nombreBusqueda}" en Live Tennis API.`);
      continue;
    }

    playerIdPorSlug[slug] = elegido.id;
  }

  const playerIds = Object.values(playerIdPorSlug);
  if (!playerIds.length) {
    console.log('No pude resolver ningún playerId. Nada para sincronizar.');
    return;
  }

  // playerId de la API → slug (para saber a quién linkear en cada partido)
  const slugPorPlayerId = Object.fromEntries(
    Object.entries(playerIdPorSlug).map(([slug, id]) => [id, slug])
  );

  // ---------- 3. Próximos partidos de nuestros tenistas ----------
  const queryPlayers = playerIds.map(id => `player=${id}`).join('&');
  const matchesResp = await apiGet(`/matches?status=upcoming&${queryPlayers}&limit=200`);
  const partidos = matchesResp?.data ?? [];

  console.log(`Encontré ${partidos.length} próximos partidos con tenistas argentinos.`);

  if (!partidos.length) return;

  let eventosCreados = 0;
  let eventosSinHorario = 0;

  for (const partido of partidos) {
    if (!partido.scheduled_time) {
      // El tenis suele confirmar el "orden de juego" del día recién unas horas antes.
      // Por ahora no cargamos partidos sin horario; el próximo corrido del ingestor
      // los va a traer apenas se confirme.
      eventosSinHorario++;
      continue;
    }

    // ---- 3a. Competencia (torneo) ----
    const anio = new Date(partido.scheduled_time).getFullYear();
    const slugTorneo = partido.tournament_id
      ? `tenis-${partido.tournament_id}`
      : `tenis-${slugify(partido.tournament ?? 'torneo')}-${anio}`;

    const { data: competencia, error: errComp } = await supabase
      .from('competencias')
      .upsert(
        {
          slug: slugTorneo,
          nombre: partido.tournament ?? 'Torneo ATP/WTA',
          deporte_id: deporteId,
          temporada: String(anio),
          prioridad: 5,
        },
        { onConflict: 'slug' }
      )
      .select()
      .single();

    if (errComp) {
      console.error(`Error guardando torneo "${partido.tournament}":`, errComp.message);
      continue;
    }

    // ---- 3b. Identificar cuál de los dos jugadores es el nuestro ----
    const p1 = partido.players?.p1;
    const p2 = partido.players?.p2;
    const nuestroEsP1 = p1 && slugPorPlayerId[p1.id];
    const nuestroEsP2 = p2 && slugPorPlayerId[p2.id];

    const nuestroNombre   = nuestroEsP1 ? p1.name : (nuestroEsP2 ? p2.name : null);
    const rivalNombre     = nuestroEsP1 ? (p2?.name ?? 'rival por definir') : (p1?.name ?? 'rival por definir');
    const slugTenista     = nuestroEsP1 || nuestroEsP2;

    if (!slugTenista) continue; // no debería pasar, pero por las dudas

    // ---- 3c. Evento (el partido) ----
    const { data: evento, error: errEvento } = await supabase
      .from('eventos')
      .upsert(
        {
          fuente: 'live-tennis-api',
          fuente_id: String(partido.id),
          competencia_id: competencia.id,
          comienza_en: partido.scheduled_time,
          titulo: `${nuestroNombre} vs ${rivalNombre}`,
          instancia: partido.round ?? 'Partido',
          sede: partido.tournament ?? null,
          horario_confirmado: true,
          actualizado_en: new Date().toISOString(),
        },
        { onConflict: 'fuente,fuente_id' }
      )
      .select()
      .single();

    if (errEvento) {
      console.error(`Error guardando partido "${nuestroNombre} vs ${rivalNombre}":`, errEvento.message);
      continue;
    }

    eventosCreados++;

    // ---- 3d. Participación ----
    const { error: errPart } = await supabase
      .from('participaciones')
      .upsert(
        { evento_id: evento.id, deportista_id: deportistaIdPorSlug[slugTenista] },
        { onConflict: 'evento_id,deportista_id', ignoreDuplicates: true }
      );

    if (errPart) console.error('Error linkeando participación:', errPart.message);
  }

  console.log(`Listo. ${eventosCreados} partidos sincronizados.`);
  if (eventosSinHorario > 0) {
    console.log(`${eventosSinHorario} partidos todavía sin horario confirmado (se van a traer en la próxima corrida).`);
  }
}

main().catch(err => {
  console.error('El ingestor de tenis falló:', err);
  process.exit(1);
});
