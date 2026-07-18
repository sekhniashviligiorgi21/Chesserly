<script setup>
  import { ref, shallowRef, computed, onMounted, watch } from 'vue'
  import Title from '../assets/Title.vue'
  import { auth, db } from '../firebase'
  import { onAuthStateChanged } from 'firebase/auth'
  import { collection, query, getDocs, doc, getDoc, setDoc } from 'firebase/firestore'
  import { Chess } from 'chess.js'
  import { TheChessboard } from 'vue3-chessboard'
  import 'vue3-chessboard/style.css'

  const currentTheme = ref(localStorage.getItem('chesslab_theme') || 'brown')
  watch(currentTheme, (newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('chesslab_theme', newTheme)
  }, { immediate: true })

  const currentUser = ref(null)
  const allPuzzles = ref([])
  const loading = ref(true)

  const currentPuzzle = shallowRef(null)
  const status = ref('idle') // 'idle' | 'wrong' | 'correct' | 'revealed'
  const message = ref('Find the best move for your side.')

  // The single graded try. Everything after this is free practice.
  const firstAttemptMade = ref(false)
  const revealed = computed(() => status.value !== 'idle')

  const userRating = ref(Number(localStorage.getItem('chesslab_puzzle_rating')) || 1200)
  const boardAPI = shallowRef(null)
  const isFlipped = ref(false)

  // ---- Session stats ----
  const sessionStats = ref({ attempted: 0, solved: 0, streak: 0 })
  const bestStreak = ref(Number(localStorage.getItem('chesslab_puzzle_best_streak')) || 0)

  // ---- No-repeat queue ----
  const puzzleQueue = ref([])
  const roundSize = ref(0)

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown)
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser.value = user
        await fetchRating()
        await fetchPuzzles()
      } else {
        currentUser.value = null
        allPuzzles.value = []
      }
      loading.value = false
    })
  })

  function handleKeyDown(e) {
    if (!currentPuzzle.value) return
    if (e.key === 'Enter' && revealed.value) { loadNextPuzzle(); return }
    if ((e.key === 'h' || e.key === 'H') && status.value !== 'correct') { showSolution() }
  }

  async function fetchPuzzles() {
    if (!currentUser.value) return
    try {
      const q = query(collection(db, `users/${currentUser.value.uid}/games`))
      const snap = await getDocs(q)
      let temp = []

      snap.forEach(doc => {
        const data = doc.data()
        if (data.puzzles && Array.isArray(data.puzzles)) {
          data.puzzles.forEach((p, i) => {
            if (p.fen && p.bestMove) {
              temp.push({ ...p, id: `${doc.id}_${i}`, gameId: doc.id })
            }
          })
        }
      })

      allPuzzles.value = temp
      roundSize.value = temp.length
      if (allPuzzles.value.length > 0) {
        buildQueue()
        loadNextPuzzle()
      } else {
        message.value = 'No puzzles generated yet. Analyze your games to find your blunders!'
      }
    } catch (e) {
      console.error("Failed to fetch puzzles:", e)
    }
  }

  async function fetchRating() {
    if (!currentUser.value) return
    try {
      const statRef = doc(db, `users/${currentUser.value.uid}/stats/puzzle`)
      const statSnap = await getDoc(statRef)
      if (statSnap.exists()) {
        userRating.value = statSnap.data().rating || 1200
      } else {
        await setDoc(statRef, { rating: userRating.value })
      }
      localStorage.setItem('chesslab_puzzle_rating', String(userRating.value))
    } catch (e) {
      console.error("Failed to fetch rating:", e)
    }
  }

  async function updateRating(delta) {
    userRating.value += delta
    localStorage.setItem('chesslab_puzzle_rating', String(userRating.value))
    if (currentUser.value) {
      try {
        const statRef = doc(db, `users/${currentUser.value.uid}/stats/puzzle`)
        await setDoc(statRef, { rating: userRating.value }, { merge: true })
      } catch (e) {
        console.error("Failed to update rating:", e)
      }
    }
  }

  // ---- Queue management: never repeat a puzzle until the whole set has been shown ----
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }

  function buildQueue() {
    puzzleQueue.value = shuffle(allPuzzles.value.map((_, i) => i))
  }

  function loadNextPuzzle() {
    if (allPuzzles.value.length === 0) return

    if (puzzleQueue.value.length === 0) {
      buildQueue()
      // Avoid immediately repeating the puzzle we just finished when the round wraps.
      const lastIdx = currentPuzzle.value ? allPuzzles.value.indexOf(currentPuzzle.value) : -1
      if (lastIdx !== -1 && puzzleQueue.value.length > 1 && puzzleQueue.value[0] === lastIdx) {
        const swapWith = 1 + Math.floor(Math.random() * (puzzleQueue.value.length - 1))
        ;[puzzleQueue.value[0], puzzleQueue.value[swapWith]] = [puzzleQueue.value[swapWith], puzzleQueue.value[0]]
      }
    }

    const idx = puzzleQueue.value.shift()
    currentPuzzle.value = allPuzzles.value[idx]

    status.value = 'idle'
    firstAttemptMade.value = false
    message.value = `Find the best move for ${currentPuzzle.value.turn === 'white' ? 'White' : 'Black'}.`

    const tempChess = new Chess(currentPuzzle.value.fen)
    const shouldBeFlipped = tempChess.turn() === 'b'

    if (boardAPI.value) {
      if (shouldBeFlipped !== isFlipped.value) {
        boardAPI.value.toggleOrientation()
        isFlipped.value = shouldBeFlipped
      }
      boardAPI.value.setPosition(currentPuzzle.value.fen)
      boardAPI.value.hideMoves()
    }
  }

  function onBoardCreated(api) {
    boardAPI.value = api
    if (currentPuzzle.value) {
      boardAPI.value.setPosition(currentPuzzle.value.fen)
    }
  }

  // ---- SAN helpers for showing "you played X" / "best was Y" ----
  function sanForMove(fen, uci) {
    if (!fen || !uci) return ''
    try {
      const tmp = new Chess(fen)
      const from = uci.slice(0, 2)
      const to = uci.slice(2, 4)
      const promotion = uci.length > 4 ? uci[4] : undefined
      const mv = tmp.move({ from, to, promotion })
      return mv ? mv.san : uci
    } catch (e) {
      return uci
    }
  }

  const bestMoveSan = computed(() =>
    currentPuzzle.value ? sanForMove(currentPuzzle.value.fen, currentPuzzle.value.bestMove) : ''
  )
  const playedMoveSan = computed(() =>
    currentPuzzle.value?.playedMove ? sanForMove(currentPuzzle.value.fen, currentPuzzle.value.playedMove) : ''
  )

  const mistakeLabel = computed(() => {
    if (currentPuzzle.value?.mistakeType === 'blunder') return { text: 'Blunder', color: '#FF0000' }
    if (currentPuzzle.value?.mistakeType === 'mistake') return { text: 'Mistake', color: '#f38800' }
    return null
  })

  // ---- Eval bar ----
  function evalDisplay(evalObj) {
    if (!evalObj) return null
    let cpVal
    if (evalObj.type === 'mate') {
      cpVal = evalObj.value >= 0 ? 800 : -800
    } else {
      cpVal = Math.max(-800, Math.min(800, evalObj.value))
    }
    const height = 50 - (cpVal / 800) * 50
    const label = evalObj.type === 'mate' ? `M${evalObj.value}` : (evalObj.value / 100).toFixed(2)
    return { height, label }
  }

  const beforeEval = computed(() => currentPuzzle.value ? evalDisplay(currentPuzzle.value.evalBefore) : null)
  const afterEval = computed(() => currentPuzzle.value ? evalDisplay(currentPuzzle.value.evalAfter) : null)
  const hasEvalData = computed(() => !!(beforeEval.value || afterEval.value))

  // ---- Move handling ----
  function recordGradedAttempt(correct) {
    sessionStats.value.attempted++
    if (correct) {
      sessionStats.value.solved++
      sessionStats.value.streak++
      if (sessionStats.value.streak > bestStreak.value) {
        bestStreak.value = sessionStats.value.streak
        localStorage.setItem('chesslab_puzzle_best_streak', String(bestStreak.value))
      }
    } else {
      sessionStats.value.streak = 0
    }
  }

  function drawSolutionArrow() {
    if (!boardAPI.value || !currentPuzzle.value) return
    const from = currentPuzzle.value.bestMove.slice(0, 2)
    const to = currentPuzzle.value.bestMove.slice(2, 4)
    boardAPI.value.drawMove(from, to, 'green')
  }

  function handleMove(move) {
    if (!currentPuzzle.value || status.value === 'correct' || status.value === 'revealed') return

    const uci = move.promotion ? `${move.from}${move.to}${move.promotion}` : `${move.from}${move.to}`
    const isCorrect = uci === currentPuzzle.value.bestMove

    if (isCorrect) {
      status.value = 'correct'
      if (!firstAttemptMade.value) {
        firstAttemptMade.value = true
        recordGradedAttempt(true)
        message.value = 'Correct! +15 rating.'
        updateRating(15)
      } else {
        message.value = "Correct! (no rating change after a miss)"
      }
      return
    }

    // Wrong move
    boardAPI.value.setPosition(currentPuzzle.value.fen) // snap back, let them try again
    if (!firstAttemptMade.value) {
      firstAttemptMade.value = true
      recordGradedAttempt(false)
      status.value = 'wrong'
      message.value = 'Not the best move. −10 rating. Try again — no more points at stake.'
      updateRating(-10)
    } else {
      status.value = 'wrong'
      message.value = 'Still not it. Try again, or reveal the solution.'
    }
  }

  function showSolution() {
    if (!currentPuzzle.value || status.value === 'correct') return
    if (!firstAttemptMade.value) {
      firstAttemptMade.value = true
      recordGradedAttempt(false)
      updateRating(-10)
    }
    status.value = 'revealed'
    message.value = `The best move was ${bestMoveSan.value}.`
    boardAPI.value.setPosition(currentPuzzle.value.fen)
    drawSolutionArrow()
  }
