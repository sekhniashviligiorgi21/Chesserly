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

  // --- Computed Statistics ---
  const totalGames = computed(() => insights.value.length)
  const totalMoves = computed(() => insights.value.reduce((sum, game) => sum + (game.totalMoves || 0), 0))
  
  const overallAccuracy = computed(() => {
    const gamesWithAcc = insights.value.filter(g => g.overallAccuracy !== null)
    if (gamesWithAcc.length === 0) return null
    const sum = gamesWithAcc.reduce((acc, g) => acc + g.overallAccuracy, 0)
    return (sum / gamesWithAcc.length).toFixed(1)
  })

  const phaseAccuracy = computed(() => {
    const phases = { opening: [], middlegame: [], endgame: [] }
    insights.value.forEach(g => {
      if (g.phaseAccuracy) {
        if (g.phaseAccuracy.opening !== null) phases.opening.push(g.phaseAccuracy.opening)
        if (g.phaseAccuracy.middlegame !== null) phases.middlegame.push(g.phaseAccuracy.middlegame)
        if (g.phaseAccuracy.endgame !== null) phases.endgame.push(g.phaseAccuracy.endgame)
      }
    })
    return {
      opening: phases.opening.length ? (phases.opening.reduce((a,b) => a+b, 0) / phases.opening.length).toFixed(1) : null,
      middlegame: phases.middlegame.length ? (phases.middlegame.reduce((a,b) => a+b, 0) / phases.middlegame.length).toFixed(1) : null,
      endgame: phases.endgame.length ? (phases.endgame.reduce((a,b) => a+b, 0) / phases.endgame.length).toFixed(1) : null,
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

  // Calculate Win/Loss/Draw
  const results = computed(() => {
    const res = { win: 0, loss: 0, draw: 0 }
    insights.value.forEach(g => {
      // Basic guess based on data we have (this can be improved by saving result to insights)
      // For now, we just track total games. You can expand on this later.
    })
    return res
  })

  // Top 5 Openings
  const topOpenings = computed(() => {
    const counts = {}
    insights.value.forEach(g => {
      const name = g.opening || "Unknown"
      if (!counts[name]) counts[name] = { name, count: 0, accuracy: [] }
      counts[name].count++
      if (g.overallAccuracy !== null) counts[name].accuracy.push(g.overallAccuracy)
    })
    
    return Object.values(counts)
      .map(o => ({
        name: o.name,
        count: o.count,
        avgAccuracy: o.accuracy.length ? (o.accuracy.reduce((a,b) => a+b, 0) / o.accuracy.length).toFixed(1) : null
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  })

  const classificationMeta = {
    brilliant:  { label: 'Brilliant',  color: '#03aea7', icon: '!!' },
    great:      { label: 'Great',      color: '#4c8cb5', icon: '!' },
    best:       { label: 'Best',       color: '#6ad13f', icon: '★' },
    book:       { label: 'Book',       color: '#ad8760', icon: '📖' },
    excellent:  { label: 'Excellent',  color: '#90bc36', icon: '✓' },
    good:       { label: 'Good',       color: '#8eae83', icon: '✓' },
    inaccuracy: { label: 'Inaccuracy', color: '#f2bc43', icon: '?!' },
    mistake:    { label: 'Mistake',    color: '#f38800', icon: '?' },
    blunder:    { label: 'Blunder',    color: '#FF0000', icon: '??' }
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

        <div v-else class="insights-grid">
          <!-- Top Stats Row -->
          <div class="stat-row">
            <div class="stat-box">
              <span class="stat-label">Games Analyzed</span>
              <span class="stat-value">{{ totalGames }}</span>
            </div>
            <div class="stat-box">
              <span class="stat-label">Moves Tracked</span>
              <span class="stat-value">{{ totalMoves }}</span>
            </div>
            <div class="stat-box highlight">
              <span class="stat-label">Overall Accuracy</span>
              <span class="stat-value">{{ overallAccuracy !== null ? overallAccuracy + '%' : '—' }}</span>
            </div>
          </div>

          <!-- Phase Accuracy -->
          <div class="section">
            <h2 class="section-title">Accuracy by Game Phase</h2>
            <div class="phase-grid">
              <div class="phase-box">
                <span class="phase-name">Opening</span>
                <div class="phase-bar-container">
                  <div class="phase-bar" :style="{ width: (phaseAccuracy.opening || 0) + '%', background: '#7ec8e3' }"></div>
                </div>
                <span class="phase-val">{{ phaseAccuracy.opening !== null ? phaseAccuracy.opening + '%' : '—' }}</span>
              </div>
              <div class="phase-box">
                <span class="phase-name">Middlegame</span>
                <div class="phase-bar-container">
                  <div class="phase-bar" :style="{ width: (phaseAccuracy.middlegame || 0) + '%', background: '#f0d0a3' }"></div>
                </div>
                <span class="phase-val">{{ phaseAccuracy.middlegame !== null ? phaseAccuracy.middlegame + '%' : '—' }}</span>
              </div>
              <div class="phase-box">
                <span class="phase-name">Endgame</span>
                <div class="phase-bar-container">
                  <div class="phase-bar" :style="{ width: (phaseAccuracy.endgame || 0) + '%', background: '#a8d97a' }"></div>
                </div>
                <span class="phase-val">{{ phaseAccuracy.endgame !== null ? phaseAccuracy.endgame + '%' : '—' }}</span>
              </div>
            </div>
          </div>

          <!-- Move Classifications -->
          <div class="section">
            <h2 class="section-title">Total Move Classifications</h2>
            <div class="move-classes">
              <div v-for="(meta, key) in classificationMeta" :key="key" class="move-class-box">
                <span class="mc-icon" :style="{ color: meta.color }">{{ meta.icon }}</span>
                <span class="mc-label" :style="{ color: meta.color }">{{ meta.label }}</span>
                <span class="mc-count">{{ moveCounts[key] }}</span>
              </div>
            </div>
          </div>

          <!-- Top Openings -->
          <div class="section">
            <h2 class="section-title">Your Most Played Openings</h2>
            <div class="openings-list">
              <div v-for="(opening, i) in topOpenings" :key="i" class="opening-row">
                <span class="opening-rank">#{{ i + 1 }}</span>
                <span class="opening-name">{{ opening.name }}</span>
                <span class="opening-games">{{ opening.count }} games</span>
                <span class="opening-acc" v-if="opening.avgAccuracy">{{ opening.avgAccuracy }}% acc</span>
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
    max-width: 1400px;
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
    gap: 2rem;
    padding: clamp(1.5rem, 3vw, 2.5rem);
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    background: linear-gradient(145deg, var(--panel-1), var(--panel-2));
    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .card-header { text-align: center; }

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
    gap: 1rem;
    padding: 4rem 2rem;
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

  .insights-grid {
    display: flex;
    flex-direction: column;
    gap: 2.5rem;
  }

  .stat-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
  }

  .stat-box {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    padding: 1.5rem 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .stat-box.highlight {
    border-color: var(--text-highlight);
    background: rgba(217, 179, 130, 0.05);
  }

  .stat-label {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: rgba(244, 240, 227, 0.6);
  }

  .stat-value {
    font-family: "JetBrains Mono", monospace;
    font-size: 2rem;
    font-weight: 700;
    color: #f5f5dc;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .section-title {
    font-family: serif;
    color: #f5f5dc;
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .phase-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .phase-box {
    display: grid;
    grid-template-columns: 100px 1fr 50px;
    align-items: center;
    gap: 1rem;
  }

  .phase-name { font-size: 0.9rem; font-weight: 600; color: rgba(244, 240, 227, 0.8); }
  
  .phase-bar-container {
    height: 10px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 5px;
    overflow: hidden;
  }

  .phase-bar {
    height: 100%;
    border-radius: 5px;
    transition: width 0.5s ease;
  }

  .phase-val {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.9rem;
    font-weight: 700;
    text-align: right;
    color: #f5f5dc;
  }

  .move-classes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 0.75rem;
  }

  .move-class-box {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 10px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .mc-icon { font-size: 1.5rem; font-weight: 700; }
  .mc-label { font-size: 0.75rem; font-weight: 600; }
  .mc-count { font-family: "JetBrains Mono", monospace; font-size: 1.2rem; font-weight: 700; color: #f5f5dc; margin-top: 0.25rem; }

  .openings-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .opening-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    border: 1px solid transparent;
    transition: border-color 0.2s;
  }
  .opening-row:hover { border-color: rgba(255, 255, 255, 0.1); }

  .opening-rank {
    font-family: "JetBrains Mono", monospace;
    font-weight: 700;
    color: rgba(244, 240, 227, 0.5);
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
    color: rgba(244, 240, 227, 0.6);
    font-size: 0.85rem;
  }

  .opening-acc {
    font-family: "JetBrains Mono", monospace;
    color: #a8d97a;
    font-size: 0.85rem;
    font-weight: 700;
    background: rgba(106, 209, 63, 0.1);
    padding: 0.2rem 0.5rem;
    border-radius: 6px;
  }
</style>