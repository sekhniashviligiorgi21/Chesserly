<script setup>
  import { ref, computed, onMounted, watch } from 'vue'
  import Title from '../assets/Title.vue'
  import { auth, db } from '../firebase'
  import { onAuthStateChanged } from 'firebase/auth'
  import { collection, query, orderBy, getDocs } from 'firebase/firestore'

  // --- Theme Management ---
  const currentTheme = ref(localStorage.getItem('chesslab_theme') || 'midnight')
  watch(currentTheme, (newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('chesslab_theme', newTheme)
  }, { immediate: true })

  // --- User & State ---
  const currentUser = ref(null)
  const insights = ref([])
  const loading = ref(true)
  const activeTab = ref('overview')
  const isPremium = ref(false)
  const premiumChecked = ref(true)

  onMounted(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser.value = user
        await fetchInsights()
      } else {
        currentUser.value = null
        insights.value = []
      }
      loading.value = false
    })
  })

  async function fetchInsights() {
    if (!currentUser.value) return
    try {
      const q = query(
        collection(db, `users/${currentUser.value.uid}/games`),
        orderBy('createdAt', 'desc')
      )
      const querySnapshot = await getDocs(q)
      insights.value = querySnapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(game => game.insights && game.insights.overallAccuracy !== null)
    } catch (e) {
      console.error("Failed to load insights:", e)
    }
  }

  // --- Helper: normalize player field (string or object) ---
  function normalizePlayer(p) {
    if (!p) return { username: 'Unknown', rating: 0, result: 'unknown' }
    if (typeof p === 'string') return { username: p, rating: 0, result: 'unknown' }
    return { username: p.username || 'Unknown', rating: p.rating || 0, result: p.result || 'unknown' }
  }

  function getAccuracyMeta(acc) {
    if (acc === null || acc === undefined) return { label: 'N/A', icon: null, color: '#666' }
    if (acc >= 95) return { label: 'Brilliant', icon: '/moveClassifications/brilliant.png', color: '#03aea7' }
    if (acc >= 90) return { label: 'Great', icon: '/moveClassifications/great.png', color: '#8eae83' }
    if (acc >= 80) return { label: 'Best', icon: '/moveClassifications/best.png', color: '#6ad13f' }
    if (acc >= 70) return { label: 'Excellent', icon: '/moveClassifications/excellent.png', color: '#90bc36' }
    if (acc >= 60) return { label: 'Good', icon: '/moveClassifications/good.png', color: '#f2bc43' }
    if (acc >= 50) return { label: 'Inaccuracy', icon: '/moveClassifications/inaccuracy.png', color: '#f2bc43' }
    if (acc >= 40) return { label: 'Mistake', icon: '/moveClassifications/mistake.png', color: '#f38800' }
    return { label: 'Blunder', icon: '/moveClassifications/blunder.png', color: '#FF0000' }
  }

  // --- Core Stats ---
  const totalGames = computed(() => insights.value.length)
  const totalMoves = computed(() => insights.value.reduce((sum, g) => sum + (g.insights?.totalMoves || 0), 0))

  const overallAccuracy = computed(() => {
    const gamesWithAcc = insights.value.filter(g => g.insights?.overallAccuracy !== null)
    if (gamesWithAcc.length === 0) return null
    const sum = gamesWithAcc.reduce((acc, g) => acc + g.insights.overallAccuracy, 0)
    return (sum / gamesWithAcc.length).toFixed(1)
  })

  const overallMeta = computed(() => getAccuracyMeta(overallAccuracy.value ? parseFloat(overallAccuracy.value) : null))

  // --- Performance by Color ---
  const colorPerformance = computed(() => {
    const colors = {
      white: { games: 0, win: 0, loss: 0, draw: 0, accs: [], blunders: 0 },
      black: { games: 0, win: 0, loss: 0, draw: 0, accs: [], blunders: 0 }
    }
    insights.value.forEach(g => {
      const c = g.insights?.myColor
      if (!c || !colors[c]) return
      colors[c].games++
      colors[c].accs.push(g.insights.overallAccuracy || 0)
      colors[c].blunders += (g.insights.moveCounts?.blunder || 0) + (g.insights.moveCounts?.mistake || 0)
      const player = normalizePlayer(c === 'white' ? g.white : g.black)
      const myRes = player.result
      if (myRes === 'win') colors[c].win++
      else if (['lose', 'loss', 'checkmated', 'resigned', 'abandoned'].includes(myRes)) colors[c].loss++
      else colors[c].draw++
    })
    const calcAcc = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null
    return {
      white: { ...colors.white, avgAcc: calcAcc(colors.white.accs) },
      black: { ...colors.black, avgAcc: calcAcc(colors.black.accs) }
    }
  })

  // --- Piece Performance ---
  const pieceMeta = [
    { key: 'p', label: 'Pawn', symbol: '♟', color: '#cccccc' },
    { key: 'n', label: 'Knight', symbol: '♞', color: '#a8d97a' },
    { key: 'b', label: 'Bishop', symbol: '♝', color: '#7ec8e3' },
    { key: 'r', label: 'Rook', symbol: '♜', color: '#f0d0a3' },
    { key: 'q', label: 'Queen', symbol: '♛', color: '#d9b382' },
    { key: 'k', label: 'King', symbol: '♚', color: '#f5f5dc' },
  ]

  const pieceStats = computed(() => {
    const totals = { p: { count: 0, sum: 0 }, n: { count: 0, sum: 0 }, b: { count: 0, sum: 0 }, r: { count: 0, sum: 0 }, q: { count: 0, sum: 0 }, k: { count: 0, sum: 0 } }
    insights.value.forEach(g => {
      if (g.insights?.pieceStats) {
        for (const key in totals) {
          totals[key].count += g.insights.pieceStats[key]?.count || 0
          totals[key].sum += g.insights.pieceStats[key]?.sum || 0
        }
      }
    })
    return totals
  })

  const totalPieceMoves = computed(() => Object.values(pieceStats.value).reduce((a, b) => a + b.count, 0))

  const pieceData = computed(() => {
    return pieceMeta.map(p => {
      const stats = pieceStats.value[p.key]
      const avgAcc = stats.count > 0 ? (stats.sum / stats.count).toFixed(1) : null
      const movePercent = totalPieceMoves.value > 0 ? ((stats.count / totalPieceMoves.value) * 100).toFixed(1) : 0
      return { ...p, count: stats.count, avgAcc: avgAcc ? parseFloat(avgAcc) : null, meta: avgAcc ? getAccuracyMeta(parseFloat(avgAcc)) : getAccuracyMeta(null), movePercent }
    })
  })

  // --- Game Length Stats ---
  const gameLengthStats = computed(() => {
    const buckets = {
      short: { label: 'Short (<20)', games: 0, win: 0, loss: 0, draw: 0, accs: [], blunders: 0 },
      medium: { label: 'Medium (20-40)', games: 0, win: 0, loss: 0, draw: 0, accs: [], blunders: 0 },
      long: { label: 'Long (40+)', games: 0, win: 0, loss: 0, draw: 0, accs: [], blunders: 0 }
    }
    insights.value.forEach(g => {
      const moves = g.insights?.totalMoves || 0
      const c = g.insights?.myColor
      if (!c) return
      const bucket = moves < 20 ? 'short' : moves <= 40 ? 'medium' : 'long'
      buckets[bucket].games++
      buckets[bucket].accs.push(g.insights.overallAccuracy || 0)
      buckets[bucket].blunders += (g.insights.moveCounts?.blunder || 0) + (g.insights.moveCounts?.mistake || 0)
      const player = normalizePlayer(c === 'white' ? g.white : g.black)
      const myRes = player.result
      if (myRes === 'win') buckets[bucket].win++
      else if (['lose', 'loss', 'checkmated', 'resigned', 'abandoned'].includes(myRes)) buckets[bucket].loss++
      else buckets[bucket].draw++
    })
    return Object.values(buckets).map(b => ({
      ...b,
      avgAcc: b.accs.length ? (b.accs.reduce((a, b) => a + b, 0) / b.accs.length).toFixed(1) : null
    }))
  })

  // --- Move-Number Accuracy Buckets ---
  const moveBucketOrder = ['1-10', '11-20', '21-30', '31-40', '41+']
  const moveBucketData = computed(() => {
    const agg = {}
    moveBucketOrder.forEach(k => { agg[k] = { sum: 0, count: 0 } })
    insights.value.forEach(g => {
      const mb = g.insights?.moveBuckets
      if (!mb) return
      for (const key of moveBucketOrder) {
        if (mb[key]) {
          agg[key].sum += mb[key].sum || 0
          agg[key].count += mb[key].count || 0
        }
      }
    })
    return moveBucketOrder.map(k => ({
      label: k,
      avgAcc: agg[k].count > 0 ? (agg[k].sum / agg[k].count).toFixed(1) : null,
      count: agg[k].count,
      meta: agg[k].count > 0 ? getAccuracyMeta(agg[k].sum / agg[k].count) : getAccuracyMeta(null)
    }))
  })

  const hasMoveBuckets = computed(() => moveBucketData.value.some(b => b.count > 0))

  // --- Recent Games Strip ---
  const recentGames = computed(() => {
    return insights.value.slice(0, 5).map(g => {
      const c = g.insights?.myColor || 'white'
      const player = normalizePlayer(c === 'white' ? g.white : g.black)
      const opponent = normalizePlayer(c === 'white' ? g.black : g.white)
      let outcome = 'draw'
      if (player.result === 'win') outcome = 'win'
      else if (['lose', 'loss', 'checkmated', 'resigned', 'abandoned'].includes(player.result)) outcome = 'loss'
      const acc = g.insights?.overallAccuracy
      return {
        id: g.id,
        opponent: opponent.username,
        outcome,
        accuracy: acc !== null && acc !== undefined ? acc.toFixed(1) : '—',
        accMeta: getAccuracyMeta(acc),
        opening: g.insights?.opening || 'Unknown',
        myColor: c
      }
    })
  })

  // --- Accuracy Sparkline ---
  const sparklineData = computed(() => {
    const games = [...insights.value].reverse().filter(g => g.insights?.overallAccuracy !== null)
    if (games.length < 2) return null
    const accs = games.map(g => g.insights.overallAccuracy)
    const min = Math.min(...accs) - 5
    const max = Math.max(...accs) + 5
    const range = max - min || 1
    const w = 280, h = 50, pad = 4
    const points = accs.map((a, i) => {
      const x = pad + (i / (accs.length - 1)) * (w - pad * 2)
      const y = h - pad - ((a - min) / range) * (h - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    return { points: points.join(' '), width: w, height: h, lastAcc: accs[accs.length - 1].toFixed(1) }
  })

  // --- Coach Digest ---
  const coachDigest = computed(() => {
    if (insights.value.length < 3) return null
    const lines = []

    // Worst phase
    const pa = phaseAccuracy.value
    const phases = [
      { name: 'opening', val: pa.opening.val ? parseFloat(pa.opening.val) : null },
      { name: 'middlegame', val: pa.middlegame.val ? parseFloat(pa.middlegame.val) : null },
      { name: 'endgame', val: pa.endgame.val ? parseFloat(pa.endgame.val) : null }
    ].filter(p => p.val !== null)
    if (phases.length > 0) {
      const worst = phases.reduce((a, b) => a.val < b.val ? a : b)
      const best = phases.reduce((a, b) => a.val > b.val ? a : b)
      if (best.val - worst.val > 5) {
        lines.push(`Your ${worst.name} accuracy (${worst.val.toFixed(1)}%) trails your ${best.name} (${best.val.toFixed(1)}%) by ${(best.val - worst.val).toFixed(1)} points. Focus training there.`)
      }
    }

    // Blunder rate
    const totalBlunders = moveCounts.value.blunder + moveCounts.value.mistake
    const perGame = totalBlunders / (totalGames.value || 1)
    if (perGame > 2) {
      lines.push(`You average ${perGame.toFixed(1)} mistakes+blunders per game. Reducing this to under 1.5 would be the single biggest rating gain available.`)
    }

    // Move-bucket cliff
    if (hasMoveBuckets.value) {
      const withAcc = moveBucketData.value.filter(b => b.avgAcc !== null)
      if (withAcc.length >= 2) {
        let biggestDrop = 0, dropLabel = ''
        for (let i = 1; i < withAcc.length; i++) {
          const drop = parseFloat(withAcc[i - 1].avgAcc) - parseFloat(withAcc[i].avgAcc)
          if (drop > biggestDrop) { biggestDrop = drop; dropLabel = `moves ${withAcc[i].label}` }
        }
        if (biggestDrop > 5) {
          lines.push(`Your accuracy drops ${biggestDrop.toFixed(1)}% around ${dropLabel} — likely time pressure. Practice longer time controls or train endgame technique.`)
        }
      }
    }

    // Trend
    if (trend.value) {
      if (trend.value.direction === 'up') lines.push(`You're improving: +${trend.value.delta}% accuracy over your last ${RECENT_WINDOW} games. Keep going.`)
      else if (trend.value.direction === 'down') lines.push(`Accuracy is down ${Math.abs(parseFloat(trend.value.delta))}% recently. Consider reviewing your last few losses before playing more.`)
    }

    if (lines.length === 0) lines.push('Your stats look balanced. Keep analyzing games and doing your puzzles to maintain momentum.')

    return lines
  })

  // --- Playstyle Radar (v2) ---
  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))
  const shrink50 = (value, sample, full) => 50 + (value - 50) * Math.min(1, sample / full)

  const playstyleAgg = computed(() => {
    const games = insights.value.filter(g => g.insights?.playstyle?.v === 2)
    if (games.length === 0) return null
    const s = {
      games: games.length, myMoves: 0, checks: 0, captures: 0, forcingMoves: 0, sacrifices: 0,
      inducedErrors: 0, brilliantPlus: 0, bookMoves: 0,
      errInacc: 0, errMist: 0, errBlund: 0,
      cpLost: 0, cpWon: 0, swingsFor: 0, swingsAgainst: 0,
      defendSum: 0, defendCount: 0, attackSum: 0, attackCount: 0,
      openingAccSum: 0, openingAccW: 0, openingMoves: 0,
      endDeltaSum: 0, endDeltaW: 0, endgamesReached: 0, endgameWins: 0
    }
    games.forEach(g => {
      const p = g.insights.playstyle
      const overall = g.insights.overallAccuracy
      const pa = g.insights.phaseAccuracy || {}
      const pc = p.phaseCounts || {}
      s.myMoves += p.myMoves || 0
      s.checks += p.checks || 0
      s.captures += p.captures || 0
      s.forcingMoves += p.forcingMoves || 0
      s.sacrifices += p.sacrifices || 0
      s.inducedErrors += p.inducedErrors || 0
      s.brilliantPlus += p.brilliantPlus || 0
      s.bookMoves += p.bookMoves || 0
      s.errInacc += p.errors?.inaccuracy || 0
      s.errMist += p.errors?.mistake || 0
      s.errBlund += p.errors?.blunder || 0
      s.cpLost += p.cpLost || 0
      s.cpWon += p.cpWon || 0
      s.swingsFor += p.bigSwingsFor || 0
      s.swingsAgainst += p.bigSwingsAgainst || 0
      s.defendSum += p.defendSum || 0
      s.defendCount += p.defendCount || 0
      s.attackSum += p.attackSum || 0
      s.attackCount += p.attackCount || 0
      if (pa.opening != null && pc.opening > 0) { s.openingAccSum += pa.opening * pc.opening; s.openingAccW += pc.opening; s.openingMoves += pc.opening }
      if (pa.endgame != null && pc.endgame > 0 && overall != null) { s.endDeltaSum += (pa.endgame - overall) * pc.endgame; s.endDeltaW += pc.endgame }
      if (p.reachedEndgame) { s.endgamesReached++; if (p.result === 'win') s.endgameWins++ }
    })
    return s
  })

  const legacyPlaystyleGames = computed(() =>
    insights.value.filter(g => g.insights?.playstyle && g.insights.playstyle.v !== 2).length
  )

  const playstyleData = computed(() => {
    const s = playstyleAgg.value
    if (!s || s.myMoves === 0) return null
    const pm = (v) => v / s.myMoves
    const aggression = clamp(pm(s.checks) * 220 + pm(s.captures) * 90 + pm(s.sacrifices) * 280 + pm(s.brilliantPlus) * 150)
    const tactics = clamp(pm(s.inducedErrors) * 120 + pm(s.swingsFor) * 300 + pm(s.brilliantPlus) * 140 + pm(s.cpWon) * 1.2)
    const errLoad = pm(s.errInacc + 2.5 * s.errMist + 5 * s.errBlund)
    const solidity = clamp(100 - errLoad * 60 - pm(s.swingsAgainst) * 250 - pm(s.cpLost) * 0.8)
    const defendAvg = s.defendCount > 0 ? s.defendSum / s.defendCount : 50
    const resilience = clamp(shrink50(defendAvg, s.defendCount, 15))
    const endDeltaAvg = s.endDeltaW > 0 ? s.endDeltaSum / s.endDeltaW : 0
    let endgame = shrink50(50 + endDeltaAvg * 2.2, s.endDeltaW, 25)
    if (s.endgamesReached > 0) endgame = 0.65 * endgame + 0.35 * (s.endgameWins / s.endgamesReached) * 100
    endgame = clamp(endgame)
    const openingAvg = s.openingAccW > 0 ? s.openingAccSum / s.openingAccW : 50
    const opening = clamp(shrink50(openingAvg, s.openingMoves, 40) + pm(s.bookMoves) * 60)
    return [
      { axis: 'Aggression', value: aggression },
      { axis: 'Tactics', value: tactics },
      { axis: 'Solidity', value: solidity },
      { axis: 'Resilience', value: resilience },
      { axis: 'Endgame', value: endgame },
      { axis: 'Opening', value: opening }
    ]
  })

  const radarPoints = computed(() => {
    const data = playstyleData.value
    if (!data) return ''
    const n = data.length, center = 100, radius = 72
    return data.map((d, i) => {
      const angle = (i * (360 / n) - 90) * Math.PI / 180
      return `${center + (d.value / 100) * radius * Math.cos(angle)},${center + (d.value / 100) * radius * Math.sin(angle)}`
    }).join(' ')
  })

  const radarGrid = computed(() => {
    const n = playstyleData.value?.length || 6
    const center = 100, radius = 72
    return [0.25, 0.5, 0.75, 1].map(level =>
      Array.from({ length: n }).map((_, i) => {
        const angle = (i * (360 / n) - 90) * Math.PI / 180
        return `${center + level * radius * Math.cos(angle)},${center + level * radius * Math.sin(angle)}`
      }).join(' ')
    )
  })

  const radarLabels = computed(() => {
    const data = playstyleData.value
    if (!data) return []
    const n = data.length, center = 100, radius = 86
    return data.map((d, i) => {
      const angle = (i * (360 / n) - 90) * Math.PI / 180
      return { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle), label: d.axis, value: d.value.toFixed(0) }
    })
  })

  const playstyleNote = computed(() => {
    const s = playstyleAgg.value
    const data = playstyleData.value
    if (!s || !data) return null
    const sorted = [...data].sort((a, b) => b.value - a.value)
    const top = sorted[0], second = sorted[1]
    const g = s.games
    const f1 = (v) => (v / g).toFixed(1)
    const f2 = (v) => (v / g).toFixed(2)
    const c = {
      forcing: f1(s.forcingMoves), checks: f1(s.checks), captures: f1(s.captures), sacs: f2(s.sacrifices),
      brill: f1(s.brilliantPlus), induced: f1(s.inducedErrors), swingsFor: f2(s.swingsFor), swingsAgainst: f2(s.swingsAgainst),
      errors: f1(s.errMist + s.errBlund),
      attack: s.attackCount > 0 ? (s.attackSum / s.attackCount).toFixed(1) : '—',
      defend: s.defendCount > 0 ? (s.defendSum / s.defendCount).toFixed(1) : '—',
      defendMoves: s.defendCount,
      endDelta: s.endDeltaW > 0 ? (s.endDeltaSum / s.endDeltaW).toFixed(1) : '—',
      conv: s.endgamesReached > 0 ? Math.round((s.endgameWins / s.endgamesReached) * 100) : null,
      opening: s.openingAccW > 0 ? (s.openingAccSum / s.openingAccW).toFixed(1) : '—',
      book: f1(s.bookMoves)
    }
    const notes = {
      Aggression: { title: 'The Firebrand', body: () => `You average ${c.forcing} forcing moves per game — ${c.checks} checks and ${c.captures} captures — and offer ${c.sacs} compensated sacrifices per game. You don't wait for sharp positions, you create them. The classic warning applies: attacks need fuel. When the initiative stalls, make sure you're not left a pawn down with a dead position.` },
      Tactics: { title: 'The Calculator', body: () => `Your strong moves are genuinely uncomfortable to answer — opponents crack for ${c.induced} weighted errors per game right after you find a good move, and the eval bar swings ≥1.5 pawns your way ${c.swingsFor} times per game (${c.brill} brilliant/great moves per game). You're at your best in concrete sequences — just watch the clock.` },
      Solidity: { title: 'The Fortress', body: () => `You hand opponents almost nothing: ${c.errors} mistakes-plus-blunders per game and only ${c.swingsAgainst} eval collapses per game.${c.attack !== '—' ? ` And when you're pressing, you keep composure — ${c.attack}% accuracy with a clear advantage.` : ''} The one risk: against lower-rated opponents, ultra-solid play can dissipate winning chances.` },
      Resilience: { title: 'The Escape Artist', body: () => `A rare skill: when the engine says you're clearly worse, you still find ${c.defend}% accuracy across ${c.defendMoves} defensive moves. Most players collapse under that pressure — you dig in and make them prove it.` },
      Endgame: { title: 'The Technician', body: () => {
        if (c.endDelta === '—') return `Your games rarely reach an endgame yet, so this score rests on a small sample. When you hold a small edge, consider trading toward the fourth phase.`
        const above = Number(c.endDelta) >= 0
        const diff = Math.abs(Number(c.endDelta)).toFixed(1)
        const convLine = c.conv !== null ? `, and you convert ${c.conv}% of endgame-reaching games into wins` : ''
        return `Your endgame accuracy sits ${diff}% ${above ? 'above' : 'below'} your overall accuracy${convLine}. ${above ? 'Trade into endgames earlier when you have the option.' : 'Start with rook endgames — they are the most common and the most trainable.'}`
      }},
      Opening: { title: 'The Scholar', body: () => `You score ${c.opening}% accuracy in the opening with ${c.book} book moves per game — you know your lines and trust them. The next step: make sure the middlegame doesn't run on autopilot once theory ends.` }
    }
    const t = notes[top.axis]
    return { title: t.title, trait: top.axis, body: t.body(), secondary: top.value - second.value < 15 ? `You also show strong ${second.axis.toLowerCase()} tendencies.` : null }
  })

  const playstyleFormulas = [
    { axis: 'Aggression', formula: 'Checks (×2.2), captures (×0.9), compensated sacrifices (×2.8) and brilliant/great moves (×1.5) per own move.' },
    { axis: 'Tactics', formula: 'Weighted opponent errors induced after your strong moves, plus ≥1.5-pawn eval swings in your favor and centipawns won per move.' },
    { axis: 'Solidity', formula: 'Starts at 100 and subtracts your inaccuracies, mistakes (×2.5), blunders (×5), eval collapses and centipawns lost per own move.' },
    { axis: 'Resilience', formula: 'Average move accuracy while defending positions where you stand ≥1.5 pawns worse. Small samples regress toward 50.' },
    { axis: 'Endgame', formula: 'Endgame accuracy relative to your overall accuracy (move-weighted), blended 65/35 with your win rate in endgame-reaching games.' },
    { axis: 'Opening', formula: 'Move-weighted opening-phase accuracy plus a bonus for book-move frequency, regressed toward 50 on small samples.' }
  ]

  // --- Trend ---
  const RECENT_WINDOW = 5
  const trend = computed(() => {
    const withAcc = insights.value.filter(g => g.insights?.overallAccuracy !== null)
    if (withAcc.length < 4) return null
    const recent = withAcc.slice(0, RECENT_WINDOW)
    const older = withAcc.slice(RECENT_WINDOW)
    if (older.length === 0) return null
    const avg = (arr) => arr.reduce((a, g) => a + g.insights.overallAccuracy, 0) / arr.length
    const delta = avg(recent) - avg(older)
    return { delta: delta.toFixed(1), direction: delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat' }
  })

  // --- Phase Accuracy ---
  const phaseAccuracy = computed(() => {
    const phases = { opening: [], middlegame: [], endgame: [] }
    insights.value.forEach(g => {
      if (g.insights?.phaseAccuracy) {
        if (g.insights.phaseAccuracy.opening !== null) phases.opening.push(g.insights.phaseAccuracy.opening)
        if (g.insights.phaseAccuracy.middlegame !== null) phases.middlegame.push(g.insights.phaseAccuracy.middlegame)
        if (g.insights.phaseAccuracy.endgame !== null) phases.endgame.push(g.insights.phaseAccuracy.endgame)
      }
    })
    const calc = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null
    let oAcc = calc(phases.opening), mAcc = calc(phases.middlegame), eAcc = calc(phases.endgame)
    return {
      opening: { val: oAcc, meta: getAccuracyMeta(oAcc ? parseFloat(oAcc) : null), n: phases.opening.length },
      middlegame: { val: mAcc, meta: getAccuracyMeta(mAcc ? parseFloat(mAcc) : null), n: phases.middlegame.length },
      endgame: { val: eAcc, meta: getAccuracyMeta(eAcc ? parseFloat(eAcc) : null), n: phases.endgame.length }
    }
  })

  // --- Move Counts ---
  const moveCounts = computed(() => {
    const totals = { brilliant: 0, great: 0, best: 0, book: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }
    insights.value.forEach(g => { if (g.insights?.moveCounts) { for (const key in totals) totals[key] += g.insights.moveCounts[key] || 0 } })
    return totals
  })

  const moveCountsWithAvg = computed(() => {
    const totals = { brilliant: 0, great: 0, best: 0, book: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }
    insights.value.forEach(g => { if (g.insights?.moveCounts) { for (const key in totals) totals[key] += g.insights.moveCounts[key] || 0 } })
    const games = totalGames.value || 1
    return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { total: v, avg: v / games }]))
  })

  const moveCountsTotal = computed(() => Object.values(moveCounts.value).reduce((a, b) => a + b, 0))
  const classificationOrder = ['brilliant', 'great', 'best', 'book', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder']

  // --- Classification Meta ---
  const classificationMeta = {
    brilliant: { label: 'Brilliant', color: '#03aea7', icon: '/moveClassifications/brilliant.png' },
    great: { label: 'Great', color: '#4c8cb5', icon: '/moveClassifications/great.png' },
    best: { label: 'Best', color: '#6ad13f', icon: '/moveClassifications/best.png' },
    book: { label: 'Book', color: '#ad8760', icon: '/moveClassifications/book.png' },
    excellent: { label: 'Excellent', color: '#90bc36', icon: '/moveClassifications/excellent.png' },
    good: { label: 'Good', color: '#8eae83', icon: '/moveClassifications/good.png' },
    inaccuracy: { label: 'Inaccuracy', color: '#f2bc43', icon: '/moveClassifications/inaccuracy.png' },
    mistake: { label: 'Mistake', color: '#f38800', icon: '/moveClassifications/mistake.png' },
    blunder: { label: 'Blunder', color: '#FF0000', icon: '/moveClassifications/blunder.png' }
  }

  const moveCountsBarSegments = computed(() => {
    const total = moveCountsTotal.value
    if (!total) return []
    return classificationOrder
      .map(key => ({ key, count: moveCounts.value[key], percent: (moveCounts.value[key] / total) * 100, meta: classificationMeta[key] }))
      .filter(seg => seg.count > 0)
  })

  // --- Heatmap ---
  function generateHeatmapData(type) {
    const squareKey = type === 'bad' ? 'blunderSquares' : 'goodSquares'
    const squares = {}
    let max = 0
    insights.value.forEach(g => {
      if (g.insights?.[squareKey]) {
        for (const sq in g.insights[squareKey]) {
          squares[sq] = (squares[sq] || 0) + g.insights[squareKey][sq]
          if (squares[sq] > max) max = squares[sq]
        }
      }
    })
    return { squares, max }
  }

  function generateBoardData(heatmap) {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const ranks = [8, 7, 6, 5, 4, 3, 2, 1]
    const rows = []
    for (const rank of ranks) {
      const row = []
      for (const file of files) {
        const sq = `${file}${rank}`
        const count = heatmap.squares[sq] || 0
        const intensity = heatmap.max > 0 ? count / heatmap.max : 0
        row.push({ sq, count, intensity })
      }
      rows.push(row)
    }
    return rows
  }

  const badHeatmap = computed(() => generateHeatmapData('bad'))
  const totalBadMoves = computed(() => Object.values(badHeatmap.value.squares).reduce((a, b) => a + b, 0))
  const badBoardSquares = computed(() => generateBoardData(badHeatmap.value))

  const goodHeatmap = computed(() => generateHeatmapData('good'))
  const totalGoodMoves = computed(() => Object.values(goodHeatmap.value.squares).reduce((a, b) => a + b, 0))
  const goodBoardSquares = computed(() => generateBoardData(goodHeatmap.value))

  const selectedSquare = ref(null)
  function tapSquare(sq) {
    selectedSquare.value = selectedSquare.value?.sq === sq.sq ? null : sq
  }

  // Heatmap drill-down: games where this square appears
  const heatmapDrillDown = computed(() => {
    if (!selectedSquare.value) return []
    const sq = selectedSquare.value.sq
    const isBad = badHeatmap.value.squares[sq] > 0
    const key = isBad ? 'blunderSquares' : 'goodSquares'
    return insights.value.filter(g => g.insights?.[key]?.[sq]).map(g => {
      const c = g.insights?.myColor || 'white'
      const opponent = normalizePlayer(c === 'white' ? g.black : g.white)
      const player = normalizePlayer(c === 'white' ? g.white : g.black)
      let outcome = 'draw'
      if (player.result === 'win') outcome = 'win'
      else if (['lose', 'loss', 'checkmated', 'resigned', 'abandoned'].includes(player.result)) outcome = 'loss'
      return { id: g.id, opponent: opponent.username, outcome, accuracy: g.insights?.overallAccuracy?.toFixed(1) || '—', count: g.insights[key][sq] }
    })
  })

  // --- Openings ---
  const allOpenings = computed(() => {
    const counts = {}
    insights.value.forEach(g => {
      const name = g.insights?.opening && g.insights.opening !== "Unknown Opening" ? g.insights.opening : "Unrecognized Opening"
      if (!counts[name]) counts[name] = { name, count: 0, accuracy: [], win: 0, loss: 0, draw: 0, asWhite: { count: 0, win: 0, loss: 0, draw: 0 }, asBlack: { count: 0, win: 0, loss: 0, draw: 0 }, games: [] }
      const o = counts[name]
      o.count++
      if (g.insights?.overallAccuracy !== null) o.accuracy.push(g.insights.overallAccuracy)
      const c = g.insights?.myColor || 'white'
      const player = normalizePlayer(c === 'white' ? g.white : g.black)
      const opponent = normalizePlayer(c === 'white' ? g.black : g.white)
      let outcome = 'draw'
      if (player.result === 'win') outcome = 'win'
      else if (['lose', 'loss', 'checkmated', 'resigned', 'abandoned'].includes(player.result)) outcome = 'loss'
      o[outcome]++
      const colorKey = c === 'white' ? 'asWhite' : 'asBlack'
      o[colorKey].count++
      o[colorKey][outcome]++
      o.games.push({ id: g.id, opponent: opponent.username, outcome, accuracy: g.insights?.overallAccuracy?.toFixed(1) || '—', myColor: c })
    })
    return Object.values(counts)
      .map(o => ({
        ...o,
        avgAccuracy: o.accuracy.length ? (o.accuracy.reduce((a, b) => a + b, 0) / o.accuracy.length).toFixed(1) : null,
        meta: o.accuracy.length ? getAccuracyMeta(o.accuracy.reduce((a, b) => a + b, 0) / o.accuracy.length) : getAccuracyMeta(null)
      }))
      .sort((a, b) => b.count - a.count)
  })

  const worstOpening = computed(() => {
    const candidates = allOpenings.value.filter(o => o.count >= 5 && o.avgAccuracy !== null)
    if (candidates.length === 0) return null
    return candidates.reduce((worst, o) => parseFloat(o.avgAccuracy) < parseFloat(worst.avgAccuracy) ? o : worst)
  })

  const expandedOpening = ref(null)
  function toggleOpening(name) {
    expandedOpening.value = expandedOpening.value === name ? null : name
  }

  // --- Tab gating ---
  function setTab(tab) { activeTab.value = tab }
</script>

<template>
  <div class="page-layout">
    <Title />
    <div class="content-area">
      <div class="insights-card">
        <div class="card-header">
          <h1 class="insights-title">Your Insights</h1>
          <p class="insights-subtitle">Track your progress, find your weaknesses, and improve your game.</p>
        </div>

        <div v-if="loading" class="empty-state">
          <div class="loading-spinner"><div class="spinner-ring"></div><div class="spinner-ring"></div><div class="spinner-ring"></div></div>
          <p>Crunching the numbers...</p>
        </div>
        <div v-else-if="!currentUser" class="empty-state"><p>Please log in to view your insights.</p></div>
        <div v-else-if="insights.length === 0" class="empty-state"><p>No data yet. Analyze a game from your library to start building your insights!</p></div>

        <div v-else class="dashboard-layout">
          <div class="tab-nav-wrapper">
            <div class="tab-nav">
              <button class="tab-btn" :class="{ active: activeTab === 'overview' }" @click="setTab('overview')">Overview</button>
              <button class="tab-btn" :class="{ active: activeTab === 'moves' }" @click="setTab('moves')">Move Classes</button>
              <button class="tab-btn" :class="{ active: activeTab === 'colors' }" @click="setTab('colors')">Colors</button>
              <button class="tab-btn" :class="{ active: activeTab === 'pieces' }" @click="setTab('pieces')">Pieces</button>
              <button class="tab-btn" :class="{ active: activeTab === 'openings' }" @click="setTab('openings')">Openings</button>
              <button class="tab-btn" :class="{ active: activeTab === 'stamina' }" @click="setTab('stamina')">Stamina</button>
              <button class="tab-btn" :class="{ active: activeTab === 'playstyle' }" @click="setTab('playstyle')">Playstyle</button>
              <button class="tab-btn" :class="{ active: activeTab === 'heatmap' }" @click="setTab('heatmap')">Heatmap</button>
            </div>
          </div>

          <!-- Premium upsell banner -->

          <div class="tab-content-area">
            <div class="tab-panel">

              <!-- OVERVIEW TAB -->
              <template v-if="activeTab === 'overview'">
                <div class="hero-card">
                  <div class="hero-main">
                    <span class="stat-label">Overall Accuracy</span>
                    <div class="hero-acc-row">
                      <img v-if="overallMeta.icon" :src="overallMeta.icon" class="hero-icon" alt="" />
                      <span class="hero-value" :style="{ color: overallMeta.color }">{{ overallAccuracy !== null ? overallAccuracy + '%' : '—' }}</span>
                    </div>
                    <div v-if="trend" class="trend-pill" :class="trend.direction">
                      <span v-if="trend.direction === 'up'">▲</span>
                      <span v-else-if="trend.direction === 'down'">▼</span>
                      <span v-else>◆</span>
                      {{ Math.abs(trend.delta) }}% vs. earlier games
                    </div>
                  </div>
                  <div class="hero-divider"></div>
                  <div class="hero-secondary">
                    <div class="hero-stat"><span class="stat-label">Games</span><span class="hero-sub-value">{{ totalGames }}</span></div>
                    <div class="hero-stat"><span class="stat-label">Moves</span><span class="hero-sub-value">{{ totalMoves }}</span></div>
                    <div class="hero-stat"><span class="stat-label">Blunders</span><span class="hero-sub-value" style="color: #ff8a80;">{{ moveCounts.blunder + moveCounts.mistake }}</span></div>
                  </div>
                </div>

                <!-- Sparkline -->
                <div v-if="sparklineData" class="sparkline-card">
                  <span class="stat-label">Accuracy Trend</span>
                  <svg :viewBox="`0 0 ${sparklineData.width} ${sparklineData.height}`" class="sparkline-svg">
                    <polyline :points="sparklineData.points" fill="none" stroke="#6ad13f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  <span class="sparkline-last">Latest: {{ sparklineData.lastAcc }}%</span>
                </div>

                <!-- Coach Digest -->
                <div v-if="coachDigest" class="coach-digest">
                  <h3 class="digest-title">📋 Coach Notes</h3>
                  <ul class="digest-list">
                    <li v-for="(line, i) in coachDigest" :key="i">{{ line }}</li>
                  </ul>
                </div>

                <!-- Recent Games -->
                <div v-if="recentGames.length" class="recent-games">
                  <h3 class="section-title">Recent Games</h3>
                  <div class="recent-list">
                    <div v-for="rg in recentGames" :key="rg.id" class="recent-row">
                      <span class="recent-dot" :class="rg.outcome"></span>
                      <span class="recent-opp">vs {{ rg.opponent }}</span>
                      <span class="recent-opening">{{ rg.opening }}</span>
                      <span class="recent-acc" :style="{ color: rg.accMeta.color }">{{ rg.accuracy }}%</span>
                    </div>
                  </div>
                </div>

                <!-- Phase Accuracy -->
                <div class="phase-grid">
                  <div class="phase-box" v-for="(phase, key) in phaseAccuracy" :key="key">
                    <div class="phase-header">
                      <span class="phase-name">{{ key.charAt(0).toUpperCase() + key.slice(1) }}</span>
                      <img v-if="phase.meta.icon" :src="phase.meta.icon" class="phase-icon-img" alt="" />
                    </div>
                    <div class="phase-bar-container">
                      <div class="phase-bar" :style="{ width: (phase.val || 0) + '%', background: `linear-gradient(90deg, ${phase.meta.color}aa, ${phase.meta.color})` }"></div>
                    </div>
                    <div class="phase-footer">
                      <span class="phase-n">{{ phase.n }} game{{ phase.n === 1 ? '' : 's' }}</span>
                      <span class="phase-val" :style="{ color: phase.meta.color }">{{ phase.val !== null ? phase.val + '%' : '—' }}</span>
                    </div>
                  </div>
                </div>

                <!-- Move-Number Buckets -->
                <div v-if="hasMoveBuckets" class="bucket-section">
                  <h3 class="section-title">Accuracy by Move Number</h3>
                  <div class="bucket-grid">
                    <div v-for="b in moveBucketData" :key="b.label" class="bucket-card" :class="{ empty: !b.avgAcc }">
                      <span class="bucket-label">{{ b.label }}</span>
                      <span class="bucket-val" :style="{ color: b.meta.color }">{{ b.avgAcc ? b.avgAcc + '%' : '—' }}</span>
                      <span class="bucket-n">{{ b.count }} moves</span>
                    </div>
                  </div>
                </div>
              </template>

              <!-- MOVE CLASSES TAB -->
              <template v-if="activeTab === 'moves'">
                <div class="move-bar-container" v-if="moveCountsBarSegments.length">
                  <div class="move-bar">
                    <div v-for="seg in moveCountsBarSegments" :key="seg.key" class="move-bar-segment" :style="{ width: seg.percent + '%', background: seg.meta.color }" :title="`${seg.meta.label}: ${seg.count} (${seg.percent.toFixed(1)}%)`"></div>
                  </div>
                  <div class="move-bar-caption">
                    <span>Total moves: <strong>{{ moveCountsTotal }}</strong></span>
                    <span>Across <strong>{{ totalGames }}</strong> games</span>
                  </div>
                </div>
                <div class="move-classes-grid">
                  <div v-for="(meta, key) in classificationMeta" :key="key" class="move-class-box">
                    <img :src="meta.icon" class="mc-icon-img" :alt="meta.label" />
                    <span class="mc-label" :style="{ color: meta.color }">{{ meta.label }}</span>
                    <div class="mc-numbers">
                      <span class="mc-count">{{ moveCountsWithAvg[key].total }}</span>
                      <span class="mc-percent" v-if="moveCountsTotal">{{ ((moveCounts[key] / moveCountsTotal) * 100).toFixed(1) }}% of moves</span>
                      <span class="mc-avg">{{ moveCountsWithAvg[key].avg.toFixed(2) }} / game</span>
                    </div>
                  </div>
                </div>
              </template>

              <!-- COLORS TAB -->
              <template v-if="activeTab === 'colors'">
                <div class="colors-grid">
                  <div v-for="side in ['white', 'black']" :key="side" class="color-card" :class="side + '-card'">
                    <div class="color-header">
                      <span class="color-swatch" :class="side"></span>
                      <h3 class="color-title">Playing as {{ side.charAt(0).toUpperCase() + side.slice(1) }}</h3>
                    </div>
                    <div class="color-body">
                      <div class="color-stat"><span class="stat-label">Games</span><span class="color-val">{{ colorPerformance[side].games }}</span></div>
                      <div class="color-stat"><span class="stat-label">Avg Accuracy</span><span class="color-val" :style="{ color: colorPerformance[side].avgAcc ? getAccuracyMeta(parseFloat(colorPerformance[side].avgAcc)).color : '#fff' }">{{ colorPerformance[side].avgAcc ? colorPerformance[side].avgAcc + '%' : '—' }}</span></div>
                      <div class="color-stat"><span class="stat-label">Blunders</span><span class="color-val" style="color: #ff8a80;">{{ colorPerformance[side].blunders }}</span></div>
                      <div class="wld-bar">
                        <div class="wld-segment win" :style="{ width: (colorPerformance[side].games > 0 ? (colorPerformance[side].win / colorPerformance[side].games) * 100 : 0) + '%' }"></div>
                        <div class="wld-segment draw" :style="{ width: (colorPerformance[side].games > 0 ? (colorPerformance[side].draw / colorPerformance[side].games) * 100 : 0) + '%' }"></div>
                        <div class="wld-segment loss" :style="{ width: (colorPerformance[side].games > 0 ? (colorPerformance[side].loss / colorPerformance[side].games) * 100 : 0) + '%' }"></div>
                      </div>
                      <div class="wld-legend">
                        <span><span class="dot win"></span> Win ({{ colorPerformance[side].win }})</span>
                        <span><span class="dot draw"></span> Draw ({{ colorPerformance[side].draw }})</span>
                        <span><span class="dot loss"></span> Loss ({{ colorPerformance[side].loss }})</span>
                      </div>
                    </div>
                  </div>
                </div>
              </template>

              <!-- PIECES TAB -->
              <template v-if="activeTab === 'pieces'">
                <div class="pieces-grid">
                  <div v-for="p in pieceData" :key="p.key" class="piece-card">
                    <div class="piece-header">
                      <span class="piece-symbol" :style="{ color: p.color }">{{ p.symbol }}</span>
                      <span class="piece-name">{{ p.label }}</span>
                    </div>
                    <div class="piece-stats">
                      <div class="piece-stat"><span class="stat-label">Moves</span><span class="piece-val">{{ p.count }} ({{ p.movePercent }}%)</span></div>
                      <div class="piece-stat">
                        <span class="stat-label">Avg Accuracy</span>
                        <div class="piece-acc-row">
                          <img v-if="p.meta.icon" :src="p.meta.icon" class="piece-icon" alt="" />
                          <span class="piece-val" :style="{ color: p.meta.color }">{{ p.avgAcc !== null ? p.avgAcc + '%' : '—' }}</span>
                        </div>
                      </div>
                    </div>
                    <div class="piece-bar-container">
                      <div class="piece-bar" :style="{ width: (p.avgAcc || 0) + '%', background: `linear-gradient(90deg, ${p.meta.color}aa, ${p.meta.color})` }"></div>
                    </div>
                  </div>
                </div>
              </template>

              <!-- OPENINGS TAB -->
              <template v-if="activeTab === 'openings'">
                <div v-if="worstOpening" class="worst-opening-callout">
                  <span class="callout-icon">⚠️</span>
                  <span>Your weakest opening with 5+ games: <strong>{{ worstOpening.name }}</strong> ({{ worstOpening.avgAccuracy }}% accuracy, {{ worstOpening.count }} games)</span>
                </div>
                <div class="openings-list">
                  <div v-for="(opening, i) in allOpenings" :key="i" class="opening-block">
                    <div class="opening-row" @click="toggleOpening(opening.name)">
                      <span class="opening-rank">#{{ i + 1 }}</span>
                      <span class="opening-name">{{ opening.name }}</span>
                      <span class="opening-games">{{ opening.count }} games</span>
                      <div class="opening-acc-container" v-if="opening.avgAccuracy">
                        <img :src="opening.meta.icon" class="opening-acc-icon" alt="" />
                        <span class="opening-acc" :style="{ color: opening.meta.color }">{{ opening.avgAccuracy }}%</span>
                      </div>
                      <span class="expand-arrow" :class="{ open: expandedOpening === opening.name }">▾</span>
                    </div>
                    <!-- Expanded detail -->
                    <div v-if="expandedOpening === opening.name" class="opening-detail">
                      <div class="opening-wld-row">
                        <div class="wld-mini">
                          <span class="wld-mini-label">Overall</span>
                          <span class="wld-mini-vals"><span class="w">W {{ opening.win }}</span> <span class="d">D {{ opening.draw }}</span> <span class="l">L {{ opening.loss }}</span></span>
                        </div>
                        <div class="wld-mini">
                          <span class="wld-mini-label">As White</span>
                          <span class="wld-mini-vals"><span class="w">W {{ opening.asWhite.win }}</span> <span class="d">D {{ opening.asWhite.draw }}</span> <span class="l">L {{ opening.asWhite.loss }}</span></span>
                        </div>
                        <div class="wld-mini">
                          <span class="wld-mini-label">As Black</span>
                          <span class="wld-mini-vals"><span class="w">W {{ opening.asBlack.win }}</span> <span class="d">D {{ opening.asBlack.draw }}</span> <span class="l">L {{ opening.asBlack.loss }}</span></span>
                        </div>
                      </div>
                      <div class="opening-games-list">
                        <div v-for="og in opening.games" :key="og.id" class="opening-game-row">
                          <span class="recent-dot" :class="og.outcome"></span>
                          <span class="og-opp">vs {{ og.opponent }}</span>
                          <span class="og-color">{{ og.myColor === 'white' ? '⚪' : '⚫' }}</span>
                          <span class="og-acc">{{ og.accuracy }}%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </template>

              <!-- STAMINA TAB -->
              <template v-if="activeTab === 'stamina'">
                <div class="stamina-grid">
                  <div v-for="bucket in gameLengthStats" :key="bucket.label" class="stamina-card">
                    <h3 class="stamina-title">{{ bucket.label }}</h3>
                    <span class="stamina-games">{{ bucket.games }} Games</span>
                    <div class="wld-bar stamina-wld">
                      <div class="wld-segment win" :style="{ width: (bucket.games > 0 ? (bucket.win / bucket.games) * 100 : 0) + '%' }"></div>
                      <div class="wld-segment draw" :style="{ width: (bucket.games > 0 ? (bucket.draw / bucket.games) * 100 : 0) + '%' }"></div>
                      <div class="wld-segment loss" :style="{ width: (bucket.games > 0 ? (bucket.loss / bucket.games) * 100 : 0) + '%' }"></div>
                    </div>
                    <div class="wld-legend">
                      <span><span class="dot win"></span> {{ bucket.win }}</span>
                      <span><span class="dot draw"></span> {{ bucket.draw }}</span>
                      <span><span class="dot loss"></span> {{ bucket.loss }}</span>
                    </div>
                    <div class="stamina-stat"><span class="stat-label">Avg Accuracy</span><span class="stamina-val" :style="{ color: bucket.avgAcc ? getAccuracyMeta(parseFloat(bucket.avgAcc)).color : '#fff' }">{{ bucket.avgAcc ? bucket.avgAcc + '%' : '—' }}</span></div>
                    <div class="stamina-stat"><span class="stat-label">Blunders</span><span class="stamina-val" style="color: #ff8a80;">{{ bucket.blunders }}</span></div>
                  </div>
                </div>
              </template>

              <!-- PLAYSTYLE TAB -->
              <template v-if="activeTab === 'playstyle'">
                <div class="playstyle-panel" v-if="playstyleData">
                  <p class="panel-meta" v-if="playstyleAgg">Based on {{ playstyleAgg.games }} analyzed game{{ playstyleAgg.games === 1 ? '' : 's' }} · {{ playstyleAgg.myMoves }} of your moves</p>
                  <div class="radar-container">
                    <svg viewBox="0 0 200 200" class="radar-svg">
                      <polygon v-for="(points, i) in radarGrid" :key="i" :points="points" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1" />
                      <polygon v-if="radarPoints" :points="radarPoints" fill="rgba(106, 209, 63, 0.2)" stroke="#6ad13f" stroke-width="2" />
                      <text v-for="label in radarLabels" :key="label.label" :x="label.x" :y="label.y" text-anchor="middle" dominant-baseline="middle" class="radar-label">{{ label.label }}</text>
                    </svg>
                  </div>
                  <div class="playstyle-traits">
                    <div v-for="d in playstyleData" :key="d.axis" class="trait-row">
                      <span class="trait-name">{{ d.axis }}</span>
                      <div class="trait-bar-container"><div class="trait-bar" :style="{ width: d.value + '%' }"></div></div>
                      <span class="trait-val">{{ d.value.toFixed(0) }}</span>
                    </div>
                  </div>
                  <div class="playstyle-note" v-if="playstyleNote">
                    <div class="playstyle-note-header">
                      <span class="playstyle-archetype">{{ playstyleNote.title }}</span>
                      <span class="playstyle-trait-tag">Strongest trait: {{ playstyleNote.trait }}</span>
                    </div>
                    <p class="playstyle-note-body">{{ playstyleNote.body }}</p>
                    <p class="playstyle-note-secondary" v-if="playstyleNote.secondary">{{ playstyleNote.secondary }}</p>
                  </div>
                  <div class="playstyle-formulas">
                    <h4 class="formulas-title">How each trait is calculated</h4>
                    <div v-for="f in playstyleFormulas" :key="f.axis" class="formula-row">
                      <span class="formula-axis">{{ f.axis }}</span>
                      <span class="formula-text">{{ f.formula }}</span>
                    </div>
                    <p class="formulas-disclaimer">Note: each axis is normalized independently on a 0–100 intensity scale, so the values intentionally do <strong>not</strong> sum to 100.</p>
                    <p class="formulas-disclaimer" v-if="legacyPlaystyleGames > 0">{{ legacyPlaystyleGames }} game{{ legacyPlaystyleGames === 1 ? '' : 's' }} analyzed before this update use the legacy playstyle profile and aren't included above.</p>
                  </div>
                </div>
                <div v-else class="panel-empty">
                  <p v-if="legacyPlaystyleGames > 0">Your {{ legacyPlaystyleGames }} saved game{{ legacyPlaystyleGames === 1 ? '' : 's' }} predate the current playstyle engine. Re-analyze them from your library to build a full profile.</p>
                  <p v-else>Not enough data to generate a playstyle profile yet. Analyze a few more games!</p>
                </div>
              </template>

              <!-- HEATMAP TAB -->
              <template v-if="activeTab === 'heatmap'">
                <div class="heatmap-panel">
                  <div class="heatmap-boards-container">
                    <div class="heatmap-instance">
                      <div class="heatmap-header">
                        <h3 class="section-subtitle bad-color">Mistakes & Blunders</h3>
                        <span class="heatmap-total">{{ totalBadMoves }} mapped</span>
                      </div>
                      <div class="heatmap-board-wrapper">
                        <div class="heatmap-board">
                          <div class="heatmap-rank-labels" aria-hidden="true"><span v-for="r in 8" :key="r">{{ 9 - r }}</span></div>
                          <div class="heatmap-grid-area">
                            <div class="heatmap-row" v-for="row in badBoardSquares" :key="row[0].sq[1]">
                              <button v-for="sq in row" :key="sq.sq" type="button" class="heatmap-square bad"
                                :class="{ light: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 === 0, dark: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 !== 0, active: sq.intensity > 0, selected: selectedSquare?.sq === sq.sq }"
                                :style="{ '--intensity': sq.intensity }" :title="`${sq.sq}: ${sq.count} mistake${sq.count === 1 ? '' : 's'}`" @click="tapSquare(sq)">
                                <span v-if="sq.count > 0" class="sq-count">{{ sq.count }}</span>
                              </button>
                            </div>
                            <div class="heatmap-file-labels" aria-hidden="true"><span v-for="f in ['a','b','c','d','e','f','g','h']" :key="f">{{ f }}</span></div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="heatmap-instance">
                      <div class="heatmap-header">
                        <h3 class="section-subtitle good-color">Strong Moves</h3>
                        <span class="heatmap-total">{{ totalGoodMoves }} mapped</span>
                      </div>
                      <div class="heatmap-board-wrapper">
                        <div class="heatmap-board">
                          <div class="heatmap-rank-labels" aria-hidden="true"><span v-for="r in 8" :key="r">{{ 9 - r }}</span></div>
                          <div class="heatmap-grid-area">
                            <div class="heatmap-row" v-for="row in goodBoardSquares" :key="row[0].sq[1]">
                              <button v-for="sq in row" :key="sq.sq" type="button" class="heatmap-square good"
                                :class="{ light: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 === 0, dark: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 !== 0, active: sq.intensity > 0, selected: selectedSquare?.sq === sq.sq }"
                                :style="{ '--intensity': sq.intensity }" :title="`${sq.sq}: ${sq.count} strong move${sq.count === 1 ? '' : 's'}`" @click="tapSquare(sq)">
                                <span v-if="sq.count > 0" class="sq-count">{{ sq.count }}</span>
                              </button>
                            </div>
                            <div class="heatmap-file-labels" aria-hidden="true"><span v-for="f in ['a','b','c','d','e','f','g','h']" :key="f">{{ f }}</span></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- Drill-down -->
                  <div v-if="selectedSquare" class="heatmap-drilldown">
                    <h4 class="drilldown-title">{{ selectedSquare.sq }} — {{ selectedSquare.count }} move{{ selectedSquare.count === 1 ? '' : 's' }}</h4>
                    <div v-if="heatmapDrillDown.length" class="drilldown-games">
                      <div v-for="dg in heatmapDrillDown" :key="dg.id" class="drilldown-row">
                        <span class="recent-dot" :class="dg.outcome"></span>
                        <span class="dg-opp">vs {{ dg.opponent }}</span>
                        <span class="dg-count">{{ dg.count }}× on {{ selectedSquare.sq }}</span>
                        <span class="dg-acc">{{ dg.accuracy }}%</span>
                      </div>
                    </div>
                    <p v-else class="drilldown-empty">No game-level detail available for this square.</p>
                  </div>
                  <p v-else class="heatmap-info">Tap a square to see which games it appeared in.</p>
                </div>
              </template>

            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');

/* Dynamic Board Variables (falls back smoothly if unprovided by global theme) */
:root {
  --board-light: #f0d9b5;
  --board-dark: #b58863;
  --panel-1: #262421;
  --panel-2: #1e1c18;
  --btn-active: #363431;
  --text-highlight: #d9b382;
}

.page-layout {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  padding: clamp(0.5rem, 3vw, 1rem);
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.25rem;
  justify-self: center;
  min-width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

@media (min-width: 768px) {
  .page-layout {
    grid-template-columns: auto 1fr;
    gap: 1.5rem;
  }
}

.content-area {
  display: flex;
  justify-content: stretch;
  width: 100%;
  min-width: 0;
}

.insights-card {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: clamp(1.5rem, 3vw, 2.5rem);
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  background: linear-gradient(145deg, var(--panel-1, #262421), var(--panel-2, #1e1c18));
  box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  height: calc(100vh - 2rem);
  max-height: 900px;
  overflow: hidden;
}

.card-header {
  text-align: center;
  flex-shrink: 0;
}

.insights-title {
  font-family: 'Cormorant Garamond', serif;
  color: #f5f5dc;
  font-weight: 700;
  text-transform: uppercase;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
  letter-spacing: 2px;
  font-size: clamp(1.5rem, 3vw, 2rem);
  margin: 0 0 0.4rem;
}

.insights-subtitle {
  color: rgba(244, 240, 227, 0.72);
  font-size: 0.95rem;
  margin: 0;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 1rem;
  color: rgba(244, 240, 227, 0.6);
  font-size: 1rem;
  text-align: center;
}

.panel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: rgba(244, 240, 227, 0.55);
  font-size: 0.9rem;
  background: rgba(0, 0, 0, 0.15);
  border: 1px dashed rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 2.5rem 1.5rem;
  max-width: 420px;
  margin: 0 auto;
}

.loading-spinner {
  position: relative;
  width: 56px;
  height: 56px;
}

.spinner-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 3px solid transparent;
  border-top-color: var(--text-highlight, #d9b382);
  animation: spinRing 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
}

.spinner-ring:nth-child(2) {
  inset: 7px;
  border-top-color: #a8d97a;
  animation-duration: 1.6s;
  animation-direction: reverse;
}

.spinner-ring:nth-child(3) {
  inset: 14px;
  border-top-color: #f4f0e3;
  animation-duration: 2s;
}

@keyframes spinRing {
  to {
    transform: rotate(360deg);
  }
}

.dashboard-layout {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  flex: 1;
  min-height: 0;
}

.tab-nav-wrapper {
  flex-shrink: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab-nav-wrapper::-webkit-scrollbar {
  display: none;
}

.tab-nav {
  display: inline-flex;
  min-width: 100%;
  gap: 0.5rem;
  background: rgba(0, 0, 0, 0.2);
  padding: 0.4rem;
  border-radius: 12px;
}

.tab-btn {
  padding: 0.6rem 1.2rem;
  background: transparent;
  border: none;
  color: rgba(244, 240, 227, 0.6);
  font-weight: 600;
  font-size: 0.9rem;
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.2s ease;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.tab-btn:hover {
  color: #f4f0e3;
}

.tab-btn.active {
  background: var(--btn-active, rgba(255, 255, 255, 0.1));
  color: #f5f5dc;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35);
}

.premium-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.7rem 1rem;
  background: linear-gradient(135deg, rgba(217, 179, 130, 0.12), rgba(106, 209, 63, 0.08));
  border: 1px solid rgba(217, 179, 130, 0.3);
  border-radius: 10px;
  font-size: 0.85rem;
  color: rgba(244, 240, 227, 0.85);
  flex-shrink: 0;
}

.upgrade-btn {
  padding: 0.4rem 1rem;
  border-radius: 8px;
  border: none;
  background: var(--text-highlight, #d9b382);
  color: #15130d;
  font-weight: 700;
  font-size: 0.82rem;
  cursor: pointer;
  white-space: nowrap;
}

.tab-content-area {
  flex: 1;
  overflow-y: auto;
  padding-right: 0.5rem;
  scrollbar-width: thin;
  scrollbar-color: rgba(194, 197, 170, 0.4) transparent;
}

.tab-panel {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  animation: fadeIn 0.3s ease;
  max-width: 760px;
  margin: 0 auto;
  width: 100%;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(5px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Hero */
.hero-card {
  display: flex;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 16px;
  padding: 1.5rem;
  gap: 1.5rem;
  align-items: center;
  justify-content: space-between;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.hero-main {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.hero-acc-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.hero-icon {
  width: 36px;
  height: 36px;
}

.hero-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 2.4rem;
  font-weight: 700;
}

.hero-divider {
  width: 1px;
  height: 60px;
  background: rgba(255, 255, 255, 0.1);
}

.hero-secondary {
  display: flex;
  gap: 2rem;
}

.hero-stat {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  text-align: center;
}

.hero-sub-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.4rem;
  font-weight: 700;
  color: #f5f5dc;
}

.trend-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.25);
  width: fit-content;
}

.trend-pill.up {
  color: #8fd97a;
}

.trend-pill.down {
  color: #ff8a80;
}

.trend-pill.flat {
  color: rgba(244, 240, 227, 0.6);
}

.stat-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: rgba(244, 240, 227, 0.6);
}

/* Sparkline */
.sparkline-card {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.sparkline-svg {
  width: 100%;
  height: 50px;
}

.sparkline-last {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.78rem;
  color: rgba(244, 240, 227, 0.6);
  text-align: right;
}

/* Coach Digest */
.coach-digest {
  background: linear-gradient(135deg, rgba(106, 209, 63, 0.06), rgba(217, 179, 130, 0.04));
  border: 1px solid rgba(217, 179, 130, 0.2);
  border-radius: 14px;
  padding: 1.25rem 1.4rem;
}

.digest-title {
  font-family: 'Cormorant Garamond', serif;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-highlight, #d9b382);
  margin: 0 0 0.75rem;
}

.digest-list {
  margin: 0;
  padding-left: 1.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.digest-list li {
  font-size: 0.88rem;
  line-height: 1.5;
  color: rgba(244, 240, 227, 0.85);
}

/* Recent Games */
.section-title {
  font-family: 'Cormorant Garamond', serif;
  font-size: 1.1rem;
  font-weight: 700;
  color: #f5f5dc;
  margin: 0 0 0.75rem;
}

.recent-games {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 1.25rem;
}

.recent-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.recent-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.6rem;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.15);
  font-size: 0.85rem;
}

.recent-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.recent-dot.win {
  background: #8fd97a;
}

.recent-dot.loss {
  background: #ff8a80;
}

.recent-dot.draw {
  background: #d9b36a;
}

.recent-opp {
  font-weight: 600;
  color: #f5f5dc;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-opening {
  color: rgba(244, 240, 227, 0.5);
  font-size: 0.78rem;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-acc {
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  font-size: 0.85rem;
}

/* Phase */
.phase-grid {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.phase-box {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.phase-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.phase-name {
  font-size: 1.1rem;
  font-weight: 600;
  color: rgba(244, 240, 227, 0.9);
  text-transform: capitalize;
}

.phase-icon-img {
  width: 32px;
  height: 32px;
}

.phase-bar-container {
  height: 12px;
  background: rgba(0, 0, 0, 0.4);
  border-radius: 6px;
  overflow: hidden;
}

.phase-bar {
  height: 100%;
  border-radius: 6px;
  transition: width 0.5s ease;
}

.phase-footer {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.phase-n {
  font-size: 0.75rem;
  color: rgba(244, 240, 227, 0.5);
}

.phase-val {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.4rem;
  font-weight: 700;
}

/* Move Buckets */
.bucket-section {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 1.25rem;
}

.bucket-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 0.75rem;
}

.bucket-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.75rem 0.5rem;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.15);
}

.bucket-card.empty {
  opacity: 0.4;
}

.bucket-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  color: rgba(244, 240, 227, 0.5);
}

.bucket-val {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.2rem;
  font-weight: 700;
}

.bucket-n {
  font-size: 0.68rem;
  color: rgba(244, 240, 227, 0.4);
}

/* Move Classes */
.move-bar-container {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 1rem;
}

.move-bar {
  display: flex;
  width: 100%;
  height: 1.8rem;
  border-radius: 8px;
  overflow: hidden;
}

.move-bar-segment {
  height: 100%;
  transition: width 0.5s ease;
}

.move-bar-caption {
  display: flex;
  justify-content: space-between;
  font-size: 0.78rem;
  color: rgba(244, 240, 227, 0.6);
  margin-top: 0.6rem;
  font-family: "JetBrains Mono", monospace;
}

.move-bar-caption strong {
  color: #f4f0e3;
}

.move-classes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
}

.move-class-box {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 1.5rem 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  transition: transform 0.2s;
}

.move-class-box:hover {
  transform: translateY(-2px);
}

.mc-icon-img {
  width: 36px;
  height: 36px;
}

.mc-label {
  font-size: 0.8rem;
  font-weight: 600;
}

.mc-numbers {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  margin-top: 0.2rem;
}

.mc-count {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.5rem;
  font-weight: 700;
  color: #f5f5dc;
}

.mc-percent {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.72rem;
  color: rgba(244, 240, 227, 0.5);
}

.mc-avg {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.72rem;
  color: var(--text-highlight, #d9b382);
  font-weight: 600;
}

/* Colors */
.colors-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

@media (max-width: 600px) {
  .colors-grid {
    grid-template-columns: 1fr;
  }
}

.color-card {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 16px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.color-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.color-swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
}

.color-swatch.white {
  background: #f4f0e3;
}

.color-swatch.black {
  background: #1a1a1a;
  border: 1px solid #333;
}

.color-title {
  font-family: 'Cormorant Garamond', serif;
  color: #f5f5dc;
  font-size: 1.2rem;
  font-weight: 600;
  margin: 0;
}

.color-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.color-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.color-val {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.2rem;
  font-weight: 700;
  color: #f5f5dc;
}

.wld-bar {
  display: flex;
  width: 100%;
  height: 10px;
  border-radius: 5px;
  overflow: hidden;
  margin-top: 0.5rem;
  background: rgba(0, 0, 0, 0.3);
}

.wld-segment {
  height: 100%;
  transition: width 0.5s ease;
}

.wld-segment.win {
  background: #8fd97a;
}

.wld-segment.draw {
  background: #d9b36a;
}

.wld-segment.loss {
  background: #ff8a80;
}

.wld-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: rgba(244, 240, 227, 0.6);
  margin-top: 0.5rem;
}

.wld-legend .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}

.wld-legend .dot.win {
  background: #8fd97a;
}

.wld-legend .dot.draw {
  background: #d9b36a;
}

.wld-legend .dot.loss {
  background: #ff8a80;
}

/* Pieces */
.pieces-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1.5rem;
}

.piece-card {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 16px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border: 1px solid rgba(255, 255, 255, 0.05);
  transition: transform 0.2s;
}

.piece-card:hover {
  transform: translateY(-2px);
}

.piece-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.piece-symbol {
  font-size: 2.5rem;
  line-height: 1;
}

.piece-name {
  font-family: 'Cormorant Garamond', serif;
  color: #f5f5dc;
  font-size: 1.1rem;
  font-weight: 600;
}

.piece-stats {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.piece-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.piece-acc-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.piece-icon {
  width: 20px;
  height: 20px;
}

.piece-val {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.1rem;
  font-weight: 700;
  color: #f5f5dc;
}

.piece-bar-container {
  height: 8px;
  background: rgba(0, 0, 0, 0.4);
  border-radius: 4px;
  overflow: hidden;
  margin-top: auto;
}

.piece-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.5s ease;
}

/* Openings */
.worst-opening-callout {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.8rem 1rem;
  background: rgba(255, 60, 60, 0.08);
  border: 1px solid rgba(255, 100, 90, 0.25);
  border-radius: 10px;
  font-size: 0.85rem;
  color: rgba(244, 240, 227, 0.85);
  margin-bottom: 0.5rem;
}

.callout-icon {
  font-size: 1.1rem;
}

.openings-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.opening-block {
  border-radius: 10px;
  overflow: hidden;
}

.opening-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid transparent;
  transition: border-color 0.2s;
  cursor: pointer;
}

