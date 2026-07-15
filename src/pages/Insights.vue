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
  const activeTab = ref('overview') // 'overview', 'phases', 'openings', 'moves'

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
        collection(db, `users/${currentUser.value.uid}/insights`),
        orderBy('createdAt', 'desc')
      )
      const querySnapshot = await getDocs(q)
      insights.value = querySnapshot.docs.map(doc => doc.data())
    } catch (e) {
      console.error("Failed to load insights:", e)
    }
  }

  // --- Helper: Map Accuracy to Classification ---
  function getAccuracyMeta(acc) {
    if (acc === null || acc === undefined) return { label: 'N/A', icon: null, color: '#666' }
    if (acc >= 95) return { label: 'Brilliant', icon: '/moveClassifications/brilliant.png', color: '#03aea7' }
    if (acc >= 90) return { label: 'Good', icon: '/moveClassifications/good.png', color: '#8eae83' }
    if (acc >= 80) return { label: 'Best', icon: '/moveClassifications/best.png', color: '#6ad13f' }
    if (acc >= 70) return { label: 'Excellent', icon: '/moveClassifications/excellent.png', color: '#90bc36' }
    if (acc >= 60) return { label: 'Inaccuracy', icon: '/moveClassifications/inaccuracy.png', color: '#f2bc43' }
    if (acc >= 50) return { label: 'Mistake', icon: '/moveClassifications/mistake.png', color: '#f38800' }
    return { label: 'Blunder', icon: '/moveClassifications/blunder.png', color: '#FF0000' }
  }

  // --- Computed Statistics ---
  const totalGames = computed(() => insights.value.length)
  const totalMoves = computed(() => insights.value.reduce((sum, game) => sum + (game.totalMoves || 0), 0))
  
  const overallAccuracy = computed(() => {
    const gamesWithAcc = insights.value.filter(g => g.overallAccuracy !== null)
    if (gamesWithAcc.length === 0) return null
    const sum = gamesWithAcc.reduce((acc, g) => acc + g.overallAccuracy, 0)
    return (sum / gamesWithAcc.length).toFixed(1)
  })

  const overallMeta = computed(() => getAccuracyMeta(overallAccuracy.value ? parseFloat(overallAccuracy.value) : null))

  const phaseAccuracy = computed(() => {
    const phases = { opening: [], middlegame: [], endgame: [] }
    insights.value.forEach(g => {
      if (g.phaseAccuracy) {
        if (g.phaseAccuracy.opening !== null) phases.opening.push(g.phaseAccuracy.opening)
        if (g.phaseAccuracy.middlegame !== null) phases.middlegame.push(g.phaseAccuracy.middlegame)
        if (g.phaseAccuracy.endgame !== null) phases.endgame.push(g.phaseAccuracy.endgame)
      }
    })
    
    const calc = (arr) => arr.length ? (arr.reduce((a,b) => a+b, 0) / arr.length).toFixed(1) : null
    
    let oAcc = calc(phases.opening)
    let mAcc = calc(phases.middlegame)
    let eAcc = calc(phases.endgame)

    return {
      opening: { val: oAcc, meta: getAccuracyMeta(oAcc ? parseFloat(oAcc) : null) },
      middlegame: { val: mAcc, meta: getAccuracyMeta(mAcc ? parseFloat(mAcc) : null) },
      endgame: { val: eAcc, meta: getAccuracyMeta(eAcc ? parseFloat(eAcc) : null) }
    }
  })

  const moveCounts = computed(() => {
    const totals = { brilliant: 0, great: 0, best: 0, book: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }
    insights.value.forEach(g => {
      if (g.moveCounts) {
        for (const key in totals) {
          totals[key] += g.moveCounts[key] || 0
        }
      }
    })
    return totals
  })

  // Top 5 Openings (Fixed Unknown Opening)
  const topOpenings = computed(() => {
    const counts = {}
    insights.value.forEach(g => {
      // Safely fallback to Unrecognized Opening
      const name = g.opening && g.opening !== "Unknown Opening" ? g.opening : "Unrecognized Opening"
      if (!counts[name]) counts[name] = { name, count: 0, accuracy: [] }
      counts[name].count++
      if (g.overallAccuracy !== null) counts[name].accuracy.push(g.overallAccuracy)
    })
    
    return Object.values(counts)
      .map(o => ({
        name: o.name,
        count: o.count,
        avgAccuracy: o.accuracy.length ? (o.accuracy.reduce((a,b) => a+b, 0) / o.accuracy.length).toFixed(1) : null,
        meta: o.accuracy.length ? getAccuracyMeta(parseFloat((o.accuracy.reduce((a,b) => a+b, 0) / o.accuracy.length).toFixed(1))) : getAccuracyMeta(null)
      }))
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

  function setTab(tab) {
    activeTab.value = tab
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
          <div class="spinner"></div>
          <p>Crunching the numbers...</p>
        </div>

        <div v-else-if="!currentUser" class="empty-state">
          <p>Please log in to view your insights.</p>
        </div>

        <div v-else-if="insights.length === 0" class="empty-state">
          <p>No data yet. Analyze a game to start building your insights!</p>
        </div>

        <div v-else class="dashboard-layout">
          <!-- LEFT COLUMN: Tabbed Content -->
          <div class="main-column">
            <!-- Tab Navigation -->
            <div class="tab-nav">
              <button class="tab-btn" :class="{ active: activeTab === 'overview' }" @click="setTab('overview')">Overview</button>
              <button class="tab-btn" :class="{ active: activeTab === 'phases' }" @click="setTab('phases')">Phases</button>
              <button class="tab-btn" :class="{ active: activeTab === 'openings' }" @click="setTab('openings')">Openings</button>
              <button class="tab-btn" :class="{ active: activeTab === 'moves' }" @click="setTab('moves')">Move Classes</button>
            </div>

            <div class="tab-content-area">
              <!-- OVERVIEW TAB -->
              <div v-if="activeTab === 'overview'" class="tab-panel">
                <div class="stat-row">
                  <div class="stat-box">
                    <span class="stat-label">Games Analyzed</span>
                    <span class="stat-value">{{ totalGames }}</span>
                  </div>
                  <div class="stat-box">
                    <span class="stat-label">Moves Tracked</span>
                    <span class="stat-value">{{ totalMoves }}</span>
                  </div>
                  <div class="stat-box highlight" :style="{ borderColor: overallMeta.color, background: overallMeta.color + '10' }">
                    <span class="stat-label">Overall Accuracy</span>
                    <div class="stat-icon-row">
                      <img v-if="overallMeta.icon" :src="overallMeta.icon" class="stat-icon-img" />
                      <span class="stat-value" :style="{ color: overallMeta.color }">{{ overallAccuracy !== null ? overallAccuracy + '%' : '—' }}</span>
                    </div>
                  </div>
                </div>
                <div class="quick-glance-phases">
                  <div class="mini-phase">
                    <span>Opening</span>
                    <strong :style="{color: phaseAccuracy.opening.meta.color}">{{ phaseAccuracy.opening.val ? phaseAccuracy.opening.val + '%' : '—' }}</strong>
                  </div>
                  <div class="mini-phase">
                    <span>Middlegame</span>
                    <strong :style="{color: phaseAccuracy.middlegame.meta.color}">{{ phaseAccuracy.middlegame.val ? phaseAccuracy.middlegame.val + '%' : '—' }}</strong>
                  </div>
                  <div class="mini-phase">
                    <span>Endgame</span>
                    <strong :style="{color: phaseAccuracy.endgame.meta.color}">{{ phaseAccuracy.endgame.val ? phaseAccuracy.endgame.val + '%' : '—' }}</strong>
                  </div>
                </div>
              </div>

              <!-- PHASES TAB -->
              <div v-if="activeTab === 'phases'" class="tab-panel">
                <div class="phase-grid">
                  <div class="phase-box" v-for="(phase, key) in phaseAccuracy" :key="key">
                    <div class="phase-header">
                      <span class="phase-name">{{ key.charAt(0).toUpperCase() + key.slice(1) }}</span>
                      <img v-if="phase.meta.icon" :src="phase.meta.icon" class="phase-icon-img" />
                    </div>
                    <div class="phase-bar-container">
                      <div class="phase-bar" :style="{ width: (phase.val || 0) + '%', background: `linear-gradient(90deg, ${phase.meta.color}aa, ${phase.meta.color})` }"></div>
                    </div>
                    <span class="phase-val" :style="{ color: phase.meta.color }">{{ phase.val !== null ? phase.val + '%' : '—' }}</span>
                  </div>
                </div>
              </div>

              <!-- OPENINGS TAB -->
              <div v-if="activeTab === 'openings'" class="tab-panel">
                <div class="openings-list">
                  <div v-for="(opening, i) in topOpenings" :key="i" class="opening-row">
                    <span class="opening-rank">#{{ i + 1 }}</span>
                    <span class="opening-name">{{ opening.name }}</span>
                    <span class="opening-games">{{ opening.count }} games</span>
                    <div class="opening-acc-container" v-if="opening.avgAccuracy">
                      <img :src="opening.meta.icon" class="opening-acc-icon" />
                      <span class="opening-acc" :style="{color: opening.meta.color}">{{ opening.avgAccuracy }}%</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- MOVE CLASSES TAB -->
              <div v-if="activeTab === 'moves'" class="tab-panel">
                <div class="move-classes-grid">
                  <div v-for="(meta, key) in classificationMeta" :key="key" class="move-class-box">
                    <img :src="meta.icon" class="mc-icon-img" :alt="meta.label" />
                    <span class="mc-label" :style="{ color: meta.color }">{{ meta.label }}</span>
                    <span class="mc-count">{{ moveCounts[key] }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- RIGHT COLUMN: Sticky Summary -->
          <div class="side-column">
            <div class="sticky-section">
              <h2 class="section-title">Summary</h2>
              <div class="summary-card">
                <div class="summary-item">
                  <span class="summary-label">Total Games</span>
                  <span class="summary-value">{{ totalGames }}</span>
                </div>
                <div class="summary-item">
                  <span class="summary-label">Total Moves</span>
                  <span class="summary-value">{{ totalMoves }}</span>
                </div>
                <div class="summary-item highlight" :style="{ borderColor: overallMeta.color }">
                  <span class="summary-label">Overall Acc.</span>
                  <div class="summary-acc-row">
                    <img v-if="overallMeta.icon" :src="overallMeta.icon" class="summary-icon" />
                    <span class="summary-value" :style="{ color: overallMeta.color }">{{ overallAccuracy !== null ? overallAccuracy + '%' : '—' }}</span>
                  </div>
                </div>
              </div>
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
    height: calc(100vh - 2rem); /* Fix height to prevent page scroll */
    max-height: 900px;
    overflow: hidden; /* Let inner columns handle scroll */
  }

  .card-header { text-align: center; flex-shrink: 0; }

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

  .insights-subtitle { color: rgba(244, 240, 227, 0.72); font-size: 0.95rem; margin: 0; }

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

  .spinner {
    width: 2rem; height: 2rem;
    border-radius: 50%;
    border: 3px solid rgba(244, 240, 227, 0.2);
    border-top-color: var(--text-highlight);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Dashboard Layout */
  .dashboard-layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2rem;
    flex: 1;
    min-height: 0; /* Crucial for nested scrolling */
  }

  @media (min-width: 900px) {
    .dashboard-layout {
      grid-template-columns: 2fr 1fr;
      align-items: stretch;
    }
  }

  .main-column {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-height: 0;
    overflow: hidden;
  }

  .tab-nav {
    display: flex;
    gap: 0.5rem;
    background: rgba(0, 0, 0, 0.2);
    padding: 0.4rem;
    border-radius: 12px;
    flex-shrink: 0;
  }

  .tab-btn {
    flex: 1;
    padding: 0.6rem 1rem;
    background: transparent;
    border: none;
    color: rgba(244, 240, 227, 0.6);
    font-weight: 600;
    font-size: 0.9rem;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.2s ease;
  }

  .tab-btn:hover { color: #f4f0e3; }

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
  }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

  /* Stats */
  .stat-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 1rem;
  }

  .stat-box {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    padding: 1.2rem 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .stat-box.highlight { border-color: var(--text-highlight); }

  .stat-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: rgba(244, 240, 227, 0.6);
  }

  .stat-value {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.8rem;
    font-weight: 700;
    color: #f5f5dc;
  }

  .stat-icon-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .stat-icon-img {
    width: 28px;
    height: 28px;
  }

  .quick-glance-phases {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
    margin-top: 0.5rem;
  }

  .mini-phase {
    background: rgba(0,0,0,0.2);
    padding: 1rem;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }
  .mini-phase span { font-size: 0.75rem; color: rgba(244,240,227,0.6); text-transform: uppercase; }
  .mini-phase strong { font-size: 1.1rem; font-family: "JetBrains Mono", monospace; }

  /* Phases Tab */
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

  .phase-name { font-size: 1.1rem; font-weight: 600; color: rgba(244, 240, 227, 0.9); text-transform: capitalize; }
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

  .phase-val {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.4rem;
    font-weight: 700;
    text-align: right;
  }

  /* Openings Tab */
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

  /* Move Classes Tab */
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
    gap: 0.5rem;
    transition: transform 0.2s;
  }
  .move-class-box:hover { transform: translateY(-2px); }

  .mc-icon-img { width: 36px; height: 36px; }
  .mc-label { font-size: 0.8rem; font-weight: 600; }
  .mc-count { font-family: "JetBrains Mono", monospace; font-size: 1.5rem; font-weight: 700; color: #f5f5dc; margin-top: 0.25rem; }

  /* Sticky Right Column */
  .side-column {
    display: flex;
    flex-direction: column;
  }

  .sticky-section {
    position: sticky;
    top: 0;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 14px;
    padding: 1.5rem;
    height: fit-content;
  }

  .section-title {
    font-family: serif;
    color: #f5f5dc;
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0 0 1rem 0;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .summary-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .summary-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 0.5rem;
    border-radius: 8px;
  }
  
  .summary-item.highlight {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.1);
    padding: 1rem 0.75rem;
  }

  .summary-label {
    font-size: 0.85rem;
    color: rgba(244,240,227,0.7);
    font-weight: 600;
  }

  .summary-value {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.2rem;
    font-weight: 700;
    color: #f5f5dc;
  }

  .summary-acc-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .summary-icon {
    width: 24px;
    height: 24px;
  }
</style>