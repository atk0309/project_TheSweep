// Deterministic, idempotent scoring. Pure functions over small data sets.
// Rules (confirmed): Group win +3 / draw +1; +1 per goal an owned team scores
// (regulation/ET, NOT shootout pens); Knockout win +3 (incl. R32, by winner flag
// so ET/pens are handled); reach bonuses STACK cumulatively R16 +4, QF +8,
// SF +12, Final +16; Champion +24 on top.

export const SCORING_RULES = [
  ['Group win', '+3'],
  ['Group draw', '+1'],
  ['Knockout win', '+3'],
  ['Reach R16 / QF', '+4 / +8'],
  ['Reach SF / Final', '+12 / +16'],
  ['Champion', '+24'],
  ['Goal scored', '+1'],
];

// round_ord: 0=Group, 1=R32, 2=R16, 3=QF, 4=SF, 5=Final
const REACH_BONUS = { 2: 4, 3: 8, 4: 12, 5: 16 };
const KO_WIN = 3;
const CHAMPION = 24;
const FINAL_ORD = 5;
const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN']);

const isFinalStatus = (s) => FINAL_STATUSES.has(String(s || '').toUpperCase());

// Per-team breakdown + total. Returns Map<teamId, {total, group, goals, ko, reach, champion, alive}>.
export function computeTeamScores({ teams, fixtures = [], standings = [] }) {
  const standingByTeam = new Map(standings.map((s) => [s.team_id, s]));
  const scores = new Map();

  for (const t of teams) {
    const st = standingByTeam.get(t.id);
    scores.set(t.id, {
      total: 0,
      group: st?.points || 0, // standings points already = 3*w + d (== our group rule)
      goals: 0,
      ko: 0,
      reach: 0,
      champion: 0,
      maxRound: 0,
      eliminated: false,
      alive: st ? st.alive : true,
    });
  }

  for (const f of fixtures) {
    const ord = f.round_ord || 0;
    for (const side of ['home', 'away']) {
      const teamId = f[`${side}_team_id`];
      if (!teamId || !scores.has(teamId)) continue;
      const s = scores.get(teamId);
      // goals (regulation/ET only — pens are separate columns we ignore)
      const g = side === 'home' ? f.home_goals : f.away_goals;
      if (typeof g === 'number' && isFinalStatus(f.status)) s.goals += g;
      // furthest round reached (appearing in a real fixture of that round)
      if (ord > s.maxRound) s.maxRound = ord;
      // knockout results
      if (ord >= 1 && isFinalStatus(f.status) && f.winner_team_id) {
        if (f.winner_team_id === teamId) s.ko += KO_WIN;
        else s.eliminated = true; // lost a completed KO match
      }
      // champion
      if (ord === FINAL_ORD && isFinalStatus(f.status) && f.winner_team_id === teamId) {
        s.champion = CHAMPION;
      }
    }
  }

  for (const s of scores.values()) {
    // cumulative reach bonuses for every round >= R16 up to the furthest reached
    for (let r = 2; r <= s.maxRound; r++) s.reach += REACH_BONUS[r] || 0;
    if (s.eliminated) s.alive = false;
    s.total = s.group + s.goals + s.ko + s.reach + s.champion;
  }
  return scores;
}

// Leaderboard rows for onboarded, non-removed players.
export function computeLeaderboard({ players, allocations, teams, fixtures = [], standings = [] }) {
  const teamScores = computeTeamScores({ teams, fixtures, standings });
  const ownedBy = new Map(); // playerId -> [teamId]
  for (const a of allocations) {
    if (!ownedBy.has(a.player_id)) ownedBy.set(a.player_id, []);
    ownedBy.get(a.player_id).push(a.team_id);
  }
  const teamById = new Map(teams.map((t) => [t.id, t]));

  const rows = players
    .filter((p) => p.display_name && !p.removed)
    .map((p) => {
      const owned = ownedBy.get(p.id) || [];
      let score = 0;
      let goals = 0;
      let alive = 0;
      const ownedTeams = owned.map((tid) => {
        const s = teamScores.get(tid) || { total: 0, goals: 0, alive: false };
        score += s.total;
        goals += s.goals;
        if (s.alive) alive += 1;
        const t = teamById.get(tid);
        return { id: tid, code: t?.code, name: t?.name, flag: t?.flag, alive: s.alive };
      });
      return {
        id: p.id,
        name: p.display_name,
        color: p.monogram_color,
        initials: initialsOf(p.display_name),
        score,
        goals,
        alive,
        teams: owned.length,
        move: 0, // no historical snapshot in a throwaway build
        ownedTeams,
      };
    });

  rows.sort((a, b) => b.score - a.score || b.alive - a.alive || b.goals - a.goals || a.id - b.id);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

export function initialsOf(name) {
  const n = String(name || '').trim();
  return n ? n.slice(0, 2).toUpperCase() : null;
}