.opening-row:hover {
  border-color: rgba(255, 255, 255, 0.1);
}

.opening-rank {
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  color: rgba(244, 240, 227, 0.4);
  font-size: 0.9rem;
  width: 30px;
}

.opening-name {
  flex: 1;
  font-weight: 600;
  color: #f5f5dc;
  font-size: 0.95rem;
  word-break: break-word;
}

.opening-games {
  font-family: "JetBrains Mono", monospace;
  color: rgba(244, 240, 227, 0.5);
  font-size: 0.85rem;
  white-space: nowrap;
}

.opening-acc-container {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: rgba(255, 255, 255, 0.05);
  padding: 0.3rem 0.6rem;
  border-radius: 8px;
  flex-shrink: 0;
}

.opening-acc-icon {
  width: 20px;
  height: 20px;
}

.opening-acc {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.9rem;
  font-weight: 700;
}

.expand-arrow {
  color: rgba(244, 240, 227, 0.4);
  transition: transform 0.2s;
  font-size: 0.8rem;
}

.expand-arrow.open {
  transform: rotate(180deg);
}

.opening-detail {
  padding: 1rem 1.5rem;
  background: rgba(0, 0, 0, 0.12);
  border-radius: 0 0 10px 10px;
}

.opening-wld-row {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.wld-mini {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.wld-mini-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: rgba(244, 240, 227, 0.5);
  font-weight: 600;
}

.wld-mini-vals {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.82rem;
  display: flex;
  gap: 0.6rem;
}

.wld-mini-vals .w {
  color: #8fd97a;
}

.wld-mini-vals .d {
  color: #d9b36a;
}

.wld-mini-vals .l {
  color: #ff8a80;
}

.opening-games-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.opening-game-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.1);
  font-size: 0.82rem;
}

