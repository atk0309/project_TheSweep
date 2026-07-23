// Day-one live smoke test: run the real poller against API-Football (Pro) into
// the local DB, then verify the real 2026 team/fixture/standings load + scoring.
import { armDestructiveTestDatabase } from './destructive-test-guard.mjs';

armDestructiveTestDatabase('live_ingest');
process.env.NODE_ENV = 'development';
process.env.ALLOW_INSECURE_DEVELOPMENT = '1';

const [
  { pollFull },
  { computeLeaderboard },
  { pool, query, seedTeams },
] = await Promise.all([
  import('../server/poller.js'),
  import('../server/scoring.js'),
  import('../server/db.js'),
]);

let fail = 0;
const eq = (label, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}: ${got}${ok ? '' : ' (expected ' + want + ')'}`); };

await query('TRUNCATE allocations, players, fixtures, standings, match_events RESTART IDENTITY CASCADE');
await pollFull();

const teams = (await query('SELECT count(*)::int n FROM teams')).rows[0].n;
eq('teams', teams, 48);
const groups = (await query('SELECT group_letter, count(*)::int n FROM teams GROUP BY group_letter ORDER BY group_letter')).rows;
console.log('  groups:', groups.map((r) => `${r.group_letter}:${r.n}`).join(' '));
eq('12 groups of 4', groups.length === 12 && groups.every((r) => r.n === 4), true);

const fixtures = (await query('SELECT count(*)::int n FROM fixtures')).rows[0].n;
const standings = (await query('SELECT count(*)::int n FROM standings')).rows[0].n;
const groupFix = (await query("SELECT count(*)::int n FROM fixtures WHERE round_ord=0 AND group_letter IS NOT NULL")).rows[0].n;
const liveNow = (await query("SELECT count(*)::int n FROM fixtures WHERE status IN ('1H','HT','2H','ET','P','LIVE')")).rows[0].n;
console.log(`  fixtures: ${fixtures} | standings: ${standings} | group-fixtures w/ letter: ${groupFix} | live now: ${liveNow}`);
eq('fixtures > 40', fixtures > 40, true);
eq('standings == 48', standings, 48);

const sample = (await query('SELECT code, name, group_letter, flag FROM teams ORDER BY idx LIMIT 4')).rows;
console.log('  sample:', sample.map((r) => `${r.code}/${r.name}/${r.group_letter}`).join('  '));
eq('flags are gradients', sample.every((r) => /linear-gradient/.test(r.flag)), true);

// quick scoring sanity: allocate all teams to one player, score must be > 0 (group pts + goals exist)
const pid = (await query("INSERT INTO players (email,display_name,monogram_color) VALUES ('t@x','Tester','#00e676') RETURNING id")).rows[0].id;
await query('INSERT INTO allocations (team_id, player_id) SELECT id, $1 FROM teams', [pid]);
const all = {
  players: (await query('SELECT id, display_name, monogram_color, removed FROM players')).rows,
  allocations: (await query('SELECT team_id, player_id FROM allocations')).rows,
  teams: (await query('SELECT id, code, name, flag FROM teams')).rows,
  fixtures: (await query('SELECT id, round_ord, status, home_team_id, away_team_id, home_goals, away_goals, winner_team_id FROM fixtures')).rows,
  standings: (await query('SELECT team_id, points, gf, ga, rank, alive FROM standings')).rows,
};
const lb = computeLeaderboard(all);
console.log('  all-teams score:', lb[0]?.score, '| alive:', lb[0]?.alive, '| goals:', lb[0]?.goals);
eq('scoring produces a positive total', lb[0]?.score > 0, true);

// restore the design demo seed locally
await query('TRUNCATE allocations, players, fixtures, standings, match_events RESTART IDENTITY CASCADE');
await query('TRUNCATE teams RESTART IDENTITY CASCADE');
await seedTeams();
console.log(fail ? '\nLIVE INGEST FAIL ❌' : '\nLIVE INGEST PASS ✅');
process.exitCode = fail ? 1 : 0;
await pool.end();
