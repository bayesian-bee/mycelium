import React, { useState, useEffect, useRef, useMemo } from 'react';

// ============================================================
// MYCELIUM — a Slipways-inspired root-network strategy game
// ============================================================
// Resources:
//   sugar   (from photosynthesizing trees / sun patches)
//   water   (from damp soil)
//   mineral (from rocky soil)
//   nitrogen (from nitrogen-fixing patches / decay)
//   spore   (cultural / "people" analog — spreads identity)
//
// Each patch has a finite production capacity: 1 or 2 units of its
// resource per cycle. No two species form a closed dyad — every
// self-sustaining loop requires at least three patches.
//
// Each hypha (edge) carries 1 unit. Threads cannot cross.

// ---------- Types & data ----------
const RESOURCES = {
  sugar:    { glyph: '☀', color: '#f4c95d', name: 'sugar' },
  water:    { glyph: '◉', color: '#7fb8d6', name: 'water' },
  mineral:  { glyph: '◆', color: '#b8a890', name: 'mineral' },
  nitrogen: { glyph: '✿', color: '#a8d49a', name: 'nitrogen' },
  spore:    { glyph: '✺', color: '#d4a8d4', name: 'spore' },
};

const SPECIES = {
  cordyceps:   { biomes: ['sunny'],         name: 'Cordyceps Grove', produces: 'sugar',    needs: ['water', 'mineral'] },
  sunlichen:   { biomes: ['sunny'],         name: 'Sun Lichen',      produces: 'sugar',    needs: ['mineral'] },
  marshveil:   { biomes: ['damp'],          name: 'Marsh Veil',      produces: 'water',    needs: ['sugar'] },
  bogcap:      { biomes: ['damp'],          name: 'Bog Cap',         produces: 'water',    needs: ['nitrogen'] },
  stonebreak:  { biomes: ['rocky'],         name: 'Stonebreaker',    produces: 'mineral',  needs: ['water'] },
  crystalcap:  { biomes: ['rocky'],         name: 'Crystal Cap',     produces: 'mineral',  needs: ['sugar', 'nitrogen'] },
  decaycourt:  { biomes: ['loamy'],         name: 'Decay Court',     produces: 'nitrogen', needs: ['sugar'] },
  sporehall:   { biomes: ['loamy'],         name: 'Spore Hall',      produces: 'spore',    needs: ['sugar', 'water'] },
  hyphallab:   { biomes: ['sunny','damp','rocky','loamy'], name: 'Hyphal Lab', produces: 'science', needs: ['any'] },
};

const BIOME_TINT = {
  sunny: '#d4b86a',
  damp:  '#6b9bb0',
  rocky: '#9c8d78',
  loamy: '#8a7456',
};

