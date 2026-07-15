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
  const tabSwitching = ref(false)

  // --- Tab persists across reloads, same pattern as theme ---
  const TABS = ['overview', 'openings', 'heatmap', 'moves']
  const storedTab = localStorage.getItem('chesslab_insights_tab')
  const activeTab = ref(TABS.includes(storedTab) ? storedTab : 'overview')

  function setTab(tab) {
    if (tab === activeTab.value) return
    tabSwitching.value = true
    // brief transition instead of a full-page blocking spinner on every tab click
    requestAnimationFrame(() => {
      activeTab.value = tab
      localStorage.setItem('chesslab_insights_tab', tab)
      setTimeout(() => { tabSwitching.value = false }, 150)
    })
  }

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
  // Colors now resolve to CSS custom properties so every theme can override them;
  // the hex values below are only the :root fallback defaults (see <style>).
  function getAccuracyMeta(acc) {
    if (acc === null || acc === undefined) return { label: 'N/A', icon: null, color: 'var(--acc-na, #666)' }
    if (acc >= 95) return { label: 'Brilliant', icon: '/moveClassifications/brilliant.png', color: 'var(--acc-brilliant, #03aea7)' }
    if (acc >= 90) return { label: 'Great', icon: '/moveClassifications/great.png', color: 'var(--acc-great, #8eae83)' }
    if (acc >= 80) return { label: 'Best', icon: '/moveClassifications/best.png', color: 'var(--acc-best, #6ad13f)' }
    if (acc >= 70) return { label: 'Excellent', icon: '/moveClassifications/excellent.png', color: 'var(--acc-excellent, #90bc36)' }
    if (acc >= 60) return { label: 'Good', icon: '/moveClassifications/good.png', color: 'var(--acc-good, #f2bc43)' }
    if (acc >= 50) return { label: 'Inaccuracy', icon: '/moveClassifications/inaccuracy.png', color: 'var(--acc-inaccuracy, #f2bc43)' }
    if (acc >= 40) return { label: 'Mistake', icon: '/moveClassifications/mistake.png', color: 'var(--acc-mistake, #f38800)' }
    return { label: 'Blunder', icon: '/moveClassifications/blunder.png', color: 'var(--acc-blunder, #FF0000)' }
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

  const moveCountsTotal = computed(() => Object.values(moveCounts.value).reduce((a, b) => a + b, 0))
  const classificationOrder = ['brilliant', 'great', 'best', 'book', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder']

  const moveCountsBarSegments = computed(() => {
    const total = moveCountsTotal.value
    if (!total) return []
    return classificationOrder
      .map(key => ({ key, count: moveCounts.value[key], percent: (moveCounts.value[key] / total) * 100, meta: classificationMeta[key] }))
      .filter(seg => seg.count > 0)
  })

  // --- Blunder Heatmap Logic ---
  const blunderHeatmap = computed(() => {
    const squares = {};
    let max = 0;
    insights.value.forEach(g => {
      if (g.insights?.blunderSquares) {
        for (const sq in g.insights.blunderSquares) {
          squares[sq] = (squares[sq] || 0) + g.insights.blunderSquares[sq];
          if (squares[sq] > max) max = squares[sq];
        }
      }
    });
    return { squares, max };
  });

  const totalBlunders = computed(() => Object.values(blunderHeatmap.value.squares).reduce((a, b) => a + b, 0))

  const boardSquares = computed(() => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = [8, 7, 6, 5, 4, 3, 2, 1];
    const rows = [];
    for (const rank of ranks) {
      const row = [];
      for (const file of files) {
        const sq = `${file}${rank}`;
        const count = blunderHeatmap.value.squares[sq] || 0;
        const intensity = blunderHeatmap.value.max > 0 ? count / blunderHeatmap.value.max : 0;
        row.push({ sq, count, intensity });
      }
      rows.push(row);
    }
    return rows;
  });

  // --- Tap-to-reveal for touch devices, since :hover tooltips don't fire there ---
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
    brilliant:  { label: 'Brilliant',  color: 'var(--acc-brilliant, #03aea7)', icon: '/moveClassifications/brilliant.png' },
    great:      { label: 'Great',      color: 'var(--acc-great-alt, #4c8cb5)', icon: '/moveClassifications/great.png' },
    best:       { label: 'Best',       color: 'var(--acc-best, #6ad13f)', icon: '/moveClassifications/best.png' },
    book:       { label: 'Book',       color: 'var(--acc-book, #ad8760)', icon: '/moveClassifications/book.png' },
    excellent:  { label: 'Excellent',  color: 'var(--acc-excellent, #90bc36)', icon: '/moveClassifications/excellent.png' },
    good:       { label: 'Good',       color: 'var(--acc-great, #8eae83)', icon: '/moveClassifications/good.png' },
    inaccuracy: { label: 'Inaccuracy', color: 'var(--acc-inaccuracy, #f2bc43)', icon: '/moveClassifications/inaccuracy.png' },
    mistake:    { label: 'Mistake',    color: 'var(--acc-mistake, #f38800)', icon: '/moveClassifications/mistake.png' },
    blunder:    { label: 'Blunder',    color: 'var(--acc-blunder, #FF0000)', icon: '/moveClassifications/blunder.png' }
  }
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

        <div v-else-if="!currentUser" class="empty-state">
          <p>Please log in to view your insights.</p>
        </div>

        <div v-else-if="insights.length === 0" class="empty-state">
          <p>No data yet. Analyze a game from your library to start building your insights!</p>
        </div>

        <div v-else class="dashboard-layout">
          <div class="tab-nav-wrapper">
            <div class="tab-nav" role="tablist">
              <button
                v-for="tab in TABS"
                :key="tab"
                class="tab-btn"
                role="tab"
                :aria-selected="activeTab === tab"
                :class="{ active: activeTab === tab }"
                @click="setTab(tab)"
              >
                {{ { overview: 'Overview', openings: 'Openings', heatmap: 'Heatmap', moves: 'Move Classes' }[tab] }}
              </button>
            </div>
          </div>

          <div class="tab-content-area">
            <div class="tab-panel" :class="{ 'is-switching': tabSwitching }">
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
                      <span v-if="trend.direction === 'up'" aria-hidden="true">▲</span>
                      <span v-else-if="trend.direction === 'down'" aria-hidden="true">▼</span>
                      <span v-else aria-hidden="true">◆</span>
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
                      <span class="hero-sub-value" style="color: var(--acc-blunder, #ff8a80);">{{ moveCounts.blunder + moveCounts.mistake }}</span>
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
                      <div
                        v-if="phase.val !== null"
                        class="phase-bar"
                        :style="{ width: phase.val + '%', background: `linear-gradient(90deg, color-mix(in srgb, ${phase.meta.color} 70%, transparent), ${phase.meta.color})` }"
                      ></div>
                      <div v-else class="phase-bar-empty"></div>
                    </div>
                    <div class="phase-footer">
                      <span class="phase-n">{{ phase.n }} game{{ phase.n === 1 ? '' : 's' }}</span>
                      <span class="phase-val" :style="{ color: phase.meta.color }">{{ phase.val !== null ? phase.val + '%' : 'No data yet' }}</span>
                    </div>
                  </div>
                </div>
              </template>

              <!-- OPENINGS TAB -->
              <template v-if="activeTab === 'openings'">
                <div v-if="topOpenings.length" class="openings-list">
                  <div v-for="(opening, i) in topOpenings" :key="i" class="opening-row">
                    <span class="opening-rank">#{{ i + 1 }}</span>
                    <span class="opening-name">{{ opening.name }}</span>
                    <span class="opening-games">{{ opening.count }} game{{ opening.count === 1 ? '' : 's' }}</span>
                    <div class="opening-acc-container" v-if="opening.avgAccuracy">
                      <img :src="opening.meta.icon" class="opening-acc-icon" alt="" />
                      <span class="opening-acc" :style="{color: opening.meta.color}">{{ opening.avgAccuracy }}%</span>
                    </div>
                  </div>
                </div>
                <div v-else class="panel-empty">
                  <p>No openings tracked yet. Play and analyze a few more games to see your most common openings here.</p>
                </div>
              </template>

              <!-- HEATMAP TAB -->
              <template v-if="activeTab === 'heatmap'">
                <div class="heatmap-panel">
                  <div class="heatmap-header">
                    <h3 class="section-subtitle">Blunder &amp; Mistake Heatmap</h3>
                    <span class="heatmap-total">{{ totalBlunders }} total bad moves mapped</span>
                  </div>

                  <div v-if="totalBlunders === 0" class="panel-empty">
                    <p>No mistakes mapped yet — nice, or just early days. This fills in as you analyze more games.</p>
                  </div>

                  <template v-else>
                    <div class="heatmap-board-wrapper">
                      <div class="heatmap-board">
                        <div class="heatmap-rank-labels" aria-hidden="true">
                          <span v-for="r in 8" :key="r">{{ 9 - r }}</span>
                        </div>
                        <div class="heatmap-grid-area">
                          <div class="heatmap-row" v-for="row in boardSquares" :key="row[0].sq[1]">
                            <button
                              v-for="sq in row"
                              :key="sq.sq"
                              type="button"
                              class="heatmap-square"
                              :class="{
                                light: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 === 0,
                                dark: (sq.sq.charCodeAt(0) + sq.sq.charCodeAt(1)) % 2 !== 0,
                                active: sq.intensity > 0,
                                selected: selectedSquare?.sq === sq.sq
                              }"
                              :style="{ '--intensity': sq.intensity }"
                              :aria-label="`${sq.sq}: ${sq.count} mistake${sq.count === 1 ? '' : 's'}`"
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

                    <!-- Tap-to-reveal readout, needed since :hover tooltips don't work on touch -->
                    <p class="heatmap-selected-readout" :class="{ visible: selectedSquare }">
                      <template v-if="selectedSquare">
                        <strong>{{ selectedSquare.sq }}</strong> — {{ selectedSquare.count }} mistake{{ selectedSquare.count === 1 ? '' : 's' }}
                      </template>
                      <template v-else>Tap a square to see its exact count.</template>
                    </p>

                    <p class="heatmap-info">Squares glow brighter red where you make the most mistakes. Use this to spot tactical blind spots in your games.</p>
                  </template>
                </div>
              </template>

              <!-- MOVE CLASSES TAB -->
              <template v-if="activeTab === 'moves'">
                <div class="move-bar-container" v-if="moveCountsBarSegments.length">
                  <div class="move-bar">
                    <div v-for="seg in moveCountsBarSegments" :key="seg.key" class="move-bar-segment" :style="{ width: seg.percent + '%', background: seg.meta.color }" :title="`${seg.meta.label}: ${seg.count} (${seg.percent.toFixed(1)}%)`"></div>
                  </div>
                </div>
                <div class="move-classes-grid">
                  <div v-for="(meta, key) in classificationMeta" :key="key" class="move-class-box">
                    <img :src="meta.icon" class="mc-icon-img" :alt="meta.label" />
                    <span class="mc-label" :style="{ color: meta.color }">{{ meta.label }}</span>
                    <span class="mc-count">{{ moveCounts[key] }}</span>
                    <span class="mc-percent" v-if="moveCountsTotal">{{ ((moveCounts[key] / moveCountsTotal) * 100).toFixed(1) }}%</span>
                  </div>
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

  /*
    Fallback accuracy-color tokens.
    These are only defaults — if the project's theme system (data-theme + :root vars)
    already defines --acc-brilliant etc. per theme, those win. This just guarantees
    the component never falls back to a hardcoded hex that ignores the active theme.
  */
  .page-layout {
    --acc-brilliant: #03aea7;
    --acc-great: #8eae83;
    --acc-great-alt: #4c8cb5;
    --acc-best: #6ad13f;
    --acc-book: #ad8760;
    --acc-excellent: #90bc36;
    --acc-good: #f2bc43;
    --acc-inaccuracy: #f2bc43;
    --acc-mistake: #f38800;
    --acc-blunder: #FF0000;
    --acc-na: #666;
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
    .page-layout { grid-template-columns: auto 1fr; gap: 1.5rem; }
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

  @keyframes spinRing { to { transform: rotate(360deg); } }

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

  .tab-nav-wrapper::-webkit-scrollbar { display: none; }

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

  .tab-btn:hover { color: #f4f0e3; }

  .tab-btn:focus-visible {
    outline: 2px solid var(--text-highlight, #f4f0e3);
    outline-offset: 2px;
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
    transition: opacity 0.15s ease;
  }

  .tab-panel.is-switching { opacity: 0.4; }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(5px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .hero-card {
    display: flex;
    background: rgba(0,0,0,0.25);
    border-radius: 16px;
    padding: 1.5rem;
    gap: 1.5rem;
    align-items: center;
    justify-content: space-between;
    border: 1px solid rgba(255,255,255,0.05);
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

  .hero-icon { width: 36px; height: 36px; }

  .hero-value {
    font-family: "JetBrains Mono", monospace;
    font-size: 2.4rem;
    font-weight: 700;
  }

  .hero-divider {
    width: 1px;
    height: 60px;
    background: rgba(255,255,255,0.1);
  }

  .hero-secondary { display: flex; gap: 2rem; }

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

  .trend-pill.up { color: #8fd97a; }
  .trend-pill.down { color: #ff8a80; }
  .trend-pill.flat { color: rgba(244, 240, 227, 0.6); }

  .stat-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: rgba(244, 240, 227, 0.6);
  }

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

  .phase-icon-img { width: 32px; height: 32px; }

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
    box-shadow: 0 0 8px rgba(255,255,255,0.1);
  }

  .phase-bar-empty {
    height: 100%;
    width: 100%;
    background: repeating-linear-gradient(
      45deg,
      rgba(255,255,255,0.03),
      rgba(255,255,255,0.03) 6px,
      transparent 6px,
      transparent 12px
    );
  }

  .phase-footer {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .phase-n { font-size: 0.75rem; color: rgba(244, 240, 227, 0.5); }

  .phase-val {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.4rem;
    font-weight: 700;
  }

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

  .opening-row:hover { border-color: rgba(255, 255, 255, 0.1); }

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
    background: rgba(255,255,255,0.05);
    padding: 0.3rem 0.6rem;
    border-radius: 8px;
  }

  .opening-acc-icon { width: 20px; height: 20px; }

  .opening-acc {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.9rem;
    font-weight: 700;
  }

  .heatmap-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .heatmap-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    width: 100%;
    max-width: 500px;
  }

  .section-subtitle {
    font-family: serif;
    color: #f5f5dc;
    font-size: 1.1rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin: 0;
  }

  .heatmap-total {
    font-size: 0.8rem;
    color: rgba(244,240,227,0.5);
    font-family: "JetBrains Mono", monospace;
  }

  .heatmap-board-wrapper {
    width: 100%;
    max-width: 500px;
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
    color: rgba(244,240,227,0.4);
    font-size: 0.8rem;
    font-family: "JetBrains Mono", monospace;
  }

  .heatmap-grid-area {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .heatmap-row { display: flex; flex: 1; }

  .heatmap-square {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1rem;
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

  .heatmap-square.active {
    background: color-mix(in srgb, var(--acc-blunder, #ff2828) calc(var(--intensity) * 60%), var(--board-dark));
    box-shadow: inset 0 0 15px color-mix(in srgb, var(--acc-blunder, red) calc(var(--intensity) * 80%), transparent);
    animation: pulseGlow 2s infinite alternate;
  }

  .heatmap-square.light.active {
    background: color-mix(in srgb, var(--acc-blunder, #ff2828) calc(var(--intensity) * 60%), var(--board-light));
  }

  @keyframes pulseGlow {
    from { filter: brightness(0.95); }
    to { filter: brightness(1.15); }
  }

  .heatmap-square:hover,
  .heatmap-square:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
    z-index: 2;
    transform: scale(1.05);
  }

  .heatmap-square:focus-visible {
    outline-color: var(--text-highlight, #fff);
  }

  .heatmap-square.selected {
    outline: 2px solid var(--text-highlight, #fff);
    outline-offset: -2px;
    z-index: 2;
  }

  .sq-count { text-shadow: 0 1px 4px rgba(0,0,0,0.8); z-index: 1; }

  .heatmap-file-labels {
    display: flex;
    justify-content: space-around;
    height: 12px;
    margin-top: 4px;
    color: rgba(244,240,227,0.4);
    font-size: 0.8rem;
    font-family: "JetBrains Mono", monospace;
  }

  .heatmap-selected-readout {
    text-align: center;
    font-size: 0.85rem;
    color: rgba(244, 240, 227, 0.5);
    margin: 1rem 0 0;
    min-height: 1.2em;
  }

  .heatmap-selected-readout.visible { color: #f5f5dc; }

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

  .move-bar-segment { height: 100%; transition: width 0.5s ease; }

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

  .move-class-box:hover { transform: translateY(-2px); }

  .mc-icon-img { width: 36px; height: 36px; }

  .mc-label { font-size: 0.8rem; font-weight: 600; }

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

  @media (max-width: 600px) {
    .hero-card { flex-direction: column; gap: 1rem; }
    .hero-divider { width: 100%; height: 1px; }
    .hero-secondary { width: 100%; justify-content: space-between; gap: 1rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .heatmap-square.active { animation: none; }
    .tab-panel { animation: none; }
  }
</style>