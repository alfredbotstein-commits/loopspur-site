import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=30',
  'Content-Type': 'application/json',
};

async function q(table, opts = {}) {
  try {
    let query = supabase.from(table).select(opts.select || '*');
    if (opts.eq) for (const [k, v] of Object.entries(opts.eq)) query = query.eq(k, v);
    if (opts.neq) for (const [k, v] of Object.entries(opts.neq)) query = query.neq(k, v);
    if (opts.in_) for (const [k, v] of Object.entries(opts.in_)) query = query.in(k, v);
    if (opts.gte) for (const [k, v] of Object.entries(opts.gte)) query = query.gte(k, v);
    if (opts.order) query = query.order(opts.order, { ascending: opts.asc ?? false });
    if (opts.limit) query = query.limit(opts.limit);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error(`q(${table}): ${e.message}`);
    return [];
  }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const today = new Date().toISOString().slice(0, 10);

    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const [
      tasks, events, policies, triggers, revenue,
      products, opportunities, sessions, tokenUsage, modelRouting,
      v3Positions, v3Signals, affiliateClicks
    ] = await Promise.all([
      q('factory_tasks', { order: 'created_at', limit: 300 }),
      q('factory_events', { order: 'created_at', limit: 500 }),
      q('factory_policy'),
      q('factory_triggers'),
      q('revenue_events', { order: 'created_at', limit: 200 }),
      q('products'),
      q('opportunities', { order: 'score', limit: 30 }),
      q('agent_sessions', { order: 'started_at', limit: 50 }),
      q('token_usage', { order: 'created_at', limit: 500, gte: { created_at: today } }),
      q('model_routing'),
      q('v3_positions', { order: 'opened_at', limit: 500 }),
      q('v3_signals', { order: 'timestamp', limit: 500 }),
      q('affiliate_clicks', { order: 'created_at', limit: 500 }),
    ]);

    const todayEvents = events.filter(e => e.created_at?.startsWith(today));
    const todayTasks = tasks.filter(t => t.created_at?.startsWith(today));

    // ── Agents ──
    const agentMeta = {
      alfred:  { role: "COO", icon: "🎩", angle: 270, color: "#00d4ff" },
      isaiah:  { role: "Engineer", icon: "⚡", angle: 342, color: "#a78bfa" },
      paul:    { role: "Growth", icon: "📢", angle: 54, color: "#00ff88" },
      daniel:  { role: "Intel", icon: "🔍", angle: 126, color: "#fbbf24" },
      raphael: { role: "Design", icon: "🎨", angle: 162, color: "#64748b" },
    };
    const agents = {};
    const now = Date.now();
    for (const [name, meta] of Object.entries(agentMeta)) {
      // Find most recent session for this agent
      const sess = sessions
        .filter(s => s.agent === name)
        .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0];
      // Determine real status: if heartbeat >30min old, treat as offline even if DB says online
      let realStatus = sess?.status || 'offline';
      if (realStatus === 'online' && sess?.last_heartbeat_at) {
        const hbAge = now - new Date(sess.last_heartbeat_at).getTime();
        if (hbAge > 30 * 60 * 1000) realStatus = 'stale'; // >30min without heartbeat
      }
      const agTasks = tasks.filter(t => t.assigned_agent === name);
      const agTodayTasks = todayTasks.filter(t => t.assigned_agent === name);
      const agTokens = tokenUsage.filter(t => t.agent === name);
      const cost = agTokens.reduce((s, t) => s + parseFloat(t.cost_usd || 0), 0);
      const running = agTasks.find(t => t.status === 'running');
      const succeeded = agTodayTasks.filter(t => t.status === 'succeeded').length;
      const total = agTodayTasks.length;
      // Last activity from events
      const lastEvent = events.find(e => e.agent === name);
      const lastActiveMin = lastEvent ? Math.round((now - new Date(lastEvent.created_at).getTime()) / 60000) : null;
      agents[name] = {
        name: name.toUpperCase(),
        role: meta.role,
        icon: meta.icon,
        angle: meta.angle,
        color: meta.color,
        status: realStatus,
        model: sess?.model || null,
        task: running?.title || (realStatus === 'online' ? 'Awaiting dispatch' : realStatus === 'stale' ? 'No heartbeat' : 'Offline'),
        tasks: total,
        cost: Math.round(cost * 100) / 100,
        eff: total > 0 ? Math.round((succeeded / total) * 100) : 0,
        last_active_min: lastActiveMin,
        last_heartbeat: sess?.last_heartbeat_at || null,
      };
    }

    // ── Products ──
    const prodList = products.map(p => {
      const rev = revenue.filter(r => r.product === p.id || r.product === p.name?.toLowerCase()).reduce((s, r) => s + parseFloat(r.amount || 0), 0);
      return {
        name: p.name, price: p.price_point || p.price || '—', status: p.stage || p.status || 'Planned',
        blocker: p.blocker || '', rev: Math.round(rev * 100) / 100,
        c: (p.stage || p.status) === 'qa' ? '#22d3ee' : (p.stage || p.status) === 'build' ? '#a78bfa' : (p.stage || p.status) === 'launch' ? '#00ff88' : '#64748b',
        mat: parseFloat(p.maturity || 0),
      };
    });

    // ── Opportunities ──
    const oppList = opportunities.map(o => ({
      name: o.name, score: o.score || 0,
      v: o.verdict || (o.score >= 20 ? 'GO' : o.score >= 15 ? 'MAYBE' : 'NO'),
      c: (o.score || 0) >= 20 ? '#00ff88' : (o.score || 0) >= 15 ? '#fbbf24' : '#ef4444',
    }));

    // ── Scanners ──
    const scannerDefs = [
      { name: 'Polymarket', freq: '4h', icon: '📈' },
      { name: 'Reddit', freq: '6h', icon: '🔴' },
      { name: 'Crypto Prices', freq: '30m', icon: '₿' },
      { name: 'GSC Keywords', freq: 'daily', icon: '🔑' },
      { name: 'Hacker News', freq: '—', icon: '🟠' },
      { name: 'Product Hunt', freq: '—', icon: '🐱' },
      { name: 'Twitter/X', freq: '—', icon: '✕' },
      { name: 'Amazon', freq: '—', icon: '📦' },
    ];
    const scannerEvents = events.filter(e => e.tags?.includes('scanner'));
    const scanners = scannerDefs.map(s => {
      const match = scannerEvents.filter(e =>
        e.payload?.scanner === s.name.toLowerCase().replace(/\s+/g, '_') ||
        e.payload?.type?.includes(s.name.toLowerCase())
      );
      return {
        ...s,
        sigs: match[0]?.payload?.signals || 0,
        status: match.length > 0 ? 'idle' : (s.freq === '—' ? 'planned' : 'idle'),
      };
    });

    // ── Tasks (for Kanban) ──
    const taskList = tasks.slice(0, 100).map(t => ({
      id: t.id,
      title: t.title,
      agent: t.assigned_agent || 'alfred',
      product: t.product || 'factory',
      priority: t.priority || 'normal',
      status: t.status || 'queued',
      created: t.created_at ? new Date(t.created_at).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }) + ' ' + new Date(t.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—',
    }));

    // ── Events (for activity feed) ──
    const eventList = events.slice(0, 50).map(e => {
      const d = new Date(e.created_at);
      return {
        t: d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        a: e.agent || 'system',
        m: e.payload?.message || e.event_type,
        y: e.event_type?.includes('success') || e.event_type?.includes('complete') ? 'success' : 'ok',
        type: e.event_type || 'unknown',
        product: e.product || e.payload?.product || 'factory',
      };
    });

    // ── Triggers ──
    const triggerList = triggers.map(t => ({
      n: t.name, s: (t.fire_count || 0) > 0 ? 'fired' : t.enabled ? 'armed' : 'off', f: t.fire_count || 0,
    }));

    // ── Policies → Cap Gates ──
    const capGates = policies.map(p => ({
      n: p.key, v: typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value),
      s: p.value?.blocked ? 'blocked' : p.value?.armed !== false ? 'armed' : 'ok',
    }));

    // ── Revenue ──
    const totalRevenue = revenue.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const todayRevenue = revenue.filter(r => r.created_at?.startsWith(today)).reduce((s, r) => s + parseFloat(r.amount || 0), 0);

    // ── Revenue Channels ──
    const revChannels = [
      { c: 'Stripe (SaaS)', s: totalRevenue > 0 ? 'Live' : 'Wiring' },
      { c: 'Apple App Store', s: 'Blocked' },
      { c: 'Google Play', s: 'Blocked' },
      { c: 'Affiliate (AISP)', s: 'Live' },
      { c: 'Kraken Trading', s: 'Not started' },
    ];

    // ── Tokens ──
    const tokensByAgent = {};
    const tokensByTier = { T1: 0, T2: 0, T3: 0 };
    for (const t of tokenUsage) {
      tokensByAgent[t.agent] = (tokensByAgent[t.agent] || 0) + parseFloat(t.cost_usd || 0);
      const tier = t.model?.includes('kimi') ? 'T1' : t.model?.includes('opus') ? 'T3' : 'T2';
      tokensByTier[tier] += parseFloat(t.cost_usd || 0);
    }
    const totalCost = tokenUsage.reduce((s, t) => s + parseFloat(t.cost_usd || 0), 0);
    const tokenTiers = [
      { t: 'T1 Routine', m: 'Kimi k2.5', p: totalCost > 0 ? Math.round((tokensByTier.T1 / totalCost) * 100) : 30 },
      { t: 'T2 Standard', m: 'Sonnet 4.5', p: totalCost > 0 ? Math.round((tokensByTier.T2 / totalCost) * 100) : 50 },
      { t: 'T3 Complex', m: 'Opus 4.5', p: totalCost > 0 ? Math.round((tokensByTier.T3 / totalCost) * 100) : 20 },
    ];

    // ── P0 Blockers ──
    const p0 = tasks
      .filter(t => t.priority === 'critical' && !['succeeded', 'cancelled'].includes(t.status))
      .map(t => ({ i: t.title, o: t.assigned_agent || 'Unassigned' }));

    // ── Content ──
    const contentEvents = todayEvents.filter(e =>
      e.tags?.includes('content') || e.event_type === 'article_published'
    );
    const content = {
      target: 10,
      today: contentEvents.length,
      crawls: null, // dynamic — not available without GSC API key in env
      indexed: null, // dynamic — not available without GSC API key in env
    };

    // ── Phases ──
    const phases = [
      { n: '1', nm: 'Foundation', p: 100 },
      { n: '1B', nm: 'Factory Tooling', p: 65 },
      { n: '2', nm: 'First Revenue', p: totalRevenue > 0 ? 40 : 20 },
      { n: '3', nm: 'Scale', p: 0 },
      { n: '4', nm: 'Trading', p: 0 },
      { n: '5', nm: 'Business Intake', p: 0 },
      { n: '6', nm: 'Full Autonomy', p: 10 },
    ];

    // ── Social Accounts ──
    const socials = [
      { p: 'X/Twitter', h: '@GetPolyPulse', s: 'ok' },
      { p: 'X/Twitter', h: '@aistackpicks', s: 'ok' },
      { p: 'Reddit', h: 'poly_trader_tx', s: 'farm' },
      { p: 'Reddit', h: 'Fit_Mike_txfisher', s: 'farm' },
      { p: 'Reddit', h: 'HonestFastTeam', s: 'brand' },
      { p: 'Telegram', h: '@Albert_Botstein_bot', s: 'ok' },
      { p: 'GitHub', h: 'alfredbotstein-commits', s: 'ok' },
    ];

    // ── Connections ──
    const onlineAgents = Object.entries(agents).filter(([, a]) => a.status === 'online').map(([id]) => id);
    const connections = [
      { from: 'daniel', to: 'paul' },
      { from: 'paul', to: 'alfred' },
      { from: 'alfred', to: 'isaiah' },
      { from: 'daniel', to: 'alfred' },
      { from: 'alfred', to: 'raphael' },
      { from: 'raphael', to: 'isaiah' },
    ].map(c => ({
      ...c,
      active: onlineAgents.includes(c.from) && onlineAgents.includes(c.to),
    }));

    // ── Infra ──
    const alfredSess = sessions.find(s => s.agent === 'alfred');
    // Infra: derive from actual session data
    const alfredAge = alfredSess?.started_at ? Math.round((now - new Date(alfredSess.started_at).getTime()) / 3600000) : null;
    const infra = {
      mac: alfredSess?.status === 'online' ? 'online' : 'unknown',
      gw: ':18789',
      oc: null, // populated by heartbeat cron
      tok: null, // populated by heartbeat cron
      res: null, // populated by heartbeat cron
      rst: alfredSess?.started_at ? new Date(alfredSess.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—',
      alfred_uptime_hours: alfredAge,
      sess: {},
    };
    for (const name of Object.keys(agentMeta)) {
      const s = sessions.find(ss => ss.agent === name);
      infra.sess[name] = s?.status === 'online' ? 'ok' : '—';
    }

    // ── arb-daemon (monitored system, not an agent) ──
    const arbDaemon = {
      edges: ['Edge 2: FLB', 'Edge 4: Brackets', 'Edge 5: Regime'],
      risk: '10% daily loss → HALT', capital: '$1,000 starting',
      mode: 'dry_run',
    };

    // ── Optimization ──
    const optTasks = tasks.filter(t => t.tags?.includes?.('optimization'));
    const optimization = {
      total: optTasks.length || 35,
      done: optTasks.filter(t => t.status === 'succeeded').length || 4,
    };

    // ── Crons (pull from OpenClaw if possible, else static) ──
    const crons = [
      { t: '*/5m', j: 'Watchdog', a: 'system', last: '—', next: '—' },
      { t: '*/30m', j: 'OAuth Refresh', a: 'system', last: '—', next: '—' },
      { t: '*/30m', j: 'Crypto Scan', a: 'daniel', last: '—', next: '—' },
      { t: '4h', j: 'Polymarket', a: 'daniel', last: '—', next: '—' },
      { t: '6h', j: 'Reddit Scan', a: 'daniel', last: '—', next: '—' },
      { t: '@reboot', j: 'Gateway', a: 'system', last: '—', next: '—' },
      { t: '6 AM', j: 'Keywords', a: 'daniel', last: '—', next: '—' },
      { t: '8 AM', j: 'Content', a: 'paul', last: '—', next: '—' },
      { t: '9 AM', j: 'Heartbeat', a: 'alfred', last: '—', next: '—' },
      { t: '10 AM', j: 'Review', a: 'alfred', last: '—', next: '—' },
      { t: '8 PM', j: 'Report', a: 'alfred', last: '—', next: '—' },
      { t: 'Weekly', j: 'Memory', a: 'alfred', last: '—', next: '—' },
    ];

    // Enrich crons with last event times
    for (const cron of crons) {
      const match = events.find(e =>
        e.agent === cron.a &&
        (e.payload?.message?.toLowerCase().includes(cron.j.toLowerCase()) ||
         e.event_type?.toLowerCase().includes(cron.j.toLowerCase().replace(/\s+/g, '_')))
      );
      if (match) {
        cron.last = new Date(match.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      }
    }

    // ── Trading (v3) ──
    const posOpen = v3Positions.filter(p => p.status === 'open');
    const posSettled = v3Positions.filter(p => p.status === 'settled');
    const posCancelled = v3Positions.filter(p => p.status === 'cancelled');
    const posExpired = v3Positions.filter(p => p.status === 'expired_unprocessed');
    const posFlushed = v3Positions.filter(p => p.status === 'flushed' || p.status === 'flushed_stale');
    const totalPnl = posSettled.reduce((s, p) => s + parseFloat(p.realized_pnl || 0), 0);
    const totalCostTrading = posSettled.reduce((s, p) => s + parseFloat(p.total_cost || 0), 0);
    const todaySettled = posSettled.filter(p => p.closed_at?.startsWith(today) || p.opened_at?.startsWith(today));
    const todayPnl = todaySettled.reduce((s, p) => s + parseFloat(p.realized_pnl || 0), 0);
    const todayCostTrading = todaySettled.reduce((s, p) => s + parseFloat(p.total_cost || 0), 0);
    const settledWins = posSettled.filter(p => parseFloat(p.realized_pnl || 0) > 0).length;
    const winRate = posSettled.length > 0 ? Math.round((settledWins / posSettled.length) * 10000) / 100 : 0;

    // Daily P&L history (last 14 days)
    const dailyPnl = {};
    for (const p of posSettled) {
      const day = (p.closed_at || p.opened_at || '').slice(0, 10);
      if (!day) continue;
      if (!dailyPnl[day]) dailyPnl[day] = { pnl: 0, cost: 0, trades: 0, wins: 0 };
      dailyPnl[day].pnl += parseFloat(p.realized_pnl || 0);
      dailyPnl[day].cost += parseFloat(p.total_cost || 0);
      dailyPnl[day].trades++;
      if (parseFloat(p.realized_pnl || 0) > 0) dailyPnl[day].wins++;
    }
    // Convert to sorted array, last 14 days
    const dailyPnlArr = Object.entries(dailyPnl)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14)
      .map(([day, d]) => ({
        day,
        pnl: Math.round(d.pnl * 100) / 100,
        cost: Math.round(d.cost * 100) / 100,
        trades: d.trades,
        wins: d.wins,
        win_rate: d.trades > 0 ? Math.round((d.wins / d.trades) * 100) : 0,
      }));

    // Edge performance
    const edgeSet = new Set(v3Positions.map(p => p.edge).filter(Boolean));
    const edges = [...edgeSet].map(edge => {
      const ePos = v3Positions.filter(p => p.edge === edge);
      const eSettled = ePos.filter(p => p.status === 'settled');
      const eWins = eSettled.filter(p => parseFloat(p.realized_pnl || 0) > 0).length;
      const ePnl = eSettled.reduce((s, p) => s + parseFloat(p.realized_pnl || 0), 0);
      const eCost = eSettled.reduce((s, p) => s + parseFloat(p.total_cost || 0), 0);
      const eTodaySettled = eSettled.filter(p => (p.closed_at || p.opened_at || '').startsWith(today));
      const eTodayPnl = eTodaySettled.reduce((s, p) => s + parseFloat(p.realized_pnl || 0), 0);
      return {
        edge,
        positions: ePos.length,
        settled: eSettled.length,
        wins: eWins,
        win_rate: eSettled.length > 0 ? Math.round((eWins / eSettled.length) * 10000) / 100 : 0,
        pnl: Math.round(ePnl * 100) / 100,
        cost: Math.round(eCost * 100) / 100,
        today_pnl: Math.round(eTodayPnl * 100) / 100,
        roi: eCost > 0 ? Math.round((ePnl / eCost) * 10000) / 100 : 0,
      };
    });

    // Signal summary
    const todaySignals = v3Signals.filter(s => s.timestamp?.startsWith(today));
    const byAction = {};
    const byEdge = {};
    for (const s of v3Signals) {
      byAction[s.action || 'unknown'] = (byAction[s.action || 'unknown'] || 0) + 1;
      byEdge[s.edge || 'unknown'] = (byEdge[s.edge || 'unknown'] || 0) + 1;
    }

    // Gordon decommissioned Feb 2026 — all arb strategies dead.
    // v3_positions contains stale dry-run data. Zero it out.
    const tradingDecommissioned = true;

    const trading = {
      balance: tradingDecommissioned ? 0 : (1000 + Math.round(totalPnl * 100) / 100),
      starting_capital: tradingDecommissioned ? 0 : 1000,
      mode: tradingDecommissioned ? 'decommissioned' : 'dry_run',
      decommissioned: tradingDecommissioned,
      positions: {
        open: posOpen.length,
        settled: posSettled.length,
        cancelled: posCancelled.length,
        expired_unprocessed: posExpired.length,
        flushed: posFlushed.length,
        total: v3Positions.length,
      },
      pnl: {
        total: Math.round(totalPnl * 100) / 100,
        today: Math.round(todayPnl * 100) / 100,
        total_cost: Math.round(totalCostTrading * 100) / 100,
        today_cost: Math.round(todayCostTrading * 100) / 100,
        win_rate: winRate,
        wins: settledWins,
        losses: posSettled.length - settledWins,
        roi: totalCostTrading > 0 ? Math.round((totalPnl / totalCostTrading) * 10000) / 100 : 0,
      },
      daily_pnl: dailyPnlArr,
      edges,
      recent_positions: v3Positions.slice(-20).reverse(),
      recent_signals: v3Signals.slice(-30).reverse(),
      signal_summary: {
        total: v3Signals.length,
        today: todaySignals.length,
        by_action: byAction,
        by_edge: byEdge,
      },
    };

    // ── Agent Activity Feed (last 10 per agent) ──
    const agentActivity = {};
    for (const name of Object.keys(agentMeta)) {
      agentActivity[name] = events
        .filter(e => e.agent === name)
        .slice(0, 10)
        .map(e => ({
          t: new Date(e.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          ts: e.created_at,
          type: e.event_type || 'unknown',
          m: e.payload?.message || e.event_type,
          product: e.product || e.payload?.product || '',
          tags: e.tags || [],
        }));
    }

    // ── Content Velocity ──
    const contentAllEvents = events.filter(e =>
      e.event_type === 'articles_published' ||
      e.event_type === 'article_published' ||
      (e.event_type === 'step_completed' && (e.tags?.includes('content') || e.tags?.includes('article'))) ||
      e.tags?.includes('content')
    );
    const contentToday = contentAllEvents.filter(e => e.created_at?.startsWith(today)).length;
    const contentWeek = contentAllEvents.filter(e => e.created_at >= weekAgo).length;
    const contentTotal = contentAllEvents.length;
    // Try to extract article counts from payload
    let articlesToday = 0, articlesWeek = 0, articlesTotal = 0;
    for (const e of contentAllEvents) {
      const count = e.payload?.articles_count || e.payload?.count || 1;
      if (e.created_at?.startsWith(today)) articlesToday += count;
      if (e.created_at >= weekAgo) articlesWeek += count;
      articlesTotal += count;
    }
    const contentVelocity = {
      today: articlesToday || contentToday,
      week: articlesWeek || contentWeek,
      total: articlesTotal || contentTotal,
      target_daily: 10,
    };

    // ── Arb Daemon Summary (for dashboard) ──
    const arbEvents = events.filter(e => e.tags?.includes('arb') || e.event_type?.includes('arb'));
    const latestArbEvent = arbEvents[0]; // most recent (already sorted desc)
    const arbSummary = {
      pnl_total: Math.round(totalPnl * 100) / 100,
      pnl_today: Math.round(todayPnl * 100) / 100,
      win_rate: winRate,
      positions_open: posOpen.length,
      positions_settled: posSettled.length,
      last_signal: v3Signals[0]?.timestamp || null,
      status: posOpen.length > 0 || (v3Signals[0] && new Date(v3Signals[0].timestamp) > new Date(Date.now() - 3600000)) ? 'active' : 'idle',
      mode: 'dry_run',
    };

    // ── Revenue Detail ──
    const monthStart = today.slice(0, 7) + '-01';
    const revenueMTD = revenue.filter(r => r.created_at >= monthStart).reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const stripeRevenue = revenue.filter(r => r.source === 'stripe' || r.channel === 'stripe');
    const stripeMRR = stripeRevenue.filter(r => r.type === 'subscription' || r.recurring).reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const affClicksToday = (affiliateClicks || []).filter(c => c.created_at?.startsWith(today)).length;
    const affClicksTotal = (affiliateClicks || []).length;
    const revenueDetail = {
      total: Math.round(totalRevenue * 100) / 100,
      today: Math.round(todayRevenue * 100) / 100,
      mtd: Math.round(revenueMTD * 100) / 100,
      mrr: Math.round(stripeMRR * 100) / 100,
      affiliate_clicks_today: affClicksToday,
      affiliate_clicks_total: affClicksTotal,
    };

    // ── Last Briefing Sent ──
    const briefingEvents = events.filter(e =>
      e.event_type === 'briefing_sent' ||
      e.event_type === 'morning_briefing' ||
      e.event_type === 'evening_briefing' ||
      (e.payload?.message || '').toLowerCase().includes('briefing')
    );
    const lastBriefing = briefingEvents[0] ? {
      timestamp: briefingEvents[0].created_at,
      type: briefingEvents[0].event_type || 'briefing',
      agent: briefingEvents[0].agent || 'alfred',
      ago: Math.round((Date.now() - new Date(briefingEvents[0].created_at).getTime()) / 60000),
    } : null;

    // ── Enhanced Crons with status ──
    for (const cron of crons) {
      if (cron.last !== '—') {
        cron.status = 'ok';
      } else {
        cron.status = 'unknown';
      }
    }

    // ── Agent Last Active ──
    const agentLastActive = {};
    for (const name of Object.keys(agentMeta)) {
      const agEvents = events.filter(e => e.agent === name);
      if (agEvents.length > 0) {
        agentLastActive[name] = {
          timestamp: agEvents[0].created_at,
          ago_min: Math.round((Date.now() - new Date(agEvents[0].created_at).getTime()) / 60000),
          event: agEvents[0].event_type || 'unknown',
          message: agEvents[0].payload?.message || agEvents[0].event_type || '',
        };
      }
    }

    // ── Pending Approvals (tasks needing Scott's decision) ──
    const pendingApprovals = tasks
      .filter(t =>
        t.status === 'blocked' ||
        t.priority === 'critical' ||
        t.tags?.includes?.('needs_approval') ||
        t.tags?.includes?.('pending_approval')
      )
      .map(t => ({
        id: t.id,
        title: t.title,
        agent: t.assigned_agent || 'unassigned',
        priority: t.priority || 'normal',
        status: t.status,
        product: t.product || 'factory',
        created: t.created_at,
        age_hours: Math.round((Date.now() - new Date(t.created_at).getTime()) / 3600000),
        tags: t.tags || [],
      }));

    // ── Factory Health Score (0-100) ──
    const healthAgents = Math.round((Object.values(agents).filter(a => a.status === 'online').length / Object.keys(agentMeta).length) * 25);
    const healthTasks = Math.max(0, 25 - (tasks.filter(t => t.status === 'blocked').length * 4) - (p0.length * 3));
    const healthContent = Math.min(25, Math.round(((articlesToday || contentToday) / 10) * 25));
    const healthSystems = Math.min(25, 15 + (totalRevenue > 0 ? 5 : 0) + (posOpen.length === 0 ? 5 : 3));
    const healthScore = {
      total: Math.min(100, healthAgents + healthTasks + healthContent + healthSystems),
      agents: healthAgents,
      tasks: healthTasks,
      content: healthContent,
      systems: healthSystems,
      grade: (healthAgents + healthTasks + healthContent + healthSystems) >= 80 ? 'A' :
             (healthAgents + healthTasks + healthContent + healthSystems) >= 60 ? 'B' :
             (healthAgents + healthTasks + healthContent + healthSystems) >= 40 ? 'C' : 'D',
    };

    // ── Commander's Brief (auto-generated) ──
    const briefParts = [];
    const onlineNames = Object.entries(agents).filter(([,a]) => a.status === 'online').map(([id]) => id);
    const offlineNames = Object.entries(agents).filter(([,a]) => a.status !== 'online').map(([id]) => id);
    briefParts.push(`${onlineNames.length}/${Object.keys(agents).length} agents online (${onlineNames.join(', ')}).`);
    if (offlineNames.length > 0) briefParts.push(`Offline: ${offlineNames.join(', ')}.`);
    const blockedTasks = tasks.filter(t => t.status === 'blocked');
    if (blockedTasks.length > 0) briefParts.push(`⚠️ ${blockedTasks.length} tasks blocked.`);
    if (p0.length > 0) briefParts.push(`🚨 ${p0.length} P0 items need attention.`);
    briefParts.push(`Content: ${articlesToday || contentToday}/${10} articles today (${articlesTotal || contentTotal} total).`);
    if (todayRevenue > 0) briefParts.push(`💰 $${todayRevenue.toFixed(2)} revenue today.`);
    else briefParts.push(`Revenue: $0 today. MRR: $${(stripeMRR || 0).toFixed(2)}.`);
    if (posOpen.length > 0) briefParts.push(`Trading: ${posOpen.length} positions open.`);
    if (pendingApprovals.length > 0) briefParts.push(`📋 ${pendingApprovals.length} items awaiting review.`);
    const commanderBrief = briefParts.join(' ');

    // ── Uptime (last 24h event coverage per agent) ──
    const last24h = new Date(Date.now() - 24 * 3600000).toISOString();
    const agentUptime = {};
    for (const name of Object.keys(agentMeta)) {
      const recent = events.filter(e => e.agent === name && e.created_at >= last24h);
      // Rough uptime: if events spread across multiple hours, agent was active
      const hoursActive = new Set(recent.map(e => new Date(e.created_at).getHours())).size;
      agentUptime[name] = {
        events_24h: recent.length,
        hours_active: hoursActive,
        uptime_pct: Math.min(100, Math.round((hoursActive / 24) * 100)),
      };
    }

    const output = {
      generated_at: new Date().toISOString(),
      agents,
      connections,
      products: prodList,
      opportunities: oppList,
      scanners,
      tasks: taskList,
      task_summary: {
        queued: tasks.filter(t => t.status === 'queued').length,
        running: tasks.filter(t => t.status === 'running').length,
        blocked: tasks.filter(t => t.status === 'blocked').length,
        succeeded_today: todayTasks.filter(t => t.status === 'succeeded').length,
        failed_today: todayTasks.filter(t => t.status === 'failed').length,
      },
      events: eventList,
      triggers: triggerList,
      cap_gates: capGates,
      revenue: { total: Math.round(totalRevenue * 100) / 100, today: Math.round(todayRevenue * 100) / 100 },
      rev_channels: revChannels,
      tokens: { total_cost: Math.round(totalCost * 100) / 100, by_agent: tokensByAgent, tiers: tokenTiers },
      p0: p0,
      content,
      phases,
      socials,
      infra,
      arb_daemon: arbDaemon,
      optimization,
      crons,
      trading,
      agent_activity: agentActivity,
      content_velocity: contentVelocity,
      arb_summary: arbSummary,
      revenue_detail: revenueDetail,
      last_briefing: lastBriefing,
      db_tables: ['factory_tasks','factory_steps','factory_events','factory_policy','factory_triggers','revenue_events','products','opportunities','agent_sessions','token_usage','model_routing','v3_positions','v3_signals'],
      agent_last_active: agentLastActive,
      pending_approvals: pendingApprovals,
      health_score: healthScore,
      commander_brief: commanderBrief,
      agent_uptime: agentUptime,
    };

    return { statusCode: 200, headers: CORS, body: JSON.stringify(output) };
  } catch (e) {
    console.error('Factory status error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
}