.og-opp {
  flex: 1;
  font-weight: 600;
  color: #f5f5dc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.og-color {
  font-size: 0.9rem;
}

.og-acc {
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  color: rgba(244, 240, 227, 0.7);
}

/* Stamina */
.stamina-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1.5rem;
}

.stamina-card {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 16px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.stamina-title {
  font-family: 'Cormorant Garamond', serif;
  color: #f5f5dc;
  font-size: 1.2rem;
  font-weight: 600;
  margin: 0;
}

.stamina-games {
  font-size: 0.8rem;
  color: rgba(244, 240, 227, 0.5);
  font-family: "JetBrains Mono", monospace;
}

.stamina-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0.5rem;
}

.stamina-val {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.2rem;
  font-weight: 700;
  color: #f5f5dc;
}

.stamina-wld {
  margin-top: 0.5rem;
}

/* Playstyle */
.playstyle-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
  justify-content: center;
  align-items: center;
  flex-direction: column;
}

@media (min-width: 768px) {
  .playstyle-panel {
    flex-direction: row;
  }

  .radar-container {
    flex: 0 0 300px;
  }

  .playstyle-traits {
    flex: 1;
    min-width: 250px;
  }

  .playstyle-note,
  .playstyle-formulas {
    flex-basis: 100%;
  }
}