// ---------- RNG ----------
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Geometry ----------
function segmentsIntersect(a, b, c, d) {
  // Return true if segment ab intersects segment cd (excluding shared endpoints)
  if (a.id === c.id || a.id === d.id || b.id === c.id || b.id === d.id) return false;
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------- Map generation ----------
function generateMap(seed) {
  const rng = mulberry32(seed);
  const W = 1000, H = 700;
  const N_NODES = 18;
  const MIN_DIST = 110;
  const biomes = ['sunny', 'damp', 'rocky', 'loamy'];

  const nodes = [];
  let attempts = 0;
  while (nodes.length < N_NODES && attempts < 5000) {
    attempts++;
    const x = 80 + rng() * (W - 160);
    const y = 80 + rng() * (H - 160);
    if (nodes.every(n => Math.hypot(n.x - x, n.y - y) > MIN_DIST)) {
      nodes.push({
        id: nodes.length,
        x, y,
        biome: biomes[Math.floor(rng() * biomes.length)],
        species: null,        // key from SPECIES once colonized
        produces: null,       // resource key
        needs: [],            // [resourceKey, ...]
        capacity: rng() < 0.5 ? 1 : 2, // max units of its resource produced per cycle
        explored: false,
        // wobble for hand-drawn feel
        jitter: rng() * Math.PI * 2,
      });
    }
  }

  // Reveal a starting cluster (3 nearest to center)
  const center = { x: W / 2, y: H / 2 };
  const sorted = [...nodes].sort((a, b) => distance(a, center) - distance(b, center));
  sorted.slice(0, 4).forEach(n => { n.explored = true; });

  return { width: W, height: H, nodes };
}

// ---------- Game state helpers ----------
function defaultState(seed) {
  const map = generateMap(seed);
  return {
    seed,
    map,
    edges: [],            // [{from, to}]
    year: 0,
    maxYears: 25,
    nutrients: 60,        // currency (analog of money)
    science: 0,
    history: [],
    selectedNode: null,
    pendingEdgeFrom: null,
    log: ['The forest floor stirs. Begin weaving your network.'],
    gameOver: false,
  };
}

// Compute per-node import/export delivery based on edges + species.
// Returns: {nodeId: {imports: Set<resource>, exports: Set<resource>, neighbors: Set<id>, satisfied: bool, tier: 0..3}}
function computeNetwork(state) {
  const result = {};
  const nodes = state.map.nodes;
  // Per-edge flow: { fwd, rev } — resource keys (or null) for the
  // from->to and to->from directions. Indices match state.edges.
  const edgeFlows = state.edges.map(() => ({ fwd: null, rev: null }));
  for (const n of nodes) {
    result[n.id] = {
      imports: [],            // list of resources actually delivered to this node
      exports: [],            // list of resources this node actually delivers somewhere
      incomingEdges: 0,
      outgoingEdges: 0,
      neighbors: new Set(),
    };
  }

  // For each edge, determine what (if anything) flows in each direction.
  // Each end can independently send its produced resource to the other end if
  // needed, but a producer's exports are capped by its node capacity.
  for (let i = 0; i < state.edges.length; i++) {
    const e = state.edges[i];
    const A = nodes[e.from], B = nodes[e.to];
    result[A.id].neighbors.add(B.id);
    result[B.id].neighbors.add(A.id);

    if (A.species && B.species) {
      const aProd = A.produces;
      const bAccepts = aProd && (B.needs.includes(aProd) || (B.species === 'hyphallab' && aProd !== 'science'));
      if (bAccepts
          && !result[B.id].imports.includes(aProd)
          && result[A.id].exports.length < (A.capacity ?? 1)) {
        result[B.id].imports.push(aProd);
        result[A.id].exports.push(aProd);
        edgeFlows[i].fwd = aProd;
      }
      const bProd = B.produces;
      const aAccepts = bProd && (A.needs.includes(bProd) || (A.species === 'hyphallab' && bProd !== 'science'));
      if (aAccepts
          && !result[A.id].imports.includes(bProd)
          && result[B.id].exports.length < (B.capacity ?? 1)) {
        result[A.id].imports.push(bProd);
        result[B.id].exports.push(bProd);
        edgeFlows[i].rev = bProd;
      }
    }
  }

  // Tier thresholds tuned for the capacity-1/2 economy:
  //   Sprouting   — needs satisfied
  //   Thriving    — needs satisfied + at least one export delivered
  //   Flourishing — satisfied + 2 exports + 2 imports + 2 thriving neighbors
  //                 (only reachable by 2-need species on capacity-2 patches)
  for (const n of nodes) {
    if (!n.species) { result[n.id].tier = 0; continue; }
    const r = result[n.id];
    const needsMet = n.needs.every(need => {
      if (need === 'any') return r.imports.length > 0;
      return r.imports.includes(need);
    });
    r.satisfied = needsMet;
    let tier = 0;
    if (needsMet) tier = 1;
    if (needsMet && r.exports.length >= 1) tier = 2;
    r.tier = tier;
  }
  for (const n of nodes) {
    if (!n.species) continue;
    const r = result[n.id];
    if (r.tier < 2) continue;
    if (r.satisfied && r.exports.length >= 2 && r.imports.length >= 2) {
      let thrivingNeighbors = 0;
      for (const nb of r.neighbors) if (result[nb].tier >= 2) thrivingNeighbors++;
      if (thrivingNeighbors >= 2) r.tier = 3;
    }
  }

  result.edgeFlows = edgeFlows;
  return result;
}

function computeIncome(state, net) {
  // Each delivered export = 3 nutrients/year. Penalty for unmet needs = -2.
  // Flourishing/Thriving bonus.
  let income = 0;
  for (const n of state.map.nodes) {
    if (!n.species) continue;
    const r = net[n.id];
    income += r.exports.length * 3;
    const unmet = n.needs.filter(need => need === 'any' ? r.imports.length === 0 : !r.imports.includes(need));
    income -= unmet.length * 2;
    if (r.tier === 2) income += 2;
    if (r.tier === 3) income += 4;
  }
  return income;
}

function computeScore(state, net) {
  let pts = 0;
  let healthy = 0, total = 0;
  for (const n of state.map.nodes) {
    if (!n.species) continue;
    total++;
    const r = net[n.id];
    pts += [0, 5, 12, 25][r.tier];
    if (r.tier >= 1) healthy++;
  }
  pts += state.science * 2;
  const happiness = total === 0 ? 1 : 0.5 + 0.5 * (healthy / total);
  return { raw: pts, happiness, final: Math.round(pts * happiness) };
}

// ---------- Components ----------

function ResourceGlyph({ res, size = 14 }) {
  if (!res) return null;
  if (res === 'science') {
    return <span style={{ color: '#e8c46b', fontSize: size, filter: 'drop-shadow(0 0 4px rgba(232,196,107,0.6))' }}>✦</span>;
  }
  if (res === 'any') {
    return <span style={{ color: '#aaa', fontSize: size, fontStyle: 'italic' }}>?</span>;
  }
  const r = RESOURCES[res];
  if (!r) return null;
  return (
    <span style={{ color: r.color, fontSize: size, filter: `drop-shadow(0 0 3px ${r.color}88)` }}>
      {r.glyph}
    </span>
  );
}

function NodeGraphic({ node, netInfo, isSelected, isHovered, isPendingFrom, hoveredFromValid }) {
  const tier = netInfo?.tier ?? 0;
  const biomeColor = BIOME_TINT[node.biome];
  const explored = node.explored;
  const colonized = !!node.species;

  // Pulse intensity by tier
  const glow = colonized
    ? [0.0, 0.35, 0.55, 0.85][tier]
    : 0.15;

  const radius = colonized ? 26 : 22;

  // Status color
  let ringColor = '#3a3530';
  if (colonized) {
    if (tier === 3) ringColor = '#e8c46b';
    else if (tier === 2) ringColor = '#9ec48a';
    else if (tier === 1) ringColor = '#7a9c6a';
    else if (netInfo && !netInfo.satisfied && (netInfo.imports.length < node.needs.length)) ringColor = '#c46a5a';
    else ringColor = '#5a5048';
  }

  // Interaction overlay
  const overlayStroke = isPendingFrom
    ? '#e8c46b'
    : (isHovered && hoveredFromValid)
      ? '#a8d49a'
      : isSelected
        ? '#e8c46b'
        : null;

  if (!explored) {
    // Unexplored: show as dim mystery node
    return (
      <g style={{ opacity: 0.35 }}>
        <circle cx={node.x} cy={node.y} r={16}
          fill="#1a1612"
          stroke="#3a3530"
          strokeDasharray="3 3"
          strokeWidth={1.5}
        />
        <text x={node.x} y={node.y + 4} textAnchor="middle"
          fill="#5a5048" fontSize={14} fontFamily="serif" fontStyle="italic">?</text>
      </g>
    );
  }

  return (
    <g>
      {/* outer glow */}
      {glow > 0 && (
        <circle cx={node.x} cy={node.y} r={radius + 14}
          fill={biomeColor} opacity={glow * 0.25}
          style={{ filter: 'blur(8px)' }} />
      )}
      {/* biome backdrop */}
      <circle cx={node.x} cy={node.y} r={radius + 4}
        fill={biomeColor} opacity={0.18} />
      {/* main body */}
      <circle cx={node.x} cy={node.y} r={radius}
        fill="#1f1a16"
        stroke={ringColor}
        strokeWidth={tier >= 2 ? 2.5 : 1.8}
      />
      {/* tier rings (for thriving / flourishing) */}
      {tier >= 2 && (
        <circle cx={node.x} cy={node.y} r={radius + 6}
          fill="none" stroke={ringColor} strokeWidth={1} opacity={0.6} />
      )}
      {tier === 3 && (
        <circle cx={node.x} cy={node.y} r={radius + 10}
          fill="none" stroke={ringColor} strokeWidth={0.8} opacity={0.4}
          strokeDasharray="2 4" />
      )}
      {/* produces glyph (center) */}
      {colonized && (
        <text x={node.x} y={node.y + 6} textAnchor="middle"
          fontSize={22}
          fill={node.produces === 'science' ? '#e8c46b' : RESOURCES[node.produces]?.color || '#fff'}
          style={{ filter: `drop-shadow(0 0 4px ${node.produces === 'science' ? '#e8c46b' : RESOURCES[node.produces]?.color || '#fff'}88)` }}
        >
          {node.produces === 'science' ? '✦' : RESOURCES[node.produces]?.glyph}
        </text>
      )}
      {/* needs glyphs (above) */}
      {colonized && node.needs.map((need, i) => {
        const offset = (i - (node.needs.length - 1) / 2) * 12;
        const delivered = need === 'any'
          ? (netInfo?.imports.length > 0)
          : netInfo?.imports.includes(need);
        const color = need === 'any' ? '#aaa' : RESOURCES[need]?.color;
        return (
          <text key={i}
            x={node.x + offset} y={node.y - radius - 6}
            textAnchor="middle" fontSize={11}
            fill={delivered ? color : '#4a4540'}
            opacity={delivered ? 1 : 0.7}
            style={delivered ? { filter: `drop-shadow(0 0 2px ${color}aa)` } : {}}
          >
            {need === 'any' ? '?' : RESOURCES[need]?.glyph}
          </text>
        );
      })}
      {/* uncolonized: biome glyph */}
      {!colonized && (
        <text x={node.x} y={node.y + 5} textAnchor="middle"
          fontSize={16} fill={biomeColor} opacity={0.8}>
          {node.biome === 'sunny' ? '☀' : node.biome === 'damp' ? '◉' : node.biome === 'rocky' ? '◆' : '✦'}
        </text>
      )}
      {/* capacity dots (richness of the patch) */}
      {Array.from({ length: node.capacity || 1 }).map((_, i) => {
        const cap = node.capacity || 1;
        const offset = (i - (cap - 1) / 2) * 5;
        const dotColor = colonized
          ? (node.produces === 'science' ? '#e8c46b' : RESOURCES[node.produces]?.color)
          : biomeColor;
        return (
          <circle key={`cap-${i}`}
            cx={node.x + offset} cy={node.y + radius - 7}
            r={1.6} fill={dotColor} opacity={0.85} />
        );
      })}
      {/* interaction ring */}
      {overlayStroke && (
        <circle cx={node.x} cy={node.y} r={radius + 4}
          fill="none" stroke={overlayStroke} strokeWidth={2}
          strokeDasharray="4 3"
          style={{ animation: 'spin 12s linear infinite', transformOrigin: `${node.x}px ${node.y}px` }}
        />
      )}
    </g>
  );
}

function EdgeGraphic({ from, to, flow }) {
  // Stylized hypha — wavy path with two thin offset strokes
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len; // normal
  const mid1x = from.x + dx * 0.33 + nx * 4 * Math.sin(from.jitter);
  const mid1y = from.y + dy * 0.33 + ny * 4 * Math.sin(from.jitter);
  const mid2x = from.x + dx * 0.66 + nx * -4 * Math.sin(to.jitter);
  const mid2y = from.y + dy * 0.66 + ny * -4 * Math.sin(to.jitter);
  const path = `M ${from.x} ${from.y} C ${mid1x} ${mid1y}, ${mid2x} ${mid2y}, ${to.x} ${to.y}`;

  // Per-edge flow is precomputed in computeNetwork (respecting capacity caps).
  const resources = [];
  if (flow?.fwd) resources.push({ res: flow.fwd, dir: 'fwd' });
  if (flow?.rev) resources.push({ res: flow.rev, dir: 'rev' });

  return (
    <g>
      <path d={path} fill="none" stroke="#2a241e" strokeWidth={5} strokeLinecap="round" opacity={0.8} />
      <path d={path} fill="none" stroke="#5a4f42" strokeWidth={2.5} strokeLinecap="round" />
      {/* glow flow indicators — use keyPoints to control direction along the same path */}
      {resources.map((r, i) => {
        const color = RESOURCES[r.res]?.color || '#fff';
        return (
          <circle key={i} r={3.5} fill={color}
            style={{ filter: `drop-shadow(0 0 6px ${color})` }}>
            <animateMotion
              dur={`${3 + i}s`}
              repeatCount="indefinite"
              path={path}
              keyPoints={r.dir === 'fwd' ? '0;1' : '1;0'}
              keyTimes="0;1"
              calcMode="linear"
            />
          </circle>
        );
      })}
    </g>
  );
}

// Edge preview while dragging — renders on top of nodes for clear visibility.
function PreviewEdge({ from, to, valid }) {
  const color = valid ? '#a8d49a' : '#c46a5a';
  return (
    <g style={{ pointerEvents: 'none', filter: `drop-shadow(0 0 6px ${color}aa)` }}>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
        stroke={color}
        strokeWidth={2.5}
        strokeDasharray="6 5"
        strokeLinecap="round"
        opacity={0.95} />
      <circle cx={to.x} cy={to.y} r={3.5}
        fill={color}
        opacity={0.85} />
    </g>
  );
}

// ---------- In-map floating menu ----------
function PatchMenu({ state, setState, svgRef, containerRef, pan }) {
  const [pos, setPos] = React.useState(null);
  const node = state.selectedNode !== null ? state.map.nodes[state.selectedNode] : null;
  const isVisible = node && !node.species;

  React.useLayoutEffect(() => {
    if (!isVisible) { setPos(null); return; }
    const compute = () => {
      if (!svgRef.current || !containerRef.current) return;
      const svg = svgRef.current;
      const container = containerRef.current;
      const cRect = container.getBoundingClientRect();
      const sRect = svg.getBoundingClientRect();
      const scaleX = sRect.width / state.map.width;
      const scaleY = sRect.height / state.map.height;
      // Subtract pan offset to convert world->screen
      const nodeScreenX = sRect.left - cRect.left + (node.x - pan.x) * scaleX;
      const nodeScreenY = sRect.top - cRect.top + (node.y - pan.y) * scaleY;
      const nodeRadiusPx = 26 * scaleX;
      setPos({
        x: nodeScreenX,
        y: nodeScreenY,
        r: nodeRadiusPx,
        cw: cRect.width,
        ch: cRect.height,
      });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [isVisible, state.map.width, state.map.height, node?.x, node?.y, pan.x, pan.y, svgRef, containerRef]);

  if (!isVisible) return null;

  const options = Object.entries(SPECIES).filter(([_, s]) => s.biomes.includes(node.biome));

  const colonize = (key) => {
    const s = SPECIES[key];
    const cost = s.produces === 'science' ? 25 : 15;
    if (state.nutrients < cost) {
      setState(st => ({ ...st, log: ['Not enough nutrients to grow.', ...st.log].slice(0, 6) }));
      return;
    }
    setState(st => {
      const nodes = st.map.nodes.map((n, i) =>
        i === node.id ? { ...n, species: key, produces: s.produces, needs: [...s.needs] } : n
      );
      const REVEAL_R = 240;
      const newNodes = nodes.map(n =>
        !n.explored && distance(n, node) < REVEAL_R ? { ...n, explored: true } : n
      );
      return {
        ...st,
        map: { ...st.map, nodes: newNodes },
        nutrients: st.nutrients - cost,
        selectedNode: null,
        log: [`Grew ${s.name} on patch ${node.id}.`, ...st.log].slice(0, 6),
      };
    });
  };

  if (!pos) return null;

  // Compact menu sizing
  const W = 175;
  const ROW_H = 20;
  const HEAD_H = 18;
  const PAD = 4;
  const H = HEAD_H + options.length * ROW_H + PAD;
  const GAP = 10;

  let x, y;
  // Right
  if (pos.x + pos.r + GAP + W <= pos.cw - 8) {
    x = pos.x + pos.r + GAP;
    y = pos.y - H / 2;
  // Left
  } else if (pos.x - pos.r - GAP - W >= 8) {
    x = pos.x - pos.r - GAP - W;
    y = pos.y - H / 2;
  // Below
  } else if (pos.y + pos.r + GAP + H <= pos.ch - 8) {
    x = pos.x - W / 2;
    y = pos.y + pos.r + GAP;
  // Above (fallback)
  } else {
    x = pos.x - W / 2;
    y = pos.y - pos.r - GAP - H;
  }
  // Clamp horizontally and vertically
  x = Math.max(8, Math.min(x, pos.cw - W - 8));
  y = Math.max(8, Math.min(y, pos.ch - H - 8));

  return (
    <>
      <div className="patch-menu" style={{ left: x, top: y, width: W }}>
        <div className="patch-menu-head">
          <span>{node.biome} · ×{node.capacity}/cycle · 15n</span>
          <button onClick={() => setState(st => ({ ...st, selectedNode: null }))}>×</button>
        </div>
        {options.map(([key, s]) => {
          const cost = s.produces === 'science' ? 25 : 15;
          const afford = state.nutrients >= cost;
          return (
            <button
              key={key}
              className="patch-menu-row"
              onClick={() => colonize(key)}
              disabled={!afford}
            >
              <span className="pm-name">{s.name}</span>
              <span className="pm-flow">
                {s.needs.map((n, i) => (
                  <span key={i} style={{ color: n === 'any' ? '#aaa' : RESOURCES[n]?.color, marginRight: 2 }}>
                    {n === 'any' ? '?' : RESOURCES[n]?.glyph}
                  </span>
                ))}
                <span className="pm-arr">→</span>
                <span style={{ color: s.produces === 'science' ? '#e8c46b' : RESOURCES[s.produces]?.color }}>
                  {s.produces === 'science' ? '✦' : RESOURCES[s.produces]?.glyph}
                </span>
                {cost === 25 && <span className="pm-cost">25n</span>}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ---------- Side panel: node details / actions ----------
function NodePanel({ state, setState, net, onClose }) {
  const node = state.map.nodes[state.selectedNode];
  if (!node) return null;
  const r = net[node.id];

  const colonizeOptions = Object.entries(SPECIES).filter(
    ([_, s]) => s.biomes.includes(node.biome)
  );

  const colonize = (key) => {
    const s = SPECIES[key];
    const cost = s.produces === 'science' ? 25 : 15;
    if (state.nutrients < cost) {
      setState(st => ({ ...st, log: ['Not enough nutrients to grow.', ...st.log].slice(0, 6) }));
      return;
    }
    setState(st => {
      const nodes = st.map.nodes.map((n, i) =>
        i === node.id
          ? { ...n, species: key, produces: s.produces, needs: [...s.needs] }
          : n
      );
      // Reveal neighbors within range
      const REVEAL_R = 240;
      const newNodes = nodes.map(n =>
        !n.explored && distance(n, node) < REVEAL_R ? { ...n, explored: true } : n
      );
      return {
        ...st,
        map: { ...st.map, nodes: newNodes },
        nutrients: st.nutrients - cost,
        selectedNode: null,
        log: [`Grew ${s.name} on node ${node.id}.`, ...st.log].slice(0, 6),
      };
    });
  };

  const startEdge = () => {
    setState(st => ({ ...st, pendingEdgeFrom: node.id, selectedNode: null }));
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-eyebrow">{node.biome.toUpperCase()} PATCH</div>
          <div className="panel-title">
            {node.species ? SPECIES[node.species].name : 'Untouched ground'}
          </div>
        </div>
        <button className="x-btn" onClick={onClose}>×</button>
      </div>

      {node.species ? (
        <>
          <div className="kv">
            <span>produces</span>
            <span>
              <ResourceGlyph res={node.produces} size={16} /> {node.produces}
              <span style={{ color: '#7a6f5e', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, marginLeft: 8 }}>
                ×{node.capacity}/cycle
              </span>
            </span>
          </div>
          <div className="kv">
            <span>needs</span>
            <span>
              {node.needs.map((need, i) => (
                <span key={i} style={{ marginRight: 6 }}>
                  <ResourceGlyph res={need} size={14} /> {need}
                  {(need === 'any' ? r.imports.length > 0 : r.imports.includes(need))
                    ? <span style={{ color: '#9ec48a' }}> ✓</span>
                    : <span style={{ color: '#c46a5a' }}> ✗</span>}
                </span>
              ))}
            </span>
          </div>
          <div className="kv">
            <span>tier</span>
            <span className="tier-badge" data-tier={r.tier}>
              {['Dormant', 'Sprouting', 'Thriving', 'Flourishing'][r.tier]}
            </span>
          </div>
          <div className="kv">
            <span>flow</span>
            <span>{r.imports.length} in / {r.exports.length} out</span>
          </div>
          <button className="btn primary" onClick={startEdge}>
            Weave hypha from here
          </button>
        </>
      ) : (
        <>
          <div className="hint">
            Yields <span style={{ color: '#d8cfbf' }}>×{node.capacity}</span> per cycle. Choose a species to cultivate (cost: 15 nutrients).
          </div>
          <div className="species-grid">
            {colonizeOptions.map(([key, s]) => (
              <button key={key} className="species-card"
                onClick={() => colonize(key)}
                disabled={state.nutrients < (s.produces === 'science' ? 25 : 15)}>
                <div className="species-name">{s.name}</div>
                <div className="species-flow">
                  <span>
                    {s.needs.map((need, i) => (
                      <ResourceGlyph key={i} res={need} size={13} />
                    ))}
                  </span>
                  <span className="arrow">→</span>
                  <span><ResourceGlyph res={s.produces} size={15} /></span>
                </div>
                <div className="species-cost">
                  {s.produces === 'science' ? '25' : '15'} nutrients
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Help modal ----------
function HelpModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-eyebrow">field guide</div>
            <h2>How to grow a forest</h2>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <p>
          You are the unseen network beneath the soil. Cultivate species on patches of ground,
          weave hyphal threads between them, and let resources flow. You have <strong>25 years</strong> to
          build the most flourishing network you can.
        </p>

        <h3>The three actions</h3>

        <div className="diagram">
          <svg viewBox="0 0 580 220" style={{ width: '100%', height: 'auto' }}>
            <defs>
              <pattern id="help-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="10" cy="10" r="0.4" fill="#2a241e" />
              </pattern>
              <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                <path d="M0,0 L6,4 L0,8 Z" fill="#5a4f42" />
              </marker>
            </defs>
            <rect width="580" height="220" fill="url(#help-grid)" />

            {/* Step labels */}
            <text x="95" y="20" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="9" letterSpacing="2" fill="#7a6f5e">1 · INSPECT</text>
            <text x="290" y="20" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="9" letterSpacing="2" fill="#7a6f5e">2 · CULTIVATE</text>
            <text x="485" y="20" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="9" letterSpacing="2" fill="#7a6f5e">3 · WEAVE</text>

            {/* Step 1: empty patch */}
            <circle cx="95" cy="120" r="26" fill="#d4b86a" opacity="0.18" />
            <circle cx="95" cy="120" r="22" fill="#1f1a16" stroke="#5a5048" strokeWidth="1.8" />
            <text x="95" y="125" textAnchor="middle" fontSize="16" fill="#d4b86a" opacity="0.8">☀</text>
            <text x="95" y="180" textAnchor="middle" fontFamily="Cormorant Garamond, serif" fontStyle="italic" fontSize="13" fill="#8a7f6e">sunny patch</text>
            <text x="95" y="198" textAnchor="middle" fontFamily="Cormorant Garamond, serif" fontStyle="italic" fontSize="11" fill="#6a5f4e">click to inspect</text>

            {/* arrow */}
            <path d="M 140 120 L 195 120" stroke="#5a4f42" strokeWidth="1.5" markerEnd="url(#arr)" fill="none" />

            {/* Step 2: colonized — Sun Lichen needs mineral, makes sugar */}
            <text x="284" y="80" textAnchor="middle" fontSize="11" fill="#b8a890" opacity="0.9" style={{ filter: 'drop-shadow(0 0 2px #b8a89088)' }}>◆</text>
            <circle cx="290" cy="120" r="26" fill="#d4b86a" opacity="0.18" />
            <circle cx="290" cy="120" r="22" fill="#1f1a16" stroke="#7a9c6a" strokeWidth="2" />
            <text x="290" y="126" textAnchor="middle" fontSize="22" fill="#f4c95d" style={{ filter: 'drop-shadow(0 0 4px #f4c95d88)' }}>☀</text>
            <text x="290" y="180" textAnchor="middle" fontFamily="Cormorant Garamond, serif" fontStyle="italic" fontSize="13" fill="#e8c46b">Sun Lichen</text>
            <text x="290" y="198" textAnchor="middle" fontFamily="Cormorant Garamond, serif" fontStyle="italic" fontSize="11" fill="#6a5f4e">needs ◆ · makes ☀</text>

            {/* arrow */}
            <path d="M 335 120 L 390 120" stroke="#5a4f42" strokeWidth="1.5" markerEnd="url(#arr)" fill="none" />

            {/* Step 3: connected triangle (Sun Lichen, Marsh Veil, Stonebreaker) */}
            {/* Sun Lichen (top) */}
            <circle cx="485" cy="95" r="18" fill="#1f1a16" stroke="#9ec48a" strokeWidth="2" />
            <text x="485" y="101" textAnchor="middle" fontSize="18" fill="#f4c95d" style={{ filter: 'drop-shadow(0 0 4px #f4c95d88)' }}>☀</text>
            {/* Marsh Veil (bottom-left) */}
            <circle cx="450" cy="148" r="18" fill="#1f1a16" stroke="#9ec48a" strokeWidth="2" />
            <text x="450" y="154" textAnchor="middle" fontSize="18" fill="#7fb8d6" style={{ filter: 'drop-shadow(0 0 4px #7fb8d688)' }}>◉</text>
            {/* Stonebreaker (bottom-right) */}
            <circle cx="520" cy="148" r="18" fill="#1f1a16" stroke="#9ec48a" strokeWidth="2" />
            <text x="520" y="154" textAnchor="middle" fontSize="18" fill="#b8a890" style={{ filter: 'drop-shadow(0 0 4px #b8a89088)' }}>◆</text>

            {/* Sun Lichen → Marsh Veil (sugar) */}
            <path d="M 477 110 L 458 134" stroke="#5a4f42" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <circle r="3" fill="#f4c95d" style={{ filter: 'drop-shadow(0 0 4px #f4c95d)' }}>
              <animateMotion dur="3s" repeatCount="indefinite" path="M 477 110 L 458 134" />
            </circle>
            {/* Marsh Veil → Stonebreaker (water) */}
            <path d="M 468 148 L 502 148" stroke="#5a4f42" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <circle r="3" fill="#7fb8d6" style={{ filter: 'drop-shadow(0 0 4px #7fb8d6)' }}>
              <animateMotion dur="3s" repeatCount="indefinite" path="M 468 148 L 502 148" />
            </circle>
            {/* Stonebreaker → Sun Lichen (mineral) */}
            <path d="M 512 134 L 493 110" stroke="#5a4f42" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <circle r="3" fill="#b8a890" style={{ filter: 'drop-shadow(0 0 4px #b8a890)' }}>
              <animateMotion dur="3s" repeatCount="indefinite" path="M 512 134 L 493 110" />
            </circle>

            <text x="485" y="190" textAnchor="middle" fontFamily="Cormorant Garamond, serif" fontStyle="italic" fontSize="13" fill="#9ec48a">Sprouting cycle</text>
            <text x="485" y="206" textAnchor="middle" fontFamily="Cormorant Garamond, serif" fontStyle="italic" fontSize="11" fill="#6a5f4e">three species fuel each other</text>
          </svg>
          <div className="diagram-caption">inspect · cultivate · weave</div>
        </div>

        <ul>
          <li><strong>Click any explored patch</strong> to inspect it. The biome glyph (☀ sunny, ◉ damp, ◆ rocky, ✦ loamy) tells you which species can grow there.</li>
          <li><strong>Cultivate a species</strong> by picking from the menu (15 nutrients; 25 for a Hyphal Lab). Cultivation reveals nearby patches.</li>
          <li><strong>Weave a hypha</strong> from any colonized patch (5 nutrients). Threads can't cross each other and have a maximum length.</li>
          <li><strong>Pass the year</strong> to collect income, advance time, and produce science from labs.</li>
        </ul>

        <h3>How resources flow</h3>
        <p>
          Each hypha carries <strong>one unit</strong> of a resource in each direction. A flow happens only when one
          patch <em>produces</em> exactly what the other <em>needs</em>. If neither side can satisfy the other, the
          thread is dead weight.
        </p>
        <p>
          Each patch has a <strong>finite yield</strong> — shown as small dots inside the node — of either
          1 or 2 units per cycle. A patch with capacity 2 can fuel two hungry neighbors at once; capacity 1 must
          choose. No two species can fully fuel each other on their own, so every self-sustaining loop needs at
          least three patches.
        </p>
        <div className="res-row">
          <span><span style={{ color: '#f4c95d' }}>☀</span> sugar</span>
          <span><span style={{ color: '#7fb8d6' }}>◉</span> water</span>
          <span><span style={{ color: '#b8a890' }}>◆</span> mineral</span>
          <span><span style={{ color: '#a8d49a' }}>✿</span> nitrogen</span>
          <span><span style={{ color: '#d4a8d4' }}>✺</span> spore</span>
        </div>

        <h3>Growth tiers</h3>
        <ul>
          <li><span style={{ color: '#6a5f4e', fontStyle: 'italic' }}>Dormant</span> — colonized but unmet needs. Earns penalties.</li>
          <li><span style={{ color: '#7a9c6a', fontStyle: 'italic' }}>Sprouting</span> — all needs satisfied.</li>
          <li><span style={{ color: '#9ec48a', fontStyle: 'italic' }}>Thriving</span> — needs satisfied + at least one export delivered.</li>
          <li><span style={{ color: '#e8c46b', fontStyle: 'italic' }}>Flourishing</span> — needs satisfied + 2 imports + 2 exports + 2 thriving neighbors. Requires a capacity-2 patch growing a two-need species.</li>
        </ul>

        <h3>Strategy</h3>
        <ul>
          <li>The cheapest <strong>self-sustaining loop</strong> is a triangle: Sun Lichen (☀) ← Stonebreaker (◆) ← Marsh Veil (◉) ← Sun Lichen. Each feeds the next.</li>
          <li>Watch the capacity dots — capacity-2 patches are precious, since only they can reach Flourishing and only they can fuel two neighbors at once.</li>
          <li>Add a Decay Court for nitrogen, then attempt the demanding species (Crystal Cap, Spore Hall) once you have spare resources.</li>
          <li>Hyphal Labs accept any one resource and convert it to <span style={{ color: '#e8c46b' }}>✦ science</span>, which boosts your final score.</li>
          <li>Final score = <em>raw points × network health</em>. Leaving lots of patches Dormant tanks your multiplier.</li>
        </ul>

        <h3>Controls</h3>
        <p>
          <span className="key">Esc</span> cancels a pending weave or closes a panel.
          <span className="key" style={{ marginLeft: 8 }}>Right-click</span> on the map also cancels weaving.
        </p>
      </div>
    </div>
  );
}

// ---------- Main app ----------
export default function Mycelium() {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [state, setState] = useState(() => defaultState(seed));
  const [hoverNode, setHoverNode] = useState(null);
  const [mousePos, setMousePos] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, startPan: { x: 0, y: 0 } });
  // Node-originated drag (drag-to-weave-hypha). Independent of dragRef which is for map panning.
  const nodeDragRef = useRef(null);
  const svgRef = useRef(null);
  const mapInnerRef = useRef(null);

  const net = useMemo(() => computeNetwork(state), [state]);
  const income = useMemo(() => computeIncome(state, net), [state, net]);
  const score = useMemo(() => computeScore(state, net), [state, net]);

  const newGame = () => {
    const s = Math.floor(Math.random() * 1e9);
    setSeed(s);
    setState(defaultState(s));
  };

  // Edge validation
  const canConnect = (fromId, toId) => {
    if (fromId === toId) return false;
    const a = state.map.nodes[fromId], b = state.map.nodes[toId];
    if (!a.explored || !b.explored) return false;
    if (!a.species || !b.species) return false;
    // already exists?
    if (state.edges.some(e =>
      (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)
    )) return false;
    // distance limit
    if (distance(a, b) > 320) return false;
    // no crossings
    for (const e of state.edges) {
      const c = state.map.nodes[e.from], d = state.map.nodes[e.to];
      if (segmentsIntersect(a, b, c, d)) return false;
    }
    // cost check
    if (state.nutrients < 5) return false;
    return true;
  };

  const handleNodeClick = (id) => {
    if (state.gameOver) return;
    // If user just dragged, suppress the click
    if (dragRef.current.moved) return;
    if (state.pendingEdgeFrom !== null) {
      if (canConnect(state.pendingEdgeFrom, id)) {
        setState(st => ({
          ...st,
          edges: [...st.edges, { from: st.pendingEdgeFrom, to: id }],
          nutrients: st.nutrients - 5,
          pendingEdgeFrom: null,
          log: [`Wove a hypha (${st.pendingEdgeFrom} ↔ ${id}).`, ...st.log].slice(0, 6),
        }));
      } else {
        setState(st => ({ ...st, pendingEdgeFrom: null, log: ['Connection failed.', ...st.log].slice(0, 6) }));
      }
    } else {
      const node = state.map.nodes[id];
      if (!node.explored) return;
      setState(st => ({ ...st, selectedNode: id }));
    }
  };

  // Pass year
  const passYear = () => {
    if (state.gameOver) return;
    setState(st => {
      const newNutrients = st.nutrients + income;
      const sciencePerYear = st.map.nodes.reduce((acc, n) => {
        if (n.species === 'hyphallab' && net[n.id].satisfied) return acc + net[n.id].imports.length;
        return acc;
      }, 0);
      const newYear = st.year + 1;
      const over = newYear >= st.maxYears;
      return {
        ...st,
        year: newYear,
        nutrients: newNutrients,
        science: st.science + sciencePerYear,
        gameOver: over,
        log: over
          ? ['── The season ends. ──', `Final score: ${score.final}`, ...st.log].slice(0, 6)
          : [`Year ${newYear}: +${income} nutrients${sciencePerYear ? `, +${sciencePerYear} science` : ''}.`, ...st.log].slice(0, 6),
      };
    });
  };

  // Convert screen coords to SVG world coords (accounting for pan)
  const screenToWorld = (clientX, clientY) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = state.map.width / rect.width;
    const scaleY = state.map.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX + pan.x,
      y: (clientY - rect.top) * scaleY + pan.y,
    };
  };

  // Pointer-down on a node: start a potential drag-to-weave. If the pointer
  // moves past threshold we enter pending-edge mode; if released without
  // moving, it falls through to a normal click (opens menu / completes
  // an in-flight pending edge).
  const handleNodePointerDown = (e, nodeId) => {
    if (e.button !== undefined && e.button !== 0) return;
    const node = state.map.nodes[nodeId];
    if (!node?.explored) return;
    e.stopPropagation();
    nodeDragRef.current = {
      id: nodeId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch (err) {}
  };

  const handlePointerDown = (e) => {
    // Background pan (only fires when not on a node — node handlers stopPropagation).
    if (e.button !== undefined && e.button !== 0) return;
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      startPan: { ...pan },
    };
    if (e.target.setPointerCapture && e.pointerId !== undefined) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    }
  };

  const handlePointerMove = (e) => {
    // Drag-to-weave: track movement from a node origin.
    const ndrag = nodeDragRef.current;
    if (ndrag) {
      const dx = e.clientX - ndrag.startX;
      const dy = e.clientY - ndrag.startY;
      if (!ndrag.moved && Math.hypot(dx, dy) > 5) {
        ndrag.moved = true;
        const src = state.map.nodes[ndrag.id];
        if (src.species) {
          setState(st => ({ ...st, pendingEdgeFrom: ndrag.id, selectedNode: null }));
        }
      }
      if (ndrag.moved) {
        setMousePos(screenToWorld(e.clientX, e.clientY));
      }
      return;
    }
    // Existing preview update for click-then-click flow.
    if (state.pendingEdgeFrom !== null && !dragRef.current.active) {
      setMousePos(screenToWorld(e.clientX, e.clientY));
    }
    // Pan drag.
    if (dragRef.current.active) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (!dragRef.current.moved && Math.hypot(dx, dy) > 4) {
        dragRef.current.moved = true;
      }
      if (dragRef.current.moved) {
        const rect = svgRef.current.getBoundingClientRect();
        const scaleX = state.map.width / rect.width;
        const scaleY = state.map.height / rect.height;
        const maxPan = 400;
        setPan({
          x: Math.max(-maxPan, Math.min(maxPan, dragRef.current.startPan.x - dx * scaleX)),
          y: Math.max(-maxPan, Math.min(maxPan, dragRef.current.startPan.y - dy * scaleY)),
        });
      }
    }
  };

  const handlePointerUp = (e) => {
    const ndrag = nodeDragRef.current;
    if (ndrag) {
      nodeDragRef.current = null;
      if (ndrag.moved) {
        const src = state.map.nodes[ndrag.id];
        if (src.species) {
          // Determine the node under the pointer at release.
          const el = document.elementFromPoint(e.clientX, e.clientY);
          const targetG = el?.closest?.('g[data-node-id]');
          const targetId = targetG ? Number(targetG.getAttribute('data-node-id')) : NaN;
          if (Number.isFinite(targetId) && targetId !== ndrag.id && canConnect(ndrag.id, targetId)) {
            setState(st => ({
              ...st,
              edges: [...st.edges, { from: ndrag.id, to: targetId }],
              nutrients: st.nutrients - 5,
              pendingEdgeFrom: null,
              log: [`Wove a hypha (${ndrag.id} ↔ ${targetId}).`, ...st.log].slice(0, 6),
            }));
          } else {
            setState(st => ({ ...st, pendingEdgeFrom: null }));
          }
        }
      } else {
        // No movement — treat as a click on the node.
        handleNodeClick(ndrag.id);
      }
      return;
    }
    dragRef.current.active = false;
  };

  const cancelEdge = () => setState(st => ({ ...st, pendingEdgeFrom: null }));

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setShowHelp(false);
        setState(st => ({ ...st, pendingEdgeFrom: null, selectedNode: null }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pendingFromNode = state.pendingEdgeFrom !== null ? state.map.nodes[state.pendingEdgeFrom] : null;
  const hoverNodeObj = hoverNode !== null ? state.map.nodes[hoverNode] : null;
  const hoveredFromValid = pendingFromNode && hoverNodeObj
    ? canConnect(state.pendingEdgeFrom, hoverNode)
    : false;

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,500&family=JetBrains+Mono:wght@400;600&display=swap');

        * { box-sizing: border-box; }

        .app {
          width: 100%;
          min-height: 100vh;
          background:
            radial-gradient(ellipse at 20% 10%, rgba(122, 156, 106, 0.08) 0%, transparent 50%),
            radial-gradient(ellipse at 80% 90%, rgba(232, 196, 107, 0.06) 0%, transparent 50%),
            radial-gradient(ellipse at 50% 50%, #14110e 0%, #0a0807 100%);
          color: #d8cfbf;
          font-family: 'Cormorant Garamond', Georgia, serif;
          padding: 20px;
          position: relative;
          overflow: hidden;
        }
        .app::before {
          content: '';
          position: absolute; inset: 0;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.4 0 0 0 0 0.35 0 0 0 0 0.25 0 0 0 0.04 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
          pointer-events: none;
          opacity: 0.6;
          z-index: 0;
        }

        .container {
          max-width: 1400px;
          margin: 0 auto;
          position: relative;
          z-index: 1;
        }

        header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          margin-bottom: 18px;
          padding-bottom: 14px;
          border-bottom: 1px solid #2a241e;
        }
        .title {
          font-family: 'Cormorant Garamond', serif;
          font-weight: 500;
          font-style: italic;
          font-size: 42px;
          letter-spacing: 0.02em;
          color: #e8c46b;
          margin: 0;
          line-height: 1;
          text-shadow: 0 0 30px rgba(232, 196, 107, 0.2);
        }
        .subtitle {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.3em;
          text-transform: uppercase;
          color: #7a6f5e;
          margin-top: 8px;
        }
        .stats-bar {
          display: flex;
          gap: 28px;
          align-items: center;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
        }
        .stat {
          display: flex;
          flex-direction: column;
          gap: 2px;
          align-items: flex-end;
        }
        .stat-label {
          color: #6a5f4e;
          font-size: 9px;
          letter-spacing: 0.25em;
          text-transform: uppercase;
        }
        .stat-value {
          color: #e8c46b;
          font-size: 18px;
          font-family: 'Cormorant Garamond', serif;
          font-weight: 600;
        }

        .help-btn {
          background: #14110e;
          border: 1px solid #5a4f42;
          color: #e8c46b;
          width: 38px; height: 38px;
          border-radius: 50%;
          cursor: pointer;
          font-family: 'Cormorant Garamond', serif;
          font-style: italic;
          font-size: 22px;
          line-height: 1;
          display: flex; align-items: center; justify-content: center;
          transition: all 0.2s;
          box-shadow: 0 0 12px rgba(232, 196, 107, 0.15);
          flex-shrink: 0;
        }
        .help-btn:hover {
          background: #2a241e;
          border-color: #e8c46b;
          box-shadow: 0 0 20px rgba(232, 196, 107, 0.4);
        }

        /* In-map species menu — compact, translucent */
        .patch-menu {
          position: absolute;
          background: rgba(20, 16, 12, 0.78);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          border: 1px solid rgba(90, 79, 66, 0.6);
          border-radius: 3px;
          padding: 2px;
          font-family: 'Cormorant Garamond', serif;
          color: #d8cfbf;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          display: flex;
          flex-direction: column;
          animation: menuRise 0.15s ease;
          z-index: 20;
        }
        @keyframes menuRise {
          from { opacity: 0; transform: translateY(-3px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .patch-menu-head {
          display: flex; justify-content: space-between; align-items: center;
          font-family: 'JetBrains Mono', monospace;
          font-size: 8px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #7a6f5e;
          padding: 3px 6px 3px;
          margin-bottom: 1px;
        }
        .patch-menu-head button {
          background: none; border: none; color: #7a6f5e;
          font-size: 14px; line-height: 1; cursor: pointer; padding: 0 2px;
          font-family: serif;
        }
        .patch-menu-head button:hover { color: #e8c46b; }
        .patch-menu-row {
          display: flex; justify-content: space-between; align-items: center;
          width: 100%;
          background: none;
          border: none;
          padding: 2px 6px;
          color: #d8cfbf;
          cursor: pointer;
          font-family: 'Cormorant Garamond', serif;
          font-size: 12px;
          border-radius: 2px;
          transition: background 0.1s;
          text-align: left;
          gap: 8px;
        }
        .patch-menu-row:hover:not(:disabled) {
          background: rgba(60, 48, 32, 0.6);
          color: #e8c46b;
        }
        .patch-menu-row:disabled { opacity: 0.4; cursor: not-allowed; }
        .pm-name { font-style: italic; white-space: nowrap; }
        .pm-flow { font-size: 11px; display: flex; align-items: center; gap: 1px; }
        .pm-arr { color: #5a4f42; margin: 0 2px; }
        .pm-cost {
          font-family: 'JetBrains Mono', monospace;
          font-size: 8px;
          color: #7a6f5e;
          margin-left: 4px;
        }

        .modal-backdrop {
          position: fixed; inset: 0;
          background: rgba(8, 6, 4, 0.85);
          backdrop-filter: blur(4px);
          z-index: 100;
          display: flex; align-items: center; justify-content: center;
          padding: 20px;
          animation: fadeIn 0.25s ease;
        }
        .modal {
          background: linear-gradient(180deg, #1c1814 0%, #14100c 100%);
          border: 1px solid #3a3530;
          border-radius: 4px;
          max-width: 640px;
          width: 100%;
          max-height: 90vh;
          overflow-y: auto;
          padding: 28px 32px;
          box-shadow: 0 20px 80px rgba(0,0,0,0.8), 0 0 60px rgba(232, 196, 107, 0.06);
          animation: rise 0.3s ease;
        }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes rise { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

        .modal h2 {
          font-family: 'Cormorant Garamond', serif;
          font-style: italic;
          font-weight: 500;
          font-size: 32px;
          color: #e8c46b;
          margin: 0 0 4px;
          line-height: 1;
        }
        .modal h3 {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.3em;
          text-transform: uppercase;
          color: #9ec48a;
          margin: 22px 0 10px;
          padding-bottom: 6px;
          border-bottom: 1px dashed #2a241e;
        }
        .modal p, .modal li {
          font-family: 'Cormorant Garamond', serif;
          font-size: 16px;
          line-height: 1.5;
          color: #c8bfaf;
        }
        .modal ul { padding-left: 20px; margin: 8px 0; }
        .modal li { margin-bottom: 6px; }
        .modal .modal-eyebrow {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.3em;
          text-transform: uppercase;
          color: #7a6f5e;
          margin-bottom: 4px;
        }
        .modal .key {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: #e8c46b;
          background: #14100c;
          border: 1px solid #3a3530;
          padding: 1px 6px;
          border-radius: 2px;
        }
        .modal-close {
          background: none;
          border: 1px solid #3a3530;
          color: #7a6f5e;
          width: 32px; height: 32px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
        }
        .modal-close:hover { color: #e8c46b; border-color: #e8c46b; }
        .modal-head {
          display: flex; justify-content: space-between; align-items: flex-start;
          margin-bottom: 6px;
        }

        .diagram {
          background: #0e0b08;
          border: 1px solid #2a241e;
          border-radius: 3px;
          padding: 14px;
          margin: 12px 0;
        }
        .diagram-caption {
          font-family: 'JetBrains Mono', monospace;
          font-size: 9px;
          letter-spacing: 0.25em;
          text-transform: uppercase;
          color: #6a5f4e;
          text-align: center;
          margin-top: 6px;
        }

        .res-row {
          display: flex; flex-wrap: wrap; gap: 12px;
          margin: 10px 0;
          font-size: 14px;
        }
        .res-row > span {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 3px 10px;
          background: #14100c;
          border: 1px solid #2a241e;
          border-radius: 12px;
          font-family: 'Cormorant Garamond', serif;
          color: #c8bfaf;
        }

        .layout {
          display: grid;
          grid-template-columns: 1fr 320px;
          gap: 18px;
        }

        @media (max-width: 900px) {
          .app { padding: 10px; }
          .layout {
            grid-template-columns: 1fr;
            gap: 12px;
          }
          header {
            flex-direction: column;
            align-items: flex-start;
            gap: 12px;
          }
          .title { font-size: 32px; }
          .stats-bar {
            width: 100%;
            justify-content: space-between;
            gap: 12px;
          }
          .stat { align-items: flex-start; }
          .stat-value { font-size: 16px; }
          .map-panel { padding: 10px; }
          .panel { padding: 14px; }
          .panel-title { font-size: 18px; }
        }

        .map-panel {
          background: linear-gradient(180deg, #181410 0%, #100c08 100%);
          border: 1px solid #2a241e;
          border-radius: 4px;
          padding: 16px;
          position: relative;
          box-shadow:
            inset 0 0 60px rgba(0,0,0,0.6),
            0 4px 20px rgba(0,0,0,0.4);
        }
        .map-inner {
          position: relative;
          width: 100%;
        }
        .map-svg {
          display: block;
          width: 100%;
          height: auto;
          cursor: ${state.pendingEdgeFrom !== null ? 'crosshair' : 'grab'};
        }
        .map-svg:active { cursor: ${state.pendingEdgeFrom !== null ? 'crosshair' : 'grabbing'}; }
        .map-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          color: #6a5f4e;
          letter-spacing: 0.2em;
          text-transform: uppercase;
        }

        .side {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .panel {
          background: linear-gradient(180deg, #1c1814 0%, #14100c 100%);
          border: 1px solid #2a241e;
          border-radius: 4px;
          padding: 18px;
        }
        .panel-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 14px;
          padding-bottom: 12px;
          border-bottom: 1px solid #2a241e;
        }
        .panel-eyebrow {
          font-family: 'JetBrains Mono', monospace;
          font-size: 9px;
          letter-spacing: 0.3em;
          color: #7a6f5e;
          margin-bottom: 4px;
        }
        .panel-title {
          font-family: 'Cormorant Garamond', serif;
          font-style: italic;
          font-size: 22px;
          color: #e8c46b;
          line-height: 1.1;
        }
        .x-btn {
          background: none;
          border: 1px solid #3a3530;
          color: #7a6f5e;
          width: 26px;
          height: 26px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
        }
        .x-btn:hover { color: #e8c46b; border-color: #e8c46b; }

        .kv {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px dashed #2a241e;
          font-size: 14px;
        }
        .kv > span:first-child {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.2em;
          color: #7a6f5e;
          text-transform: uppercase;
          align-self: center;
        }

        .tier-badge {
          font-family: 'Cormorant Garamond', serif;
          font-style: italic;
          font-weight: 600;
        }
        .tier-badge[data-tier="0"] { color: #6a5f4e; }
        .tier-badge[data-tier="1"] { color: #7a9c6a; }
        .tier-badge[data-tier="2"] { color: #9ec48a; }
        .tier-badge[data-tier="3"] { color: #e8c46b; }

        .btn {
          width: 100%;
          padding: 10px 14px;
          border: 1px solid #3a3530;
          background: #181410;
          color: #d8cfbf;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 0.25em;
          text-transform: uppercase;
          cursor: pointer;
          margin-top: 12px;
          transition: all 0.2s;
        }
        .btn:hover:not(:disabled) {
          background: #2a241e;
          color: #e8c46b;
          border-color: #e8c46b;
        }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn.primary { border-color: #5a4f42; color: #e8c46b; }

        .hint {
          font-style: italic;
          color: #8a7f6e;
          font-size: 14px;
          margin-bottom: 12px;
        }
        .species-grid {
          display: grid;
          gap: 8px;
        }
        .species-card {
          text-align: left;
          background: #14100c;
          border: 1px solid #2a241e;
          padding: 10px 12px;
          cursor: pointer;
          color: #d8cfbf;
          font-family: 'Cormorant Garamond', serif;
          transition: all 0.15s;
        }
        .species-card:hover:not(:disabled) {
          border-color: #e8c46b;
          background: #1c1814;
        }
        .species-card:disabled { opacity: 0.4; cursor: not-allowed; }
        .species-name {
          font-size: 16px;
          font-style: italic;
          color: #e8c46b;
        }
        .species-flow {
          display: flex; align-items: center; gap: 6px;
          margin-top: 4px;
          font-size: 12px;
          color: #8a7f6e;
        }
        .arrow { color: #5a4f42; }
        .species-cost {
          font-family: 'JetBrains Mono', monospace;
          font-size: 9px;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: #6a5f4e;
          margin-top: 4px;
        }

        .legend {
          font-size: 13px;
        }
        .legend-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 5px 0;
        }
        .legend-row span:last-child {
          font-family: 'JetBrains Mono', monospace;
          font-size: 9px;
          color: #6a5f4e;
          letter-spacing: 0.15em;
          text-transform: uppercase;
        }

        .log {
          font-size: 13px;
          font-style: italic;
          color: #8a7f6e;
          max-height: 130px;
          overflow-y: auto;
        }
        .log-line { padding: 4px 0; border-bottom: 1px dashed #2a241e; }
        .log-line:first-child { color: #d8cfbf; }

        .toolbar {
          display: flex; gap: 8px;
        }
        .toolbar .btn { margin-top: 0; }

        .game-over {
          text-align: center;
          padding: 24px 0;
        }
        .game-over .title {
          font-size: 48px;
          color: #e8c46b;
        }
        .game-over .score {
          font-family: 'Cormorant Garamond', serif;
          font-size: 64px;
          color: #e8c46b;
          font-weight: 600;
          line-height: 1;
          margin: 16px 0 4px;
        }
        .game-over .breakdown {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: #7a6f5e;
          letter-spacing: 0.2em;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.8; }
        }
      `}</style>

      <div className="container">
        <header>
          <div>
            <h1 className="title">Mycelium</h1>
            <div className="subtitle">a network of patient threads · year {state.year} of {state.maxYears}</div>
          </div>
          <div className="stats-bar">
            <div className="stat">
              <span className="stat-label">Nutrients</span>
              <span className="stat-value">{state.nutrients}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Yield/yr</span>
              <span className="stat-value" style={{ color: income >= 0 ? '#9ec48a' : '#c46a5a' }}>
                {income >= 0 ? '+' : ''}{income}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Science</span>
              <span className="stat-value">{state.science}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Score</span>
              <span className="stat-value">{score.final}</span>
            </div>
            <button
              className="help-btn"
              onClick={() => setShowHelp(true)}
              aria-label="How to play"
              title="How to play"
            >?</button>
          </div>
        </header>

        <div className="layout">
          <div className="map-panel">
            <div className="map-header">
              <span>· forest floor ·</span>
              <span>
                {state.pendingEdgeFrom !== null
                  ? `weaving from node ${state.pendingEdgeFrom} — click target or press esc`
                  : 'click a patch to inspect'}
              </span>
            </div>
            <div className="map-inner" ref={mapInnerRef}>
            <svg
              ref={svgRef}
              viewBox={`${pan.x} ${pan.y} ${state.map.width} ${state.map.height}`}
              className="map-svg"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onPointerLeave={handlePointerUp}
              onContextMenu={(e) => { e.preventDefault(); cancelEdge(); }}
              style={{ touchAction: 'none' }}
            >
              {/* Grid texture — tile larger so it shows when panned */}
              <defs>
                <pattern id="forest-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                  <circle cx="20" cy="20" r="0.5" fill="#2a241e" opacity="0.5" />
                </pattern>
                <radialGradient id="patch-glow">
                  <stop offset="0%" stopColor="#3a3025" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#3a3025" stopOpacity="0" />
                </radialGradient>
              </defs>
              {/* Background covers the panned area too */}
              <rect x={pan.x - 100} y={pan.y - 100}
                width={state.map.width + 200} height={state.map.height + 200}
                fill="url(#forest-grid)" />

              {/* Edges */}
              {state.edges.map((e, i) => (
                <EdgeGraphic
                  key={i}
                  from={state.map.nodes[e.from]}
                  to={state.map.nodes[e.to]}
                  flow={net.edgeFlows?.[i]}
                />
              ))}

              {/* Nodes */}
              {state.map.nodes.map(n => (
                <g
                  key={n.id}
                  data-node-id={n.id}
                  onPointerDown={(e) => handleNodePointerDown(e, n.id)}
                  onMouseEnter={() => setHoverNode(n.id)}
                  onMouseLeave={() => setHoverNode(null)}
                  style={{ cursor: n.explored ? 'pointer' : 'default' }}
                >
                  <NodeGraphic
                    node={n}
                    netInfo={net[n.id]}
                    isSelected={state.selectedNode === n.id}
                    isHovered={hoverNode === n.id}
                    isPendingFrom={state.pendingEdgeFrom === n.id}
                    hoveredFromValid={state.pendingEdgeFrom !== null && hoverNode === n.id && hoveredFromValid}
                  />
                </g>
              ))}

              {/* Preview edge — drawn last so it stays on top of nodes */}
              {pendingFromNode && mousePos && (
                <PreviewEdge
                  from={pendingFromNode}
                  to={hoverNodeObj || mousePos}
                  valid={hoverNodeObj ? hoveredFromValid : true}
                />
              )}
            </svg>
            <PatchMenu
              state={state}
              setState={setState}
              svgRef={svgRef}
              containerRef={mapInnerRef}
              pan={pan}
            />
            </div>
          </div>

          <div className="side">
            {state.gameOver ? (
              <div className="panel game-over">
                <div className="panel-eyebrow">final reckoning</div>
                <div className="score">{score.final}</div>
                <div className="breakdown">
                  raw {score.raw} × health {Math.round(score.happiness * 100)}%
                </div>
                <button className="btn primary" onClick={newGame}>New forest</button>
              </div>
            ) : state.selectedNode !== null && state.map.nodes[state.selectedNode].species ? (
              <NodePanel
                state={state}
                setState={setState}
                net={net}
                onClose={() => setState(st => ({ ...st, selectedNode: null }))}
              />
            ) : (
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <div className="panel-eyebrow">field guide</div>
                    <div className="panel-title">Resources</div>
                  </div>
                </div>
                <div className="legend">
                  {Object.entries(RESOURCES).map(([key, r]) => (
                    <div key={key} className="legend-row">
                      <span>
                        <span style={{ color: r.color, fontSize: 16, marginRight: 8 }}>{r.glyph}</span>
                        {r.name}
                      </span>
                      <span>{key}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 14, fontStyle: 'italic', color: '#8a7f6e', fontSize: 13, lineHeight: 1.5 }}>
                  Cultivate species on patches. Weave hyphae between them. A thread carries one resource each way — only what one side produces and the other side needs.
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-head">
                <div>
                  <div className="panel-eyebrow">controls</div>
                  <div className="panel-title">The Season</div>
                </div>
              </div>
              <div className="toolbar">
                <button className="btn primary" onClick={passYear} disabled={state.gameOver}>
                  Pass year
                </button>
                <button className="btn" onClick={newGame}>
                  New forest
                </button>
              </div>
              {(pan.x !== 0 || pan.y !== 0) && (
                <button className="btn" onClick={() => setPan({ x: 0, y: 0 })}>
                  Recenter map
                </button>
              )}
              {state.pendingEdgeFrom !== null && (
                <button className="btn" onClick={cancelEdge}>
                  Cancel weave
                </button>
              )}
              <div style={{ marginTop: 12, fontFamily: 'JetBrains Mono, monospace', fontSize: 9, letterSpacing: '0.2em', color: '#6a5f4e', textTransform: 'uppercase' }}>
                cost · grow 15 · lab 25 · weave 5
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <div>
                  <div className="panel-eyebrow">chronicle</div>
                  <div className="panel-title">Field Notes</div>
                </div>
              </div>
              <div className="log">
                {state.log.map((line, i) => (
                  <div key={i} className="log-line">{line}</div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}
