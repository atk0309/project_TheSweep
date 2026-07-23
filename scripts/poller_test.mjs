// Integration test: synthetic API-Football responses → ingest → scoring.
// Verifies team replace, standings/fixtures upsert, and exact leaderboard math.
import { armDestructiveTestDatabase } from './destructive-test-guard.mjs';

armDestructiveTestDatabase('poller_test');
process.env.NODE_ENV = 'development';
process.env.ALLOW_INSECURE_DEVELOPMENT = '1';

const [
  { ingestTeams, ingestStandings, ingestFixtures, reconcileAlive },
  { computeLeaderboard },
  { pool, query, seedTeams },
] = await Promise.all([
  import('../server/poller.js'),
  import('../server/scoring.js'),
  import('../server/db.js'),
]);

const std = [{ league: { standings: [
  [
    { rank: 1, team: { id: 101, name: 'Brazil' }, points: 9, group: 'Group A', all: { played: 3, win: 3, draw: 0, lose: 0, goals: { for: 7, against: 2 } } },
    { rank: 2, team: { id: 102, name: 'France' }, points: 6, group: 'Group A', all: { played: 3, win: 2, draw: 0, lose: 1, goals: { for: 5, against: 3 } } },
    { rank: 3, team: { id: 103, name: 'England' }, points: 3, group: 'Group A', all: { played: 3, win: 1, draw: 0, lose: 2, goals: { for: 3, against: 4 } } },
    { rank: 4, team: { id: 104, name: 'Spain' }, points: 0, group: 'Group A', all: { played: 3, win: 0, draw: 0, lose: 3, goals: { for: 1, against: 7 } } },
  ],
  [
    { rank: 1, team: { id: 201, name: 'Argentina' }, points: 9, group: 'Group B', all: { played: 3, win: 3, draw: 0, lose: 0, goals: { for: 6, against: 1 } } },
    { rank: 2, team: { id: 202, name: 'Germany' }, points: 4, group: 'Group B', all: { played: 3, win: 1, draw: 1, lose: 1, goals: { for: 4, against: 4 } } },
    { rank: 3, team: { id: 203, name: 'Portugal' }, points: 3, group: 'Group B', all: { played: 3, win: 1, draw: 0, lose: 2, goals: { for: 2, against: 5 } } },
    { rank: 4, team: { id: 204, name: 'Italy' }, points: 1, group: 'Group B', all: { played: 3, win: 0, draw: 1, lose: 2, goals: { for: 1, against: 6 } } },
  ],
] } }];

const fixtures = [
  { fixture: { id: 9001, date: '2026-07-19T19:00:00+00:00', status: { short: 'FT', elapsed: 90 } },
    league: { round: 'Final' },
    teams: { home: { id: 101, name: 'Brazil', winner: true }, away: { id: 201, name: 'Argentina', winner: false } },
    goals: { home: 2, away: 1 }, score: { penalty: { home: null, away: null } } },
];

function eq(label, got, want) { const ok = got === want; console.log(`  ${ok ? '✓' : '✗'} ${label}: ${got}${ok ? '' : ' (expected ' + want + ')'}`); if (!ok) process.exitCode = 1; }

await query('TRUNCATE players, allocations, fixtures, standings, match_events RESTART IDENTITY CASCADE');

const tRes = await ingestTeams(std);
eq('ingestTeams mode', tRes.mode, 'replace');
eq('teams inserted', tRes.count, 8);

const sN = await ingestStandings(std);
eq('standings rows', sN, 8);
const fN = await ingestFixtures(fixtures);
eq('fixtures rows', fN, 1);
await reconcileAlive();

// flag generated for Brazil?
const bra = (await query("SELECT id, code, flag, api_team_id FROM teams WHERE name='Brazil'")).rows[0];
eq('Brazil flag is a gradient', /linear-gradient/.test(bra.flag), true);

// allocate: Player One -> Brazil+France ; Player Two -> Argentina+Germany
const p1 = (await query("INSERT INTO players (email,display_name,monogram_color) VALUES ('one@example.test','Player One','#00e676') RETURNING id")).rows[0].id;
const p2 = (await query("INSERT INTO players (email,display_name,monogram_color) VALUES ('two@example.test','Player Two','#ff4d6d') RETURNING id")).rows[0].id;
const tid = async (name) => (await query('SELECT id FROM teams WHERE name=$1', [name])).rows[0].id;
await query('INSERT INTO allocations (team_id,player_id) VALUES ($1,$2),($3,$2)', [await tid('Brazil'), p1, await tid('France')]);
await query('INSERT INTO allocations (team_id,player_id) VALUES ($1,$2),($3,$2)', [await tid('Argentina'), p2, await tid('Germany')]);

const teams = (await query('SELECT id, code, name, flag FROM teams')).rows;
const allocations = (await query('SELECT team_id, player_id FROM allocations')).rows;
const standings = (await query('SELECT team_id, group_letter, played, w, d, l, gf, ga, points, rank, alive FROM standings')).rows;
const fx = (await query('SELECT id, round_ord, status, home_team_id, away_team_id, home_goals, away_goals, winner_team_id FROM fixtures')).rows;
const players = (await query('SELECT id, display_name, monogram_color, removed FROM players')).rows;

const lb = computeLeaderboard({ players, allocations, teams, fixtures: fx, standings });
const byName = Object.fromEntries(lb.map((r) => [r.name, r]));
console.log('  leaderboard:', lb.map((r) => `${r.rank}.${r.name}=${r.score}`).join('  '));

// Player One: Brazil(group9 + goals2 + koWin3 + reach40 + champ24 = 78) + France(group6) = 84
eq('Player One score', byName['Player One'].score, 84);
// Player Two: Argentina(group9 + goals1 + reach40 = 50) + Germany(group4) = 54
eq('Player Two score', byName['Player Two'].score, 54);
eq('Player One rank 1', byName['Player One'].rank, 1);
// Argentina eliminated (lost final) → not alive; Brazil alive
const argAlive = (await query("SELECT alive FROM standings WHERE team_id=$1", [await tid('Argentina')])).rows[0].alive;
eq('Argentina marked eliminated', argAlive, false);

// restore the 48-team demo seed
await query('TRUNCATE players, allocations, fixtures, standings, match_events RESTART IDENTITY CASCADE');
await query('TRUNCATE teams RESTART IDENTITY CASCADE');
await seedTeams();
console.log(process.exitCode ? '\nPOLLER TEST FAIL ❌' : '\nPOLLER TEST PASS ✅');
await pool.end();
