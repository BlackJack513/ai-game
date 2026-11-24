import type { Bot, NodeKind, Observation, Order } from '../engine/types.js';

const NEUTRAL = -1;
const INF = 1e9;

function rand01(seed: number, salt: number): number {
  let t = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function marchDist(adj: number[][], ownerOf: number[], start: number, mover: number): number[] {
  const dist = new Array(adj.length).fill(INF);
  const queue: number[] = [start];
  dist[start] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of adj[u]) {
      if (dist[v] < INF) continue;
      dist[v] = dist[u] + 1;
      if (ownerOf[v] === NEUTRAL || ownerOf[v] === mover) queue.push(v);
    }
  }
  return dist;
}

function prodFor(kind: NodeKind, count: number): number {
  if (kind === 'home') return 4;
  if (kind === 'foundry') return 5;
  if (kind === 'watchtower') return 2;
  return 2 + Math.floor(count / 2);
}

interface Col {
  to: number;
  from: number;
  arrive: number;
  troops: number;
}

function plan(view: Observation): Order[] {
  const n = view.nodes.length;
  const me = view.you;
  const turn = view.turn;
  const adj = view.adj;
  const ownerOf = new Array(n);
  const kindOf: NodeKind[] = new Array(n);
  const troopsOf = new Array(n);
  for (let i = 0; i < n; i++) {
    ownerOf[i] = view.nodes[i].owner;
    kindOf[i] = view.nodes[i].kind;
    troopsOf[i] = view.nodes[i].troops ?? -1;
  }

  const foePlayers = view.players.filter((p) => p.id !== me && p.alive);
  if (foePlayers.length === 0) return [];
  let foe = foePlayers[0].id;
  if (foePlayers.length > 1) {
    for (const p of foePlayers) {
      if (view.players[p.id].production > view.players[foe].production) foe = p.id;
    }
  }
  let foeHome = -1;
  for (let i = 0; i < n; i++) if (kindOf[i] === 'home' && ownerOf[i] === foe) foeHome = i;
  const myHome = view.homeNode;

  const mySet: number[] = [];
  const foeSet: number[] = [];
  const neutralSet: number[] = [];
  const allFoeSet: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ownerOf[i] === me) mySet.push(i);
    else if (ownerOf[i] === NEUTRAL) neutralSet.push(i);
    else if (ownerOf[i] === foe) foeSet.push(i);
  }
  for (let i = 0; i < n; i++) if (ownerOf[i] !== me && ownerOf[i] !== NEUTRAL) allFoeSet.push(i);

  const distMe: Array<number[] | undefined> = new Array(n);
  for (const v of mySet) distMe[v] = marchDist(adj, ownerOf, v, me);
  const distFoe: Array<number[] | undefined> = new Array(n);
  for (const u of allFoeSet) distFoe[u] = marchDist(adj, ownerOf, u, ownerOf[u]);

  const myReach = new Array(n).fill(INF);
  const foeReach = new Array(n).fill(INF);
  for (const v of mySet) {
    const d = distMe[v]!;
    for (let w = 0; w < n; w++) if (d[w] < myReach[w]) myReach[w] = d[w];
  }
  for (const u of allFoeSet) {
    const d = distFoe[u]!;
    for (let w = 0; w < n; w++) if (d[w] < foeReach[w]) foeReach[w] = d[w];
  }

  const myCols: Col[] = [];
  const foeCols: Col[] = [];
  for (const c of view.columns) {
    const col: Col = {
      to: c.path[c.path.length - 1],
      from: c.path[0],
      arrive: c.arriveTurn,
      troops: c.troops,
    };
    if (c.owner === me) myCols.push(col);
    else foeCols.push(col);
  }
  const inboundTo = (t: number, maxArrive: number) =>
    myCols.filter((c) => c.to === t && c.arrive <= maxArrive).reduce((s, c) => s + c.troops, 0);
  const inboundTotal = (t: number) => myCols.filter((c) => c.to === t).reduce((s, c) => s + c.troops, 0);

  const myKindCount: Record<NodeKind, number> = {
    home: 0,
    farm: 0,
    mine: 0,
    lab: 0,
    watchtower: 0,
    foundry: 0,
  };
  for (const v of mySet) myKindCount[kindOf[v]]++;
  const myProd = (v: number) => prodFor(kindOf[v], myKindCount[kindOf[v]]);

  const orders: Order[] = [];
  const spent = new Array(n).fill(0);
  const pairs = new Set();
  const push = (from: number, to: number, troops: number): boolean => {
    if (orders.length >= view.maxOrders) return false;
    if (troops < 1 || from === to) return false;
    const key = `${from}>${to}`;
    if (pairs.has(key)) return false;
    if (ownerOf[from] !== me) return false;
    if (spent[from] + troops > troopsOf[from]) return false;
    const d = distMe[from];
    if (!d || d[to] >= INF) return false;
    orders.push({ from, to, troops });
    spent[from] += troops;
    pairs.add(key);
    return true;
  };

  const tryAttack = (
    to: number,
    need: number,
    maxSrc: number,
    allowPartial = false,
    overcommit = false,
  ): boolean => {
    if (need < 1) return false;
    const budget = view.maxOrders - orders.length;
    if (budget < 1) return false;
    const cap = Math.min(maxSrc, budget);
    const srcs = mySet
      .filter((v) => (distMe[v]?.[to] ?? INF) < INF)
      .sort(
        (a, b) =>
          distMe[a]![to] - distMe[b]![to] ||
          troopsOf[b] - spent[b] - keep[b] - (troopsOf[a] - spent[a] - keep[a]),
      );
    let pool = 0;
    let srcCount = 0;
    for (const v of srcs) {
      if (srcCount >= cap) break;
      const a = troopsOf[v] - spent[v] - keep[v];
      if (a < 1) continue;
      pool += a;
      srcCount++;
      if (pool >= need) break;
    }
    if (pool < need) {
      if (!allowPartial || ownerOf[to] !== NEUTRAL || pool < 2) return false;
    }
    let remaining = overcommit ? pool : need;
    let used = 0;
    for (const v of srcs) {
      if (remaining <= 0 || used >= srcCount) break;
      const a = troopsOf[v] - spent[v] - keep[v];
      if (a < 1) continue;
      const give = Math.min(a, remaining);
      if (push(v, to, give)) {
        remaining -= give;
        used++;
      }
    }
    return remaining <= 0;
  };

  const keep = new Array(n).fill(0);
  const distFromHome = marchDist(adj, ownerOf, myHome, me);
  keep[myHome] = 2;
  let nearThreat = 0;
  for (const u of allFoeSet) {
    const d = distFoe[u]!;
    if (d[myHome] <= 2) nearThreat += troopsOf[u] >= 0 ? troopsOf[u] : 10;
  }
  keep[myHome] += Math.min(12, Math.round(nearThreat * 0.5));
  if (foeCols.some((c) => c.to === myHome)) keep[myHome] = Math.max(keep[myHome], 8);
  let jumpThreat = 0;
  for (const u of allFoeSet) {
    if (distFromHome[u] === 1 && troopsOf[u] >= 0) jumpThreat += troopsOf[u];
  }
  if (jumpThreat > 0) keep[myHome] = Math.max(keep[myHome], Math.min(32, jumpThreat + 4));
  for (const v of mySet) {
    if (v !== myHome && foeReach[v] <= 2 && (myProd(v) >= 3 || kindOf[v] === 'watchtower' || kindOf[v] === 'foundry')) {
      keep[v] = Math.max(keep[v], 3);
    }
  }

  const needByNode = new Array(n).fill(0);
  for (const v of mySet) {
    const threats = foeCols
      .filter((c) => c.to === v && c.arrive - turn <= 8)
      .sort((a, b) => a.arrive - b.arrive);
    if (!threats.length) continue;
    let g = troopsOf[v];
    let prevTurn = turn;
    let incUsed = 0;
    let gap = 0;
    let i = 0;
    while (i < threats.length) {
      const t = threats[i].arrive;
      let atk = 0;
      while (i < threats.length && threats[i].arrive === t) {
        atk += threats[i].troops;
        i++;
      }
      const incNow = inboundTo(v, t) - incUsed;
      incUsed += incNow;
      g += myProd(v) * (t - prevTurn) + incNow;
      prevTurn = t;
      if (atk + 3 >= g) {
        gap += atk - g + 4;
        g = 0;
      } else {
        g -= atk;
      }
    }
    if (gap > 0) {
      const worth = v === myHome || (myProd(v) >= 4 && gap <= 12) || (kindOf[v] === 'watchtower' && gap <= 10);
      if (worth) needByNode[v] = gap;
    }
  }
  if (jumpThreat > 0) {
    const homeDeficit = keep[myHome] + needByNode[myHome] - (troopsOf[myHome] - spent[myHome]);
    if (homeDeficit > 0) needByNode[myHome] = Math.max(needByNode[myHome], homeDeficit);
  }

  for (const v of mySet) {
    if (needByNode[v] <= 0) continue;
    let need = needByNode[v];
    const neighbors = adj[v].filter((u) => ownerOf[u] === me && u !== v).sort((a, b) => troopsOf[b] - troopsOf[a]);
    for (const u of neighbors) {
      if (need <= 0 || orders.length >= view.maxOrders) break;
      const give = Math.min(need, Math.max(0, troopsOf[u] - spent[u] - keep[u]));
      if (give >= 1 && push(u, v, give)) need -= give;
    }
    if (need > 0) {
      const earliest = foeCols.filter((c) => c.to === v).reduce((m, c) => Math.min(m, c.arrive), INF);
      if (earliest - turn >= 2) {
        for (const w of mySet) {
          if (need <= 0 || orders.length >= view.maxOrders) break;
          if (w === v) continue;
          const d = distMe[w]![v];
          if (d > 3 || d - 1 > earliest - turn) continue;
          const give = Math.min(need, Math.max(0, troopsOf[w] - spent[w] - keep[w]));
          if (give >= 1 && push(w, v, give)) need -= give;
        }
      }
    }
    if (needByNode[myHome] > 0) {
      keep[myHome] = Math.max(keep[myHome], troopsOf[myHome] - spent[myHome]);
    }
  }

  const foeOut = foeCols.reduce((s, c) => s + c.troops, 0);

  const decap = (): boolean => {
    if (foeHome < 0) return false;
    const eh = view.nodes[foeHome];
    let g0 = eh.visible && troopsOf[foeHome] >= 0 ? troopsOf[foeHome] : Math.min(100, 20 + 4 * Math.min(turn, 6));
    if (foeOut >= 15) g0 = Math.max(10, g0 - Math.round(foeOut * 0.7));
    let R = 4;
    for (const u of adj[foeHome]) {
      if (ownerOf[u] === foe) R += troopsOf[u] >= 0 ? Math.round(troopsOf[u] * 0.6) : 8;
    }
    if (foeOut >= 15) R = Math.round(R * 0.5);
    R = Math.min(R, 60);

    const wave = new Map<number, number>();
    for (const c of myCols) {
      if (c.to === foeHome) wave.set(c.arrive - turn, (wave.get(c.arrive - turn) ?? 0) + c.troops);
    }
    const sources: Array<{ v: number; troops: number; k: number }> = [];
    for (const v of mySet) {
      const a = troopsOf[v] - spent[v] - keep[v];
      if (a < 1) continue;
      const d = distMe[v]![foeHome];
      if (d >= INF) continue;
      sources.push({ v, troops: a, k: d - 1 });
      wave.set(d - 1, (wave.get(d - 1) ?? 0) + a);
    }
    if (!sources.length) return false;

    let g = g0;
    let winAt = -1;
    let winRem = 0;
    const maxK = Math.max(...wave.keys());
    for (let k = 0; k <= maxK; k++) {
      const atk = wave.get(k) ?? 0;
      if (atk > 0) {
        if (atk > g) {
          winAt = k;
          winRem = atk - g;
          break;
        }
        if (atk === g) g = 0;
        else g -= atk;
      }
      g += 4;
      if (k === 1) g += R;
    }
    if (winAt < 0 || winRem < 8) return false;

    const homeThreatAt = foeCols
      .filter((c) => c.to === myHome)
      .reduce((m, c) => Math.min(m, c.arrive), INF);
    if (homeThreatAt <= turn + winAt) {
      const c = foeCols.find((col) => col.to === myHome && col.arrive === homeThreatAt)!;
      const defend =
        troopsOf[myHome] + 4 * (c.arrive - turn) + inboundTo(myHome, c.arrive) + needByNode[myHome];
      if (homeThreatAt < turn + winAt || defend <= c.troops + 1) return false;
    }

    sources.sort((a, b) => b.troops - a.troops);
    for (const s of sources) {
      if (orders.length >= view.maxOrders) break;
      push(s.v, foeHome, s.troops);
    }
    return true;
  };

  const lastPhase = turn >= view.maxTurns - 9;
  const myCount = mySet.length;
  const foeCount = allFoeSet.length;
  const leading = lastPhase && myCount > foeCount;
  const trailing = lastPhase && myCount < foeCount;

  if (trailing) {
    for (const v of mySet) {
      if (v !== myHome) keep[v] = 0;
    }
  }
  if (leading) {
    keep[myHome] = Math.max(keep[myHome], 12);
    for (const v of mySet) {
      if (v !== myHome) keep[v] = Math.max(keep[v], 3);
    }
  }

  let decapLaunched = false;
  if (foeHome >= 0 && myReach[foeHome] < INF && !leading) decapLaunched = decap();

  if (!decapLaunched) {
    const doRaid = (): void => {
      const raidCap = trailing ? 60 : 45;
      const raidCand: Array<{ to: number; need: number; score: number }> = [];
      for (const t of foeSet) {
        if (t === foeHome) continue;
        const d = myReach[t];
        if (d >= INF || turn + d - 1 > view.maxTurns) continue;
        const k = d - 1;
        const prodT = view.nodes[t].production || 2;
        let def = troopsOf[t] >= 0 ? troopsOf[t] : Math.min(100, 6 + Math.round(prodT * turn * 0.7));
        def += prodT * k;
        if (k >= 1) {
          let back = 2;
          for (const u of adj[t]) {
            if (ownerOf[u] !== NEUTRAL && ownerOf[u] !== me) back += troopsOf[u] >= 0 ? Math.round(troopsOf[u] * 0.35) : 3;
          }
          def += Math.min(12, back);
        }
        const need = def + 2 - inboundTotal(t);
        if (need < 1) continue;
        let score = prodT * 3 - need * 0.5 + rand01(view.rngSeed, t) * 0.3;
        const dfh = distFoe[t]?.[foeHome] ?? INF;
        if (dfh <= 1) score += 5;
        if (troopsOf[t] >= 0 && troopsOf[t] <= 8) score += 6;
        const dfm = distFromHome[t];
        if (dfm === 1) score += 10;
        else if (dfm === 2) score += 3;
        raidCand.push({ to: t, need, score });
      }
      raidCand.sort((a, b) => b.score - a.score);
      for (let ci = 0; ci < raidCand.length; ci++) {
        const c = raidCand[ci];
        if (orders.length >= view.maxOrders) break;
        if (c.need > raidCap) continue;
        tryAttack(c.to, c.need, 4, false, ci === 0);
      }
    };

    const doExpand = (): void => {
      const expandCand: Array<{ to: number; need: number; score: number; safeNeutral: boolean }> = [];
      for (const t of neutralSet) {
        const d = myReach[t];
        if (d >= INF || turn + d - 1 > view.maxTurns) continue;
        const g = troopsOf[t];
        if (g < 0) continue;
        const inbound = myCols.filter((c) => c.to === t);
        const myArr = inbound.length ? Math.min(turn + d - 1, ...inbound.map((c) => c.arrive)) : turn + d - 1;
        let foeArr = foeReach[t] >= INF ? INF : turn + foeReach[t] - 1;
        let foeAtk = 0;
        for (const c of foeCols) {
          if (c.to === t) {
            foeArr = Math.min(foeArr, c.arrive);
            foeAtk += c.troops;
          }
        }
        let need: number;
        let contended = false;
        if (myArr < foeArr) {
          need = g + 1;
          if (foeAtk > 0) need = Math.max(need, g + 1 + Math.max(0, foeAtk - 2));
        } else if (myArr === foeArr || (foeReach[t] < INF && foeReach[t] - myReach[t] <= 2)) {
          const kind = kindOf[t];
          need = g + (foeAtk > 0 ? foeAtk : kind === 'foundry' || kind === 'watchtower' ? 6 : 4);
          contended = true;
        } else {
          continue;
        }
        need = Math.max(0, need - inboundTotal(t));
        if (need < 1) continue;
        const count = myKindCount[kindOf[t]];
        const old = count * prodFor(kindOf[t], count);
        const after = (count + 1) * prodFor(kindOf[t], count + 1);
        const delta = after - old;
        const kindBonus =
          kindOf[t] === 'foundry' ? 3 : kindOf[t] === 'watchtower' ? 2.5 : kindOf[t] === 'lab' || kindOf[t] === 'farm' || kindOf[t] === 'mine' ? 0.5 : 0;
        let score = delta + kindBonus;
        score = score * 6 - g * 1.6 - d * 2.4 - (contended ? 3 : 0) + rand01(view.rngSeed, t + 57) * 0.4;
        const dfh = foeHome >= 0 ? (distMe[t]?.[foeHome] ?? INF) : INF;
        if (dfh <= 1) score += 6;
        else if (dfh === 2) score += 4;
        const dfm = distFromHome[t];
        if (dfm === 1) score += 8;
        else if (dfm === 2) score += 3;
        if (trailing) score += 6;
        const safeNeutral = ownerOf[t] === NEUTRAL && foeAtk === 0 && myArr < foeArr && need <= 34;
        expandCand.push({ to: t, need, score, safeNeutral });
      }
      expandCand.sort((a, b) => b.score - a.score);
      for (const c of expandCand) {
        if (orders.length >= view.maxOrders) break;
        if (c.need > (trailing ? 70 : 34)) continue;
        tryAttack(c.to, c.need, 3, c.safeNeutral);
      }
    };

    if (turn <= 10) {
      doExpand();
      doRaid();
    } else {
      doRaid();
      doExpand();
    }

    for (const v of mySet) {
      if (orders.length >= view.maxOrders) break;
      const after = troopsOf[v] - spent[v];
      if (after < (v === myHome ? 92 : 96)) continue;
      const targets = mySet
        .filter((w) => w !== v && 85 - (troopsOf[w] - spent[w]) >= 20 && (distMe[v]![w] ?? INF) < INF)
        .sort(
          (a, b) =>
            (foeHome >= 0 ? distMe[a]![foeHome] - distMe[b]![foeHome] : 0) ||
            -(85 - (troopsOf[a] - spent[a])) + (85 - (troopsOf[b] - spent[b])),
        );
      if (targets.length) push(v, targets[0], Math.min(30, 100 - (troopsOf[targets[0]] - spent[targets[0]])));
    }

    for (const v of mySet) {
      if (orders.length >= view.maxOrders) break;
      const toFh = foeHome >= 0 ? distMe[v]![foeHome] : INF;
      const rear = toFh >= 4 || toFh >= INF;
      const excess = troopsOf[v] - spent[v] - keep[v] - 6;
      if (!rear && excess < 60) continue;
      if (excess < 10) continue;
      let best = -1;
      let bestScore = -INF;
      for (const w of mySet) {
        if (w === v) continue;
        if ((distMe[v]![w] ?? INF) >= INF) continue;
        const space = 85 - (troopsOf[w] - spent[w]);
        if (space < 12) continue;
        const dw = foeHome >= 0 ? distMe[w]![foeHome] : 0;
        const s = -dw * 2 + space * 0.1 + (leading && w === myHome ? 6 : 0) + (w === myHome ? -2 : 0);
        if (s > bestScore) {
          bestScore = s;
          best = w;
        }
      }
      if (best >= 0) push(v, best, Math.min(excess, 85 - (troopsOf[best] - spent[best])));
    }

    if (orders.length <= 3 && !leading) {
      const frontTarget = (from: number): number => {
        let best = -1;
        let bestScore = -INF;
        for (const w of mySet) {
          if (w === from) continue;
          if ((distMe[from]![w] ?? INF) >= INF) continue;
          const space = 90 - (troopsOf[w] - spent[w]);
          if (space < 8) continue;
          const dw = foeHome >= 0 ? distMe[w]![foeHome] : 0;
          const s = -dw * 3 + space * 0.05 + (kindOf[w] === 'foundry' || kindOf[w] === 'watchtower' ? 1 : 0);
          if (s > bestScore) {
            bestScore = s;
            best = w;
          }
        }
        return best;
      };
      const donors = mySet
        .filter((v) => {
          const a = troopsOf[v] - spent[v] - keep[v];
          return a >= 5 && foeHome >= 0 && (distMe[v]![foeHome] ?? INF) > 1;
        })
        .sort((a, b) => (troopsOf[b] - spent[b] - keep[b]) - (troopsOf[a] - spent[a] - keep[a]));
      for (const v of donors) {
        if (orders.length >= view.maxOrders) break;
        const target = frontTarget(v);
        if (target < 0) continue;
        const a = troopsOf[v] - spent[v] - keep[v];
        const space = 90 - (troopsOf[target] - spent[target]);
        if (space < 4) continue;
        push(v, target, Math.min(a, space));
      }
    }
  }

  return orders;
}

export function createLongyuan(): Bot {
  return {
    name: '龙渊',
    style: '镜像推演 · 视野压制 · 波次斩首',
    decide(view: Observation): Order[] {
      try {
        return plan(view);
      } catch {
        return [];
      }
    },
  };
}