.radar-container {
  width: 100%;
  max-width: 300px;
  aspect-ratio: 1/1;
}

.radar-svg {
  width: 100%;
  height: 100%;
}

.radar-label {
  font-size: 8px;
  letter-spacing: 0.5px;
  fill: rgba(244, 240, 227, 0.8);
  font-weight: 600;
  text-transform: uppercase;
}

.panel-meta {
  flex-basis: 100%;
  margin: 0;
  text-align: center;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.78rem;
  color: rgba(244, 240, 227, 0.5);
}

.playstyle-traits {
  flex: 1;
  min-width: 250px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.trait-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.trait-name {
  font-size: 0.9rem;
  font-weight: 600;
  color: rgba(244, 240, 227, 0.8);
  width: 80px;
}

.trait-bar-container {
  flex: 1;
  height: 10px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 5px;
  overflow: hidden;
}

.trait-bar {
  height: 100%;
  background: linear-gradient(90deg, #6ad13faa, #6ad13f);
  border-radius: 5px;
  transition: width 0.5s ease;
}

.trait-val {
  font-family: "JetBrains Mono", monospace;
  font-size: 1rem;
  font-weight: 700;
  color: #f5f5dc;
  width: 30px;
  text-align: right;
}

.playstyle-note {
  width: 100%;
  background: linear-gradient(135deg, rgba(106, 209, 63, 0.08), rgba(217, 179, 130, 0.05));
  border: 1px solid rgba(217, 179, 130, 0.25);
  border-radius: 14px;
  padding: 1.25rem 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.playstyle-note-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.playstyle-archetype {
  font-family: 'Cormorant Garamond', serif;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-highlight, #d9b382);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.playstyle-trait-tag {
  font-size: 0.75rem;
  color: rgba(244, 240, 227, 0.7);
  background: rgba(0, 0, 0, 0.25);
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  font-weight: 600;
}

.playstyle-note-body {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.55;
  color: rgba(244, 240, 227, 0.88);
}

.playstyle-note-secondary {
  margin: 0;
  font-size: 0.82rem;
  font-style: italic;
  color: rgba(244, 240, 227, 0.6);
}

.playstyle-formulas {
  width: 100%;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 1rem 1.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.formulas-title {
  font-family: 'Cormorant Garamond', serif;
  font-size: 0.95rem;
  font-weight: 700;
  color: #f5f5dc;
  margin: 0 0 0.3rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.formula-row {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 0.75rem;
  font-size: 0.82rem;
  align-items: baseline;
  padding: 0.35rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.formula-row:last-of-type {
  border-bottom: none;
}

.formula-axis {
  font-weight: 700;
  color: var(--text-highlight, #d9b382);
}

.formula-text {
  color: rgba(244, 240, 227, 0.7);
  line-height: 1.4;
}

.formulas-disclaimer {
  margin: 0.5rem 0 0;
  font-size: 0.78rem;
  color: rgba(244, 240, 227, 0.55);
  line-height: 1.5;
  font-style: italic;
}

.formulas-disclaimer strong {
  color: #f4f0e3;
  font-style: normal;
}

/* Heatmap */
.heatmap-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.heatmap-boards-container {
  display: flex;
  gap: 2rem;
  width: 100%;
  justify-content: center;
  flex-wrap: wrap;
}

.heatmap-instance {
  flex: 1;
  min-width: 250px;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.heatmap-header {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
  gap: 0.25rem;
}

.section-subtitle {
  font-family: 'Cormorant Garamond', serif;
  color: #f5f5dc;
  font-size: 1rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin: 0;
  text-align: center;
  width: 100%;
}

.section-subtitle.bad-color {
  color: #ff8a80;
}

.section-subtitle.good-color {
  color: #8fd97a;
}

.heatmap-total {
  font-size: 0.75rem;
  color: rgba(244, 240, 227, 0.5);
  font-family: "JetBrains Mono", monospace;
  text-align: center;
  width: 100%;
}

.heatmap-board-wrapper {
  width: 100%;
  display: flex;
  justify-content: center;
}

.heatmap-board {
  display: flex;
  gap: 8px;
  width: 100%;
  aspect-ratio: 1/1;
}

.heatmap-rank-labels {
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  width: 12px;
  color: rgba(244, 240, 227, 0.4);
  font-size: 0.8rem;
  font-family: "JetBrains Mono", monospace;
}

.heatmap-grid-area {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.heatmap-row {
  display: flex;
  flex: 1;
}

.heatmap-square {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  font-weight: 800;
  color: #fff;
  transition: all 0.2s;
  cursor: pointer;
  position: relative;
  border: none;
  padding: 0;
  margin: 0;
  font-family: inherit;
}

.heatmap-square.light {
  background: var(--board-light, #f0d9b5);
}

.heatmap-square.dark {
  background: var(--board-dark, #b58863);
}

.heatmap-square.bad.active {
  background: color-mix(in srgb, #ff2828 calc(var(--intensity) * 60%), var(--board-dark, #b58863));
  box-shadow: inset 0 0 15px color-mix(in srgb, red calc(var(--intensity) * 80%), transparent);
}

.heatmap-square.bad.light.active {
  background: color-mix(in srgb, #ff2828 calc(var(--intensity) * 60%), var(--board-light, #f0d9b5));
}

.heatmap-square.good.active {
  background: color-mix(in srgb, #6ad13f calc(var(--intensity) * 60%), var(--board-dark, #b58863));
  box-shadow: inset 0 0 15px color-mix(in srgb, green calc(var(--intensity) * 80%), transparent);
}

.heatmap-square.good.light.active {
  background: color-mix(in srgb, #6ad13f calc(var(--intensity) * 60%), var(--board-light, #f0d9b5));
}

.heatmap-square:hover,
.heatmap-square:focus-visible {
  outline: 2px solid #fff;
  outline-offset: -2px;
  z-index: 2;
  transform: scale(1.05);
}

.heatmap-square.selected {
  outline: 2px solid var(--text-highlight, #fff);
  outline-offset: -2px;
  z-index: 2;
}

.sq-count {
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
  z-index: 1;
}

.heatmap-file-labels {
  display: flex;
  justify-content: space-around;
  height: 12px;
  margin-top: 4px;
  color: rgba(244, 240, 227, 0.4);
  font-size: 0.8rem;
  font-family: "JetBrains Mono", monospace;
}

.heatmap-drilldown {
  width: 100%;
  max-width: 500px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 1rem 1.25rem;
}

.drilldown-title {
  font-family: "JetBrains Mono", monospace;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-highlight, #f5f5dc);
  margin: 0 0 0.75rem;
}

.drilldown-games {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.drilldown-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.5rem;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.12);
  font-size: 0.82rem;
}

.dg-opp {
  flex: 1;
  font-weight: 600;
  color: #f5f5dc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dg-count {
  color: rgba(244, 240, 227, 0.5);
  font-size: 0.75rem;
  white-space: nowrap;
}

.dg-acc {
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  color: rgba(244, 240, 227, 0.7);
}

.drilldown-empty {
  color: rgba(244, 240, 227, 0.5);
  font-size: 0.85rem;
  font-style: italic;
  margin: 0;
}

.heatmap-info {
  text-align: center;
  font-size: 0.85rem;
  color: rgba(244, 240, 227, 0.5);
  margin-top: 0.5rem;
  max-width: 400px;
}

@media (max-width: 600px) {
  .hero-card {
    flex-direction: column;
    gap: 1rem;
  }

  .hero-divider {
    width: 100%;
    height: 1px;
  }

  .hero-secondary {
    width: 100%;
    justify-content: space-between;
    gap: 1rem;
  }

  .opening-row {
    flex-wrap: wrap;
  }

  .opening-name {
    width: 100%;
    flex: 1 1 100%;
    order: 2;
    margin-top: 0.5rem;
  }

  .opening-games {
    order: 3;
    margin-left: auto;
  }

  .opening-acc-container {
    order: 4;
  }

  .opening-wld-row {
    flex-direction: column;
    gap: 0.75rem;
  }
}

  @media (prefers-reduced-motion: reduce) {
    .tab-panel {
      animation: none;
    }
  }
</style>