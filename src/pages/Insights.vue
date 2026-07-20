<script setup>
  import { ref, computed, onMounted, watch } from 'vue'
  import Title from '../assets/Title.vue'
  import { auth, db } from '../firebase'
  import { onAuthStateChanged } from 'firebase/auth'
  import { collection, query, orderBy, getDocs } from 'firebase/firestore'

  // --- Apply theme instantly ---
  const currentTheme = ref(localStorage.getItem('chesslab_theme') || 'brown')
  watch(currentTheme, (newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('chesslab_theme', newTheme)
  }, { immediate: true })

  const currentUser = ref(null)
  const insights = ref([])
  const loading = ref(true)
  const activeTab = ref('overview')

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
        .map(doc => doc.data())
        .filter(game => game.insights && game.insights.overallAccuracy !== null)
    } catch (e) {
      console.error("Failed to load insights:", e)
    }
  }

  // --- Helper: Map Accuracy to Classification ---
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

  // --- Computed Statistics ---
  const totalGames = computed(() => insights.value.length)
  const totalMoves = computed(() => insights.value.reduce((sum, game) => sum + (game.insights?.totalMoves || 0), 0))

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
      
      const myRes = c === 'white' ? g.white?.result : g.black?.result
      if (myRes === 'win') colors[c].win++
      else if (['lose', 'checkmated', 'resigned', 'abandoned'].includes(myRes)) colors[c].loss++
      else colors[c].draw++
    })

    const calcAcc = (arr) => arr.length ? (arr.reduce((a,b) => a+b, 0) / arr.length).toFixed(1) : null

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
    const totals = { p: {count:0, sum:0}, n: {count:0, sum:0}, b: {count:0, sum:0}, r: {count:0, sum:0}, q: {count:0, sum:0}, k: {count:0, sum:0} }
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

  const totalPieceMoves = computed(() => Object.values(pieceStats.value).reduce((a,b) => a + b.count, 0))

  const pieceData = computed(() => {
    return pieceMeta.map(p => {
      const stats = pieceStats.value[p.key]
      const avgAcc = stats.count > 0 ? (stats.sum / stats.count).toFixed(1) : null
      const movePercent = totalPieceMoves.value > 0 ? ((stats.count / totalPieceMoves.value) * 100).toFixed(1) : 0
      return {
        ...p,
        count: stats.count,
        avgAcc: avgAcc ? parseFloat(avgAcc) : null,
        meta: avgAcc ? getAccuracyMeta(parseFloat(avgAcc)) : getAccuracyMeta(null),
        movePercent
      }
    })
  })

  // --- Game Length Survival Curves ---
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
      const myRes = c === 'white' ? g.white?.result : g.black?.result
      if (myRes === 'win') buckets[bucket].win++
      else if (['lose', 'checkmated', 'resigned', 'abandoned'].includes(myRes)) buckets[bucket].loss++
      else buckets[bucket].draw++
    })
    return Object.values(buckets).map(b => ({
      ...b,
      avgAcc: b.accs.length ? (b.accs.reduce((a,b) => a+b, 0) / b.accs.length).toFixed(1) : null
    }))
  })

  // --- Playstyle Radar Profile ---
  const playstyleData = computed(() => {
    const totals = { earlyTrades: 0, evalSwings: 0, brilliantMoves: 0, endgameAcc: 0, openingAcc: 0, games: 0 }
    insights.value.forEach(g => {
      if (g.insights?.playstyle) {
        totals.earlyTrades += g.insights.playstyle.earlyTrades || 0
        totals.evalSwings += g.insights.playstyle.evalSwings || 0
        totals.brilliantMoves += g.insights.playstyle.brilliantMoves || 0
        totals.endgameAcc += g.insights.playstyle.endgameAcc || 0
        totals.openingAcc += g.insights.playstyle.openingAcc || 0
        totals.games++
      }
    })
    if (totals.games === 0) return null

    const avgEarlyTrades = totals.earlyTrades / totals.games
    const avgEvalSwings = totals.evalSwings / totals.games
    const avgBrilliant = totals.brilliantMoves / totals.games
    const avgEndgameAcc = totals.endgameAcc / totals.games
    const avgOpeningAcc = totals.openingAcc / totals.games

    // Normalize to 0-100
    const traderScore = Math.min(100, (avgEarlyTrades / 4) * 100)
    const tacticianScore = Math.min(100, ((avgEvalSwings / 8) + (avgBrilliant / 2)) * 50)
    const aggressiveScore = Math.min(100, ((avgBrilliant / 2) + (avgEvalSwings / 10)) * 50)
    const defensiveScore = Math.min(100, avgOpeningAcc)
    const endgameScore = Math.min(100, avgEndgameAcc)

    return [
      { axis: 'Aggressive', value: aggressiveScore },
      { axis: 'Defensive', value: defensiveScore },
      { axis: 'Trader', value: traderScore },
      { axis: 'Endgame', value: endgameScore },
      { axis: 'Tactician', value: tacticianScore }
    ]
  })

  const radarPoints = computed(() => {
    if (!playstyleData.value) return ""
    const center = 100, radius = 80
    return playstyleData.value.map((d, i) => {
      const angle = (i * 72 - 90) * Math.PI / 180
      const x = center + (d.value / 100) * radius * Math.cos(angle)
      const y = center + (d.value / 100) * radius * Math.sin(angle)
      return `${x},${y}`
    }).join(' ')
  })

  const radarGrid = computed(() => {
    const center = 100, radius = 80
    const levels = [0.25, 0.5, 0.75, 1.0]
    return levels.map(level => {
      return Array.from({length: 5}).map((_, i) => {
        const angle = (i * 72 - 90) * Math.PI / 180
        const x = center + level * radius * Math.cos(angle)
        const y = center + level * radius * Math.sin(angle)
        return `${x},${y}`
      }).join(' ')
    })
  })

  const radarLabels = computed(() => {
    if (!playstyleData.value) return []
    const center = 100, radius = 95
    return playstyleData.value.map((d, i) => {
      const angle = (i * 72 - 90) * Math.PI / 180
      const x = center + radius * Math.cos(angle)
      const y = center + radius * Math.sin(angle)
      return { x, y, label: d.axis, value: d.value.toFixed(0) }
    })
  })

  // --- Playstyle Note Generator ---
  const playstyleNote = computed(() => {
    if (!playstyleData.value) return null
    const sorted = [...playstyleData.value].sort((a, b) => b.value - a.value)
    const top = sorted[0]
    const second = sorted[1]

    const notes = {
      Trader: {
        title: 'The Simplifier',
        body: (v) => `You regularly exchange pieces early — on average you make ${Math.round(v/25 * 4)} early trades per game. This patience-first approach reduces tactical risk and steers games toward positions you understand, but against lower-rated opponents it can also dissipate winning chances. Consider keeping more tension on the board when you're the favorite.`
      },
      Tactician: {
        title: 'The Calculator',
        body: (v) => `Your games feature sharp evaluation swings and a healthy rate of brilliant moves — your score of ${v.toFixed(0)} reflects a player who thrives in complexity. You're at your best when the position demands concrete calculation rather than quiet maneuvering. Be mindful that this same appetite for complications can backfire in time trouble.`
      },
      Aggressive: {
        title: 'The Initiator',
        body: (v) => `You push for the initiative — your moves frequently change the evaluation bar and create problems for your opponent. With a score of ${v.toFixed(0)}, you rarely play a "quiet" game. The flip side is that aggressive play demands accurate calculation; when the attack doesn't quite land, you can be left overextended.`
      },
      Defensive: {
        title: 'The Solid Builder',
        body: (v) => `Your opening accuracy of ${v.toFixed(0)}% is notably high — you navigate the first phase of the game confidently and rarely stray into trouble early. This solidity gives you a reliable foundation, but be careful not to drift into passivity: sound openings still need to be followed up with active middlegame plans.`
      },
      Endgame: {
        title: 'The Technician',
        body: (v) => `You convert endgames with precision (${v.toFixed(0)}% accuracy), suggesting strong technical understanding when the board simplifies. Many players collapse once the pieces come off — you don't. To leverage this further, aim to steer slightly worse positions toward endgames where your technique can save half-points others would drop.`
      }
    }

    const t = notes[top.axis]
    return {
      title: t.title,
      trait: top.axis,
      body: t.body(top.value),
      secondary: top.value - second.value < 15
        ? `You also show strong ${second.axis.toLowerCase()} tendencies.`
        : null
    }
  })

  // --- Playstyle Calculation Explanations ---
  const playstyleFormulas = [
    { axis: 'Trader',     formula: 'Average early captures (first 12 plies) per game, scaled so 4 trades = 100.' },
    { axis: 'Tactician',  formula: 'Average evaluation swings (>100 cp shifts) and brilliant moves per game, combined and scaled.' },
    { axis: 'Aggressive', formula: 'Combination of brilliant moves and evaluation swings per game — measures how often you force the position to change character.' },
    { axis: 'Defensive',  formula: 'Directly your average opening-phase accuracy percentage.' },
    { axis: 'Endgame',    formula: 'Directly your average endgame-phase accuracy percentage.' }
  ]

  const RECENT_WINDOW = 5
  const trend = computed(() => {
    const withAcc = insights.value.filter(g => g.insights?.overallAccuracy !== null)
    if (withAcc.length < 4) return null
    const recent = withAcc.slice(0, RECENT_WINDOW)
    const older = withAcc.slice(RECENT_WINDOW)
    if (older.length === 0) return null

    const avg = (arr) => arr.reduce((a, g) => a + g.insights.overallAccuracy, 0) / arr.length
    const delta = avg(recent) - avg(older)
    return {
      delta: delta.toFixed(1),
      direction: delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat'
    }
  })

  const phaseAccuracy = computed(() => {
    const phases = { opening: [], middlegame: [], endgame: [] }
    insights.value.forEach(g => {
      if (g.insights?.phaseAccuracy) {
        if (g.insights.phaseAccuracy.opening !== null) phases.opening.push(g.insights.phaseAccuracy.opening)
        if (g.insights.phaseAccuracy.middlegame !== null) phases.middlegame.push(g.insights.phaseAccuracy.middlegame)
        if (g.insights.phaseAccuracy.endgame !== null) phases.endgame.push(g.insights.phaseAccuracy.endgame)
      }
    })
    const calc = (arr) => arr.length ? (arr.reduce((a,b) => a+b, 0) / arr.length).toFixed(1) : null
    let oAcc = calc(phases.opening), mAcc = calc(phases.middlegame), eAcc = calc(phases.endgame)
    return {
      opening: { val: oAcc, meta: getAccuracyMeta(oAcc ? parseFloat(oAcc) : null), n: phases.opening.length },
      middlegame: { val: mAcc, meta: getAccuracyMeta(mAcc ? parseFloat(mAcc) : null), n: phases.middlegame.length },
      endgame: { val: eAcc, meta: getAccuracyMeta(eAcc ? parseFloat(eAcc) : null), n: phases.endgame.length }
    }
  })

  const moveCounts = computed(() => {
    const totals = { brilliant: 0, great: 0, best: 0, book: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }
    insights.value.forEach(g => {
      if (g.insights?.moveCounts) {
        for (const key in totals) totals[key] += g.insights.moveCounts[key] || 0
      }
    })
    return totals
  })

  const moveCountsWithAvg = computed(() => {
    const totals = { brilliant: 0, great: 0, best: 0, book: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }
    insights.value.forEach(g => {
      if (g.insights?.moveCounts) {
        for (const key in totals) totals[key] += g.insights.moveCounts[key] || 0
      }
    })
    const games = totalGames.value || 1
    return Object.fromEntries(
      Object.entries(totals).map(([k, v]) => [k, { total: v, avg: v / games }])
    )
  })

  const moveCountsTotal = computed(() => Object.values(moveCounts.value).reduce((a, b) => a + b, 0))
  const classificationOrder = ['brilliant', 'great', 'best', 'book', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder']

  const moveCountsBarSegments = computed(() => {
    const total = moveCountsTotal.value
    if (!total) return []
    return classificationOrder
      .map(key => ({ key, count: moveCounts.value[key], percent: (moveCounts.value[key] / total) * 100, meta: classificationMeta[key] }))
      .filter(seg => seg.count > 0)
  })

  // --- Heatmap Logic Generator ---
  function generateHeatmapData(type) {
    const squareKey = type === 'bad' ? 'blunderSquares' : 'goodSquares';
    const squares = {};
    let max = 0;
    insights.value.forEach(g => {
      if (g.insights?.[squareKey]) {
        for (const sq in g.insights[squareKey]) {
          squares[sq] = (squares[sq] || 0) + g.insights[squareKey][sq];
          if (squares[sq] > max) max = squares[sq];
        }
      }
    });
    return { squares, max };
  }

  function generateBoardData(heatmap) {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = [8, 7, 6, 5, 4, 3, 2, 1];
    const rows = [];
    for (const rank of ranks) {
      const row = [];
      for (const file of files) {
        const sq = `${file}${rank}`;
        const count = heatmap.squares[sq] || 0;
        const intensity = heatmap.max > 0 ? count / heatmap.max : 0;
        row.push({ sq, count, intensity });
      }
      rows.push(row);
    }
    return rows;
  }

  const badHeatmap = computed(() => generateHeatmapData('bad'));
  const totalBadMoves = computed(() => Object.values(badHeatmap.value.squares).reduce((a, b) => a + b, 0));
  const badBoardSquares = computed(() => generateBoardData(badHeatmap.value));

  const goodHeatmap = computed(() => generateHeatmapData('good'));
  const totalGoodMoves = computed(() => Object.values(goodHeatmap.value.squares).reduce((a, b) => a + b, 0));
  const goodBoardSquares = computed(() => generateBoardData(goodHeatmap.value));

  const selectedSquare = ref(null)
  function tapSquare(sq) {
    selectedSquare.value = selectedSquare.value?.sq === sq.sq ? null : sq
  }

  const topOpenings = computed(() => {
    const counts = {}
    insights.value.forEach(g => {
      const name = g.insights?.opening && g.insights.opening !== "Unknown Opening" ? g.insights.opening : "Unrecognized Opening"
      if (!counts[name]) counts[name] = { name, count: 0, accuracy: [] }
      counts[name].count++
      if (g.insights?.overallAccuracy !== null) counts[name].accuracy.push(g.insights.overallAccuracy)
    })

    return Object.values(counts)
      .map(o => {
        const avgAccuracy = o.accuracy.length ? (o.accuracy.reduce((a,b) => a+b, 0) / o.accuracy.length) : null
        return {
          name: o.name,
          count: o.count,
          avgAccuracy: avgAccuracy !== null ? avgAccuracy.toFixed(1) : null,
          meta: avgAccuracy !== null ? getAccuracyMeta(parseFloat(avgAccuracy.toFixed(1))) : getAccuracyMeta(null)
        }
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  })

  const classificationMeta = {
    brilliant:  { label: 'Brilliant',  color: '#03aea7', icon: '/moveClassifications/brilliant.png' },
    great:      { label: 'Great',      color: '#4c8cb5', icon: '/moveClassifications/great.png' },
    best:       { label: 'Best',       color: '#6ad13f', icon: '/moveClassifications/best.png' },
    book:       { label: 'Book',       color: '#ad8760', icon: '/moveClassifications/book.png' },
    excellent:  { label: 'Excellent',  color: '#90bc36', icon: '/moveClassifications/excellent.png' },
    good:       { label: 'Good',       color: '#8eae83', icon: '/moveClassifications/good.png' },
    inaccuracy: { label: 'Inaccuracy', color: '#f2bc43', icon: '/moveClassifications/inaccuracy.png' },
    mistake:    { label: 'Mistake',    color: '#f38800', icon: '/moveClassifications/mistake.png' },
    blunder:    { label: 'Blunder',    color: '#FF0000', icon: '/moveClassifications/blunder.png' }
  }

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
              <button class="tab-btn" :class="{ active: activeTab === 'overview' }"  @click="setTab('overview')">1. Overview</button>
              <button class="tab-btn" :class="{ active: activeTab === 'moves' }"     @click="setTab('moves')">2. Move Classes</button>
              <button class="tab-btn" :class="{ active: activeTab === 'colors' }"    @click="setTab('colors')">3. Colors</button>
              <button class="tab-btn" :class="{ active: activeTab === 'pieces' }"    @click="setTab('pieces')">4. Pieces</button>
              <button class="tab-btn" :class="{ active: activeTab === 'openings' }"  @click="setTab('openings')">5. Openings</button>
              <button class="tab-btn" :class="{ active: activeTab === 'stamina' }"   @click="setTab('stamina')">6. Stamina</button>
              <button class="tab-btn" :class="{ active: activeTab === 'playstyle' }" @click="setTab('playstyle')">7. Playstyle</button>
              <button class="tab-btn" :class="{ active: activeTab === 'heatmap' }"   @click="setTab('heatmap')">8. Heatmap</button>
            </div>
          </div>

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
                    <div class="hero-stat">
                      <span class="stat-label">Games</span>
                      <span class="hero-sub-value">{{ totalGames }}</span>
                    </div>
                    <div class="hero-stat">
                      <span class="stat-label">Moves</span>
                      <span class="hero-sub-value">{{ totalMoves }}</span>
                    </div>
                    <div class="hero-stat">
                      <span class="stat-label">Blunders</span>
                      <span class="hero-sub-value" style="color: #ff8a80;">{{ moveCounts.blunder + moveCounts.mistake }}</span>
                    </div>
                  </div>
                </div>

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
                  <div class="color-card white-card">
                    <div class="color-header">
                      <span class="color-swatch white"></span>
                      <h3 class="color-title">Playing as White</h3>
                    </div>
                    <div class="color-body">
                      <div class="color-stat">
                        <span class="stat-label">Games</span>
                        <span class="color-val">{{ colorPerformance.white.games }}</span>
                      </div>
                      <div class="color-stat">
                        <span class="stat-label">Avg Accuracy</span>
                        <span class="color-val" :style="{color: colorPerformance.white.avgAcc ? getAccuracyMeta(parseFloat(colorPerformance.white.avgAcc)).color : '#fff'}">{{ colorPerformance.white.avgAcc ? colorPerformance.white.avgAcc + '%' : '—' }}</span>
                      </div>
                      <div class="color-stat">
                        <span class="stat-label">Blunders</span>
                        <span class="color-val" style="color: #ff8a80;">{{ colorPerformance.white.blunders }}</span>
                      </div>
                      <div class="wld-bar">
                        <div class="wld-segment win" :style="{ width: (colorPerformance.white.games > 0 ? (colorPerformance.white.win / colorPerformance.white.games) * 100 : 0) + '%' }" :title="`Wins: ${colorPerformance.white.win}`"></div>
                        <div class="wld-segment draw" :style="{ width: (colorPerformance.white.games > 0 ? (colorPerformance.white.draw / colorPerformance.white.games) * 100 : 0) + '%' }" :title="`Draws: ${colorPerformance.white.draw}`"></div>
                        <div class="wld-segment loss" :style="{ width: (colorPerformance.white.games > 0 ? (colorPerformance.white.loss / colorPerformance.white.games) * 100 : 0) + '%' }" :title="`Losses: ${colorPerformance.white.loss}`"></div>
                      </div>
                      <div class="wld-legend">
                        <span><span class="dot win"></span> Win ({{ colorPerformance.white.win }})</span>
                        <span><span class="dot draw"></span> Draw ({{ colorPerformance.white.draw }})</span>
                        <span><span class="dot loss"></span> Loss ({{ colorPerformance.white.loss }})</span>
                      </div>
                    </div>
                  </div>

                  <div class="color-card black-card">
                    <div class="color-header">
                      <span class="color-swatch black"></span>
                      <h3 class="color-title">Playing as Black</h3>
                    </div>
                    <div class="color-body">
                      <div class="color-stat">
                        <span class="stat-label">Games</span>
                        <span class="color-val">{{ colorPerformance.black.games }}</span>
                      </div>
                      <div class="color-stat">
                        <span class="stat-label">Avg Accuracy</span>
                        <span class="color-val" :style="{color: colorPerformance.black.avgAcc ? getAccuracyMeta(parseFloat(colorPerformance.black.avgAcc)).color : '#fff'}">{{ colorPerformance.black.avgAcc ? colorPerformance.black.avgAcc + '%' : '—' }}</span>
                      </div>
                      <div class="color-stat">
                        <span class="stat-label">Blunders</span>
                        <span class="color-val" style="color: #ff8a80;">{{ colorPerformance.black.blunders }}</span>
                      </div>
                      <div class="wld-bar">
                        <div class="wld-segment win" :style="{ width: (colorPerformance.black.games > 0 ? (colorPerformance.black.win / colorPerformance.black.games) * 100 : 0) + '%' }" :title="`Wins: ${colorPerformance.black.win}`"></div>
                        <div class="wld-segment draw" :style="{ width: (colorPerformance.black.games > 0 ? (colorPerformance.black.draw / colorPerformance.black.games) * 100 : 0) + '%' }" :title="`Draws: ${colorPerformance.black.draw}`"></div>
                        <div class="wld-segment loss" :style="{ width: (colorPerformance.black.games > 0 ? (colorPerformance.black.loss / colorPerformance.black.games) * 100 : 0) + '%' }" :title="`Losses: ${colorPerformance.black.loss}`"></div>
                      </div>
                      <div class="wld-legend">
                        <span><span class="dot win"></span> Win ({{ colorPerformance.black.win }})</span>
                        <span><span class="dot draw"></span> Draw ({{ colorPerformance.black.draw }})</span>
                        <span><span class="dot loss"></span> Loss ({{ colorPerformance.black.loss }})</span>
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
                      <div class="piece-stat">
                        <span class="stat-label">Moves</span>
                        <span class="piece-val">{{ p.count }} ({{ p.movePercent }}%)</span>
                      </div>
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
                <div class="openings-list">
                  <div v-for="(opening, i) in topOpenings" :key="i" class="opening-row">
                    <span class="opening-rank">#{{ i + 1 }}</span>
                    <span class="opening-name">{{ opening.name }}</span>
                    <span class="opening-games">{{ opening.count }} games</span>
                    <div class="opening-acc-container" v-if="opening.avgAccuracy">
                      <img :src="opening.meta.icon" class="opening-acc-icon" alt="" />
                      <span class="opening-acc" :style="{color: opening.meta.color}">{{ opening.avgAccuracy }}%</span>
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
                      <div class="wld-segment win"  :style="{ width: (bucket.games > 0 ? (bucket.win  / bucket.games) * 100 : 0) + '%' }" :title="`Wins: ${bucket.win}`"></div>
                      <div class="wld-segment draw" :style="{ width: (bucket.games > 0 ? (bucket.draw / bucket.games) * 100 : 0) + '%' }" :title="`Draws: ${bucket.draw}`"></div>
                      <div class="wld-segment loss" :style="{ width: (bucket.games > 0 ? (bucket.loss / bucket.games) * 100 : 0) + '%' }" :title="`Losses: ${bucket.loss}`"></div>
                    </div>
                    <div class="wld-legend">
                      <span><span class="dot win"></span> {{ bucket.win }}</span>
                      <span><span class="dot draw"></span> {{ bucket.draw }}</span>
                      <span><span class="dot loss"></span> {{ bucket.loss }}</span>
                    </div>

                    <div class="stamina-stat">
                      <span class="stat-label">Avg Accuracy</span>
                      <span class="stamina-val" :style="{color: bucket.avgAcc ? getAccuracyMeta(parseFloat(bucket.avgAcc)).color : '#fff'}">{{ bucket.avgAcc ? bucket.avgAcc + '%' : '—' }}</span>
                    </div>
                    <div class="stamina-stat">
                      <span class="stat-label">Blunders</span>
                      <span class="stamina-val" style="color: #ff8a80;">{{ bucket.blunders }}</span>
                    </div>
                  </div>
                </div>
              </template>

              <!-- PLAYSTYLE TAB -->
              <template v-if="activeTab === 'playstyle'">
                <div class="playstyle-panel" v-if="playstyleData">
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
                      <div class="trait-bar-container">
                        <div class="trait-bar" :style="{ width: d.value + '%' }"></div>
                      </div>
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
                    <p class="formulas-disclaimer">
                      Note: each axis is normalized independently on a 0–100 intensity scale, so the values
                      intentionally do <strong>not</strong> sum to 100. They describe how strongly you exhibit
                      each individual trait, not a percentage distribution.
                    </p>
                  </div>
                </div>
                <div v-else class="panel-empty">
                  <p>Not enough data to generate a playstyle profile yet. Analyze a few more games!</p>
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
                          <div class="heatmap-rank-labels" aria-hidden="true">
                            <span v-for="r in 8" :key="r">{{ 9 - r }}</span>
                          </div>
                          <div class="heatmap-grid-area">
                            <div class="heatmap-row" v-for="row in badBoardSquares" :key="row[0].sq[1]">
                              <button
                                v-for="sq in row"
                                :key="sq.sq"
                                type="button"
                                class="heatmap-square bad"
                                :class="{ light: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 === 0, dark: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 !== 0, active: sq.intensity > 0, selected: selectedSquare?.sq === sq.sq }"
                                :style="{ '--intensity': sq.intensity }"
                                :title="`${sq.sq}: ${sq.count} mistake${sq.count === 1 ? '' : 's'}`"
                                @click="tapSquare(sq)"
                              >
                                <span v-if="sq.count > 0" class="sq-count" aria-hidden="true">{{ sq.count }}</span>
                              </button>
                            </div>
                            <div class="heatmap-file-labels" aria-hidden="true">
                              <span v-for="f in ['a','b','c','d','e','f','g','h']" :key="f">{{ f }}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div class="heatmap-instance">
                      <div class="heatmap-header">
                        <h3 class="section-subtitle good-color">Brilliant & Best Moves</h3>
                        <span class="heatmap-total">{{ totalGoodMoves }} mapped</span>
                      </div>
                      <div class="heatmap-board-wrapper">
                        <div class="heatmap-board">
                          <div class="heatmap-rank-labels" aria-hidden="true">
                            <span v-for="r in 8" :key="r">{{ 9 - r }}</span>
                          </div>
                          <div class="heatmap-grid-area">
                            <div class="heatmap-row" v-for="row in goodBoardSquares" :key="row[0].sq[1]">
                              <button
                                v-for="sq in row"
                                :key="sq.sq"
                                type="button"
                                class="heatmap-square good"
                                :class="{ light: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 === 0, dark: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 !== 0, active: sq.intensity > 0, selected: selectedSquare?.sq === sq.sq }"
                                :style="{ '--intensity': sq.intensity }"
                                :title="`${sq.sq}: ${sq.count} good move${sq.count === 1 ? '' : 's'}`"
                                @click="tapSquare(sq)"
                              >
                                <span v-if="sq.count > 0" class="sq-count" aria-hidden="true">{{ sq.count }}</span>
                              </button>
                            </div>
                            <div class="heatmap-file-labels" aria-hidden="true">
                              <span v-for="f in ['a','b','c','d','e','f','g','h']" :key="f">{{ f }}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <p class="heatmap-selected-readout" :class="{ visible: selectedSquare }">
                    <template v-if="selectedSquare">
                      <strong>{{ selectedSquare.sq }}</strong> — {{ selectedSquare.count }} move{{ selectedSquare.count === 1 ? '' : 's' }}
                    </template>
                    <template v-else>Tap a square to see its exact count.</template>
                  </p>
                  <p class="heatmap-info">Left board shows where you blunder. Right board shows where you play accurately.</p>
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
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
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
    font-family: serif;
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
    border-top-color: var(--text-highlight);
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
    -ms-overflow-style: none;
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
  }

  .tab-btn:hover {
    color: #f4f0e3;
  }

  .tab-btn.active {
    background: var(--btn-active);
    color: #f5f5dc;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35);
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

  /* Hero Card */
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

  /* Phase Cards */
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
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.1);
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

  /* Playstyle Tab */
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
    .radar-container { flex: 0 0 300px; }
    .playstyle-traits { flex: 1; min-width: 250px; }
    .playstyle-note, .playstyle-formulas { flex-basis: 100%; }
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
    font-size: 10px;
    fill: rgba(244, 240, 227, 0.8);
    font-weight: 600;
    text-transform: uppercase;
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

  /* Playstyle note */
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
    font-family: serif;
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

  /* Playstyle formulas */
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
    font-family: serif;
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
  .formula-row:last-of-type { border-bottom: none; }
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
  .formulas-disclaimer strong { color: #f4f0e3; font-style: normal; }

  /* Stamina Tab */
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
    font-family: serif;
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

  .stamina-wld { margin-top: 0.5rem; }

  /* Colors Tab */
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
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  }

  .color-swatch.white {
    background: #f4f0e3;
  }

  .color-swatch.black {
    background: #1a1a1a;
    border: 1px solid #333;
  }

  .color-title {
    font-family: serif;
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

  /* Pieces Tab */
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
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
  }

  .piece-name {
    font-family: serif;
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
  .openings-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .opening-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.5rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 10px;
    border: 1px solid transparent;
    transition: border-color 0.2s;
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .opening-games {
    font-family: "JetBrains Mono", monospace;
    color: rgba(244, 240, 227, 0.5);
    font-size: 0.85rem;
  }

  .opening-acc-container {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: rgba(255, 255, 255, 0.05);
    padding: 0.3rem 0.6rem;
    border-radius: 8px;
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

  /* Heatmaps */
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
    font-family: serif;
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
    background: var(--board-light);
  }

  .heatmap-square.dark {
    background: var(--board-dark);
  }

  .heatmap-square.bad.active {
    background: color-mix(in srgb, #ff2828 calc(var(--intensity) * 60%), var(--board-dark));
    box-shadow: inset 0 0 15px color-mix(in srgb, red calc(var(--intensity) * 80%), transparent);
    animation: pulseGlow 2s infinite alternate;
  }

  .heatmap-square.bad.light.active {
    background: color-mix(in srgb, #ff2828 calc(var(--intensity) * 60%), var(--board-light));
  }

  .heatmap-square.good.active {
    background: color-mix(in srgb, #6ad13f calc(var(--intensity) * 60%), var(--board-dark));
    box-shadow: inset 0 0 15px color-mix(in srgb, green calc(var(--intensity) * 80%), transparent);
    animation: pulseGlow 2s infinite alternate;
  }

  .heatmap-square.good.light.active {
    background: color-mix(in srgb, #6ad13f calc(var(--intensity) * 60%), var(--board-light));
  }

  @keyframes pulseGlow {
    from {
      filter: brightness(0.95);
    }
    to {
      filter: brightness(1.15);
    }
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

  .heatmap-selected-readout {
    text-align: center;
    font-size: 0.85rem;
    color: rgba(244, 240, 227, 0.5);
    margin: 0.5rem 0 0;
    min-height: 1.2em;
  }

  .heatmap-selected-readout.visible {
    color: #f5f5dc;
  }

  .heatmap-selected-readout strong {
    font-family: "JetBrains Mono", monospace;
    color: var(--text-highlight, #f5f5dc);
  }

  .heatmap-info {
    text-align: center;
    font-size: 0.85rem;
    color: rgba(244, 240, 227, 0.5);
    margin-top: 0.5rem;
    max-width: 400px;
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
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
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
  .move-bar-caption strong { color: #f4f0e3; }

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
    margin-top: 0.15rem;
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
  }

  @media (prefers-reduced-motion: reduce) {
    .heatmap-square.active {
      animation: none;
    }
    .tab-panel {
      animation: none;
    }
  }
</style>