</script>

<template>
  <div class="page-layout">
    <Title />
    <div class="content-area">
      <div class="puzzle-card">
        <div class="puzzle-header">
          <div>
            <h1 class="puzzle-title">Learn from your mistakes</h1>
            <p class="puzzle-subtitle">Train your tactical vision using positions from your own past blunders.</p>
          </div>
          <div class="header-badges">
            <div class="rating-badge">
              <span class="rating-label">Puzzle Rating</span>
              <span class="rating-value">🏆 {{ userRating }}</span>
            </div>
            <div class="streak-badge" v-if="sessionStats.attempted > 0">
              <span class="rating-label">Streak</span>
              <span class="rating-value streak-value">🔥 {{ sessionStats.streak }}</span>
            </div>
          </div>
        </div>

        <div v-if="loading" class="empty-state">
          <div class="loading-spinner"><div class="spinner-ring"></div><div class="spinner-ring"></div><div class="spinner-ring"></div></div>
          <p>Loading your puzzles...</p>
        </div>

        <div v-else-if="!currentUser" class="empty-state"><p>Please log in to access your puzzles.</p></div>

        <div v-else-if="allPuzzles.length === 0" class="empty-state">
          <p>No puzzles generated yet.</p>
          <p class="muted">Analyze your games to automatically generate puzzles from your blunders.</p>
        </div>

        <div v-else class="puzzle-interface">
          <div class="board-side">
            <div class="board-row">
              <div class="board-wrapper">
                <TheChessboard
                  class="game-board"
                  @move="handleMove"
                  @board-created="onBoardCreated"
                  :board-config="{ coordinates: true, animation: { enabled: false } }"
                />
              </div>

              <div class="puzzle-evalbar" v-if="revealed && hasEvalData">
                <div class="eval-col" v-if="afterEval">
                  <span class="eval-col-label">Actual</span>
                  <div class="mini-evalbar">
                    <template v-if="!isFlipped">
                      <div class="blackeval" :style="{ height: afterEval.height + '%' }"></div>
                      <div class="whiteeval" :style="{ height: (100 - afterEval.height) + '%' }"></div>
                    </template>
                    <template v-else>
                      <div class="whiteeval" :style="{ height: (100 - afterEval.height) + '%' }"></div>
                      <div class="blackeval" :style="{ height: afterEval.height + '%' }"></div>
                    </template>
                  </div>
                  <span class="eval-col-num">{{ afterEval.label }}</span>
                </div>
                <div class="eval-col" v-if="beforeEval">
                  <span class="eval-col-label">Best move</span>
                  <div class="mini-evalbar">
                    <template v-if="!isFlipped">
                      <div class="blackeval" :style="{ height: beforeEval.height + '%' }"></div>
                      <div class="whiteeval" :style="{ height: (100 - beforeEval.height) + '%' }"></div>
                    </template>
                    <template v-else>
                      <div class="whiteeval" :style="{ height: (100 - beforeEval.height) + '%' }"></div>
                      <div class="blackeval" :style="{ height: beforeEval.height + '%' }"></div>
                    </template>
                  </div>
                  <span class="eval-col-num">{{ beforeEval.label }}</span>
                </div>
              </div>
            </div>

            <div class="progress-line" v-if="allPuzzles.length">
              <span>Solved {{ sessionStats.solved }} / {{ sessionStats.attempted }} this session</span>
              <span class="dot-sep">·</span>
              <span>Best streak {{ bestStreak }}</span>
              <span class="dot-sep">·</span>
              <span>{{ puzzleQueue.length }} left this round</span>
            </div>
          </div>

          <div class="info-side">
            <div class="status-box" :class="status">
              <span v-if="mistakeLabel && revealed" class="mistake-tag" :style="{ color: mistakeLabel.color, borderColor: mistakeLabel.color }">
                {{ mistakeLabel.text }}
              </span>
              <p>{{ message }}</p>
            </div>

            <div class="puzzle-meta">
              <span class="meta-label">Side to move</span>
              <span class="meta-value">{{ currentPuzzle?.turn === 'white' ? 'White' : 'Black' }}</span>
            </div>

            <div class="puzzle-meta" v-if="revealed && playedMoveSan">
              <span class="meta-label">You played (in-game)</span>
              <span class="meta-value played-move">{{ playedMoveSan }}</span>
            </div>

            <div class="puzzle-meta" v-if="revealed">
              <span class="meta-label">Best move</span>
              <span class="meta-value best-move">{{ bestMoveSan }}</span>
            </div>

            <div class="action-buttons">
              <button
                v-if="status !== 'correct'"
                class="action-btn hint-btn"
                @click="showSolution"
              >
                Show Solution{{ firstAttemptMade ? '' : ' (−10)' }}
              </button>
              <button class="action-btn next-btn" @click="loadNextPuzzle">
                Next Puzzle →
              </button>
            </div>
            <p class="key-hint">Tip: press <kbd>H</kbd> for a hint, <kbd>Enter</kbd> for the next puzzle.</p>
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
    .page-layout { grid-template-columns: auto 1fr; gap: 1.5rem; }
  }

  .content-area { display: flex; justify-content: stretch; width: 100%; min-width: 0; }

  .puzzle-card {
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
  }

  .puzzle-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem; }

  .puzzle-title {
    font-family: serif;
    color: #f5f5dc;
    font-weight: 700;
    text-transform: uppercase;
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
    letter-spacing: 2px;
    font-size: clamp(1.3rem, 3vw, 1.7rem);
    margin: 0 0 0.4rem;
  }

  .puzzle-subtitle { color: rgba(244, 240, 227, 0.72); font-size: 0.9rem; margin: 0; }

  .header-badges { display: flex; gap: 0.6rem; flex-wrap: wrap; }

  .rating-badge, .streak-badge {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    background: rgba(0, 0, 0, 0.3);
    padding: 0.75rem 1.25rem;
    border-radius: 12px;
    border: 1px solid var(--text-highlight);
  }

  .streak-badge { border-color: #f38800; }

  .rating-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; color: rgba(244, 240, 227, 0.6); }

  .rating-value { font-family: "JetBrains Mono", monospace; font-size: 1.4rem; font-weight: 700; color: var(--text-highlight); }
  .streak-value { color: #f38800; }

  .empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    flex: 1; gap: 0.5rem; color: rgba(244, 240, 227, 0.6); font-size: 1rem; text-align: center; padding: 3rem 1rem;
  }

  .empty-state .muted { font-size: 0.85rem; color: rgba(244, 240, 227, 0.4); }

  .loading-spinner { position: relative; width: 56px; height: 56px; margin-bottom: 1rem; }
  .spinner-ring {
    position: absolute; inset: 0; border-radius: 50%; border: 3px solid transparent;
    border-top-color: var(--text-highlight); animation: spinRing 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }
  .spinner-ring:nth-child(2) { inset: 7px; border-top-color: #a8d97a; animation-duration: 1.6s; animation-direction: reverse; }
  .spinner-ring:nth-child(3) { inset: 14px; border-top-color: #f4f0e3; animation-duration: 2s; }
  @keyframes spinRing { to { transform: rotate(360deg); } }

  .puzzle-interface { display: flex; gap: 2rem; flex-wrap: wrap; align-items: flex-start; }

  .board-side { flex: 1 1 300px; min-width: 0; max-width: 600px; }

  .board-row { display: flex; gap: 0.6rem; align-items: stretch; }

  .board-wrapper {
    flex: 1;
    aspect-ratio: 1/1;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 15px 40px rgba(0, 0, 0, 0.4);
  }

  .game-board { width: 100% !important; height: 100% !important; }
  :deep(.cg-wrap) { width: 100% !important; height: 100% !important; }
  :deep(cg-board) {
    background: conic-gradient(
      var(--board-dark) 90deg, var(--board-light) 90deg 180deg,
      var(--board-dark) 180deg 270deg, var(--board-light) 270deg
    ) !important;
    background-size: 25% 25% !important;
  }

  .puzzle-evalbar { display: flex; gap: 0.35rem; flex-shrink: 0; }

  .eval-col { display: flex; flex-direction: column; align-items: center; gap: 0.25rem; width: 2.2rem; }

  .eval-col-label {
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.4px;
    color: rgba(244, 240, 227, 0.55); text-align: center; line-height: 1.1;
  }

  .mini-evalbar {
    width: 100%;
    flex: 1;
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: inset 0 2px 5px rgba(0,0,0,0.5);
  }

  .blackeval, .whiteeval { width: 100%; transition: all 0.4s ease; }
  .blackeval { background-color: #38412e; }
  .whiteeval { background-color: #626949; }

  .eval-col-num { font-family: "JetBrains Mono", monospace; font-size: 0.68rem; color: #f4f0e3; }

  .progress-line {
    margin-top: 0.6rem;
    font-size: 0.75rem;
    color: rgba(244, 240, 227, 0.55);
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    justify-content: center;
  }

  .dot-sep { opacity: 0.5; }

  .info-side { flex: 1 1 250px; display: flex; flex-direction: column; gap: 1.25rem; }

  .status-box {
    padding: 1.25rem 1.5rem;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid rgba(255, 255, 255, 0.08);
    text-align: center;
    font-weight: 600;
    font-size: 1.05rem;
    color: #f4f0e3;
    min-height: 80px;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    align-items: center;
    justify-content: center;
  }

  .status-box.correct { background: rgba(106, 209, 63, 0.15); border-color: #8fd97a; color: #a8d97a; }
  .status-box.wrong { background: rgba(255, 100, 90, 0.15); border-color: #ff8a80; color: #ffb0a8; }
  .status-box.revealed { background: rgba(244, 200, 100, 0.12); border-color: var(--text-highlight); color: #f4f0e3; }

  .mistake-tag {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    border: 1px solid;
    border-radius: 999px;
    padding: 0.15rem 0.6rem;
  }

  .puzzle-meta {
    display: flex; justify-content: space-between; align-items: center;
    background: rgba(0,0,0,0.2); padding: 0.75rem 1rem; border-radius: 8px;
  }

  .meta-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(244, 240, 227, 0.6); }
  .meta-value { font-family: "JetBrains Mono", monospace; font-weight: 700; color: var(--text-highlight); text-transform: capitalize; }
  .meta-value.played-move { color: #ffb0a8; }
  .meta-value.best-move { color: #a8d97a; }

  .action-buttons { display: flex; flex-direction: column; gap: 0.75rem; margin-top: auto; }

  .action-btn {
    padding: 0.75rem 1rem; border-radius: 8px; border: none; font-weight: 600;
    font-size: 0.95rem; cursor: pointer; transition: all 0.2s ease; color: #f4f0e3;
  }

  .hint-btn { background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.1); }
  .next-btn { background: var(--btn-active); }
  .action-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }

  .key-hint { font-size: 0.72rem; color: rgba(244, 240, 227, 0.4); text-align: center; margin: 0; }
  .key-hint kbd {
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
    border-radius: 4px; padding: 0.05rem 0.35rem; font-family: "JetBrains Mono", monospace;
  }
</style